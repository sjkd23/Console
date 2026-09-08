import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, mock } from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField, type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type Message } from 'discord.js';
import { z } from 'zod';
import { ConfigInputSchema, TicketConfigSchema, TicketSchema, ticketChannelName, type ConfigInput, type Ticket, type TicketConfig } from './contract.js';
import type { EmbedActor } from '../embeds/contract.js';
import { customId } from '../embeds/ui.js';

const guildId = '100000000000000001', userId = '100000000000000002', botId = '100000000000000003';
const panelId = '100000000000000004', categoryId = '100000000000000005', logsId = '100000000000000006', roleId = '100000000000000007', otherUser = '100000000000000008';
const now = () => new Date().toISOString();
let counter = 100n, authorized = true, permitted = true, failChannel = false, failThread = false, failOpening = false, failSend = false, failDelete = false, failPublication = false, lostOpen = false, failEnqueue = false;
const events: string[] = [], sent: Record<string, unknown>[] = [], replies: Record<string, unknown>[] = [], modals: unknown[] = [];
const configs = new Map<string, TicketConfig>(), tickets = new Map<string, Ticket>();
const outbox = new Map<string, { event_key: string; chunks: string[]; delivered: number }[]>();
const clone = <T>(v: T): T => structuredClone(v);
const actor: EmbedActor = { actor_user_id: userId, actor_roles: [roleId], actor_has_admin_permission: false };
function newConfig(): TicketConfig {
    const c = TicketConfigSchema.parse({ id: randomUUID(), guild_id: guildId, name: 'Organizer Application', panel_channel_id: panelId, category_id: categoryId,
        panel_embed: { title: 'Apply', fields: [] }, opening_embed: { title: 'Questions', fields: [{ name: 'Experience', value: 'Tell us', inline: false }] },
        staff_role_ids: [roleId], enabled: true, published_channel_id: null, panel_message_id: null, created_by: userId, created_at: now(), updated_at: now(), revision: 1 });
    configs.set(c.id, clone(c)); return c;
}
function config(guild: string, id: string, revision?: number): TicketConfig {
    const c = configs.get(id); if (!c || c.guild_id !== guild) throw new Error('Wrong server or missing config');
    if (revision !== undefined && revision !== c.revision) throw new Error('Revision conflict'); return clone(c);
}
function ticket(guild: string, id: string): Ticket {
    const t = tickets.get(id); if (!t || t.guild_id !== guild) throw new Error('Wrong server or missing ticket'); return clone(t);
}
function freshTicket(c: TicketConfig, user: string, operation: string): Ticket {
    return TicketSchema.parse({ id: randomUUID(), guild_id: guildId, ticket_config_id: c.id, user_id: user, type_name: c.name, staff_role_ids: c.staff_role_ids,
        status: 'creating', channel_id: null, log_channel_id: null, log_message_id: null, thread_id: null, opening_message_id: null,
        operation_id: operation, lease_until: new Date(Date.now() + 300000).toISOString(), created_at: now(), updated_at: now(), opened_at: null, closed_at: null, closed_by: null });
}
const Api = {
    getConfig: async (g: string, _a: EmbedActor, id: string) => config(g, id),
    listConfigs: async (g: string, _a: EmbedActor, search = '') => ({ configs: [...configs.values()].filter(c => c.guild_id === g && c.name.toLowerCase().startsWith(search.toLowerCase())), has_more: false }),
    saveConfig: async (g: string, _a: EmbedActor, input: ConfigInput, _resources: unknown, id?: string, revision?: number) => {
        const c = id ? config(g, id, revision) : newConfig(); Object.assign(c, ConfigInputSchema.parse(input)); c.revision++; configs.set(c.id, clone(c)); events.push('save-config'); return c;
    },
    manageConfig: async (g: string, _a: EmbedActor, id: string, revision: number, action: string, channel?: string, message?: string) => {
        const c = config(g, id, revision); c.revision++;
        if (action === 'disable') c.enabled = false;
        if (action === 'publication') { if (failPublication) throw new Error('DB unavailable'); c.published_channel_id = channel ?? null; c.panel_message_id = message ?? null; events.push('track-panel'); }
        configs.set(id, clone(c)); return c;
    },
    reserve: async (g: string, a: EmbedActor, id: string, operation: string) => {
        const c = config(g, id); if (!c.enabled) throw new Error('This ticket panel is no longer active.');
        const existing = [...tickets.values()].find(t => t.guild_id === g && t.ticket_config_id === id && t.user_id === a.actor_user_id && ['creating','open','closing'].includes(t.status));
        if (existing) return { won: false, ticket: clone(existing), config: c };
        const t = freshTicket(c, a.actor_user_id, operation); tickets.set(t.id, clone(t)); events.push('reserve'); return { won: true, ticket: t, config: c };
    },
    getTicket: async (g: string, _a: EmbedActor, id: string) => ticket(g, id),
    checkpoint: async (g: string, _a: EmbedActor, id: string, operation: string, patch: Record<string, unknown>) => {
        const t = ticket(g, id); if (t.operation_id !== operation || !['creating','closing'].includes(t.status)) throw new Error('Fence conflict');
        Object.assign(t, patch); if (patch.status === 'open') t.opened_at = now();
        tickets.set(id, clone(t)); events.push(`checkpoint:${String(patch.status ?? Object.keys(patch)[0])}`);
        if (lostOpen && patch.status === 'open') throw new Error('Lost response'); return t;
    },
    close: async (g: string, a: EmbedActor, id: string, operation: string, recovery = false) => {
        const t = ticket(g, id); if (t.status !== 'open' && !(recovery && ['creating','closing'].includes(t.status) && Date.parse(t.lease_until!) < Date.now())) throw new Error('Already closing or creating');
        t.status = 'closing'; t.closed_by ??= recovery ? null : a.actor_user_id; t.closed_at ??= now(); t.operation_id = operation; tickets.set(id, clone(t)); events.push('closing'); return t;
    },
    active: async (g: string) => ({ tickets: [...tickets.values()].filter(t => t.guild_id === g && ['creating','open','closing'].includes(t.status)).map(clone), next: null }),
    request: async (_g: string, _a: EmbedActor, action: string, payload: Record<string, unknown>) => {
        const id = z.string().parse(payload.id), entries = outbox.get(id) ?? []; outbox.set(id, entries);
        if (action === 'enqueue' && failEnqueue) throw new Error('Backend outage');
        if (action === 'pending') return { events: clone(entries.filter(e => e.delivered < e.chunks.length)) };
        const e = z.object({ event_key: z.string(), chunks: z.array(z.string()), delivered: z.number() }).parse(payload.event);
        if (action === 'enqueue' && !entries.some(x => x.event_key === e.event_key)) entries.push(clone(e));
        if (action === 'ack') { const found = entries.find(x => x.event_key === e.event_key)!; found.delivered = e.delivered; }
        return { ok: true };
    },
};
mock.module('./api.js', { namedExports: Api });
mock.module('../embeds/builder.js', { namedExports: {
    embedActor: async () => { if (!authorized) throw new Error('Moderator required'); return actor; },
    embedError: (e: unknown) => e instanceof Error ? e.message : 'Discord operation failed',
} });
mock.module('../permissions/permissions.js', { namedExports: { getMemberRoleIds: (m: { id: string }) => m.id === otherUser ? [] : [roleId], hasRequiredRoleOrHigher: async () => ({ hasRole: authorized }) } });
mock.module('../utilities/http.js', { namedExports: {
    BackendError: class extends Error {}, postJSON: async () => undefined,
    getGuildChannels: async () => ({ channels: { bot_log: logsId } }),
} });
const channels = new Map<string, ReturnType<typeof fakeChannel>>();
const messages = new Map<string, ReturnType<typeof fakeMessage>>();
function fakeMessage(id: string, destination: string) {
    const m = { id, guildId, channelId: destination, author: { id: botId }, url: `https://discord.com/channels/${guildId}/${destination}/${id}`,
        edit: async (p: Record<string, unknown>) => { sent.push(p); events.push(`edit:${id}`); return m; },
        delete: async () => { if (failDelete) throw { code: 50013 }; messages.delete(id); events.push(`delete-message:${id}`); return m; },
        startThread: async () => { if (failThread) throw { code: 50013 }; const thread = fakeChannel(id, ChannelType.PublicThread); thread.parentId = logsId; channels.set(id, thread); events.push('thread'); return thread; },
    }; return m;
}
function fakeChannel(id: string, type: ChannelType) {
    const c = { id, type, guildId, name: 'ticket', topic: '', parentId: '', archived: false, locked: false,
        permissionsFor: () => ({ has: () => permitted }),
        permissionOverwrites: { cache: new Collection<string, { id: string; type: 0 | 1; allow: PermissionsBitField; deny: PermissionsBitField }>(), set: async (_v: unknown) => { events.push('freeze'); } },
        messages: { fetch: async (value: unknown) => {
            if (typeof value === 'object' && value && 'limit' in value) return new Collection<string, Message>();
            const key = typeof value === 'string' ? value : z.object({ message: z.string() }).parse(value).message;
            const m = messages.get(key); if (!m) throw { code: 10008 }; return m;
        } },
        send: async (p: Record<string, unknown>) => {
            if (failSend || (failOpening && type === ChannelType.GuildText && id !== panelId && id !== logsId)) throw { code: 50013 };
            sent.push(p); events.push(type === ChannelType.PublicThread ? 'transcript-send' : id === logsId ? 'root' : id === panelId ? 'panel-send' : 'opening');
            const m = fakeMessage(String(100000000000000000n + counter++), id); messages.set(m.id, m); return m;
        },
        delete: async () => { if (failDelete) throw { code: 50013 }; channels.delete(id); events.push('delete-channel'); return c; },
        setArchived: async (value: boolean) => { c.archived = value; events.push(value ? 'archive' : 'unarchive'); return c; },
        setLocked: async (value: boolean) => { c.locked = value; events.push(value ? 'lock' : 'unlock'); return c; },
    }; return c;
}
let channelOptions: Record<string, unknown>[] = [];
const guildObject = {
    id: guildId, client: { user: { id: botId } },
    members: { fetchMe: async () => ({ id: botId }), fetch: async (id: string) => ({ id, user: { username: 'sjkd' }, permissions: { has: () => false } }) },
    roles: { fetch: async (id: string) => id === roleId ? { id, guild: { id: guildId } } : null },
    channels: {
        fetch: async (id?: string) => id ? channels.get(id) ?? null : new Collection(channels),
        create: async (p: Record<string, unknown>) => { if (failChannel) throw { code: 50013 }; channelOptions.push(p); const c = fakeChannel(String(100000000000000000n + counter++), ChannelType.GuildText); c.name = z.string().parse(p.name); c.topic = z.string().parse(p.topic); channels.set(c.id, c); events.push('channel'); return c; },
    },
};
const guild = guildObject as unknown as Guild;
function interaction(id: string, user = userId, destination = panelId) {
    const i = { customId: id, guild, guildId, channelId: destination, user: { id: user, username: 'Sjkd__' }, deferred: false, replied: false,
        deferReply: async (_p: unknown) => { i.deferred = true; events.push('defer'); }, deferUpdate: async () => { i.deferred = true; },
        reply: async (p: Record<string, unknown>) => { i.replied = true; replies.push(p); }, followUp: async (p: Record<string, unknown>) => { replies.push(p); },
        editReply: async (p: string | Record<string, unknown>) => { replies.push(typeof p === 'string' ? { content: p } : p); return { id: 'builder' }; },
        update: async (p: Record<string, unknown>) => { replies.push(p); },
    }; return i;
}
const { createTicket, handleTicketButton, recoverTicket, routeTicketMessage, restoreTicketRouting } = await import('./lifecycle.js');
const { activeChannels, messageEvent, splitTranscript, flushTranscript } = await import('./transcript.js');
const { ticketSessions, openTicketBuilder, handleTicketBuilder, ticketBuilderMessage } = await import('./builder.js');
const { savePanel, publishPanel, disablePanel } = await import('./publication.js');
const commands = await import('../../commands/configs/tickets.js');
const open = async (c = newConfig(), user = userId) => {
    await createTicket(interaction(`ticket:create:${c.id}`, user) as unknown as ButtonInteraction, c.id);
    return [...tickets.values()].find(t => t.ticket_config_id === c.id && t.user_id === user && t.status === 'open')!;
};
const press = async (id: string, user: string, destination: string) => handleTicketButton(interaction(id, user, destination) as unknown as ButtonInteraction);
async function closeConfirmed(t: Ticket, user = userId) {
    await press(`ticket:close:${t.id}`, user, t.channel_id!);
    const p = replies.at(-1)!;
    const row = p.components as { toJSON(): { components: { custom_id: string }[] } }[];
    await press(row[0].toJSON().components[0].custom_id, user, t.channel_id!);
}
beforeEach(() => {
    configs.clear(); tickets.clear(); channels.clear(); messages.clear(); outbox.clear(); activeChannels.clear(); ticketSessions.clear();
    events.length = sent.length = replies.length = modals.length = 0; channelOptions = [];
    authorized = permitted = true; failChannel = failThread = failOpening = failSend = failDelete = failPublication = lostOpen = failEnqueue = false;
    for (const [id, type] of [[panelId, ChannelType.GuildText], [logsId, ChannelType.GuildText], [categoryId, ChannelType.GuildCategory]] as const) channels.set(id, fakeChannel(id, type));
});
describe('real ticket creation and close orchestration with Discord/API boundaries', () => {
    it('reserves before channel, creates root/thread/opening and commits open before ephemeral success', async () => {
        const t = await open(); assert.equal(t.status, 'open'); assert.ok(t.log_message_id && t.thread_id && t.opening_message_id);
        for (const [a, b] of [['reserve','channel'],['channel','root'],['root','thread'],['thread','opening'],['opening','checkpoint:open']]) assert.ok(events.indexOf(a) < events.indexOf(b));
        assert.match(String(replies.at(-1)!.content), new RegExp(t.channel_id!)); assert.ok(events.includes('defer'));
        const opening = sent.find(p => p.content === `Ticket opened by <@${userId}>`)!; assert.ok(opening.embeds); assert.equal((opening.components as { toJSON(): { components: { custom_id: string }[] } }[])[0].toJSON().components[0].custom_id, `ticket:close:${t.id}`);
    });
    it('private channel uses username, denies everyone and grants creator, bot and configured staff', async () => {
        await open(); const p = channelOptions[0]; assert.equal(p.name, 'sjkd-organizer-application'); assert.equal(p.parent, categoryId);
        const overwrites = p.permissionOverwrites as { id: string; allow?: bigint[]; deny?: bigint[] }[];
        assert.deepEqual(overwrites.find(o => o.id === guildId)!.deny, [P.ViewChannel]);
        for (const id of [userId, botId, roleId]) { const o = overwrites.find(o => o.id === id)!; assert.ok(o.allow!.includes(P.ViewChannel)); assert.ok(o.allow!.includes(P.AttachFiles)); }
    });
    it('two simultaneous clicks create exactly one channel and one open instance', async () => { const c = newConfig(); await Promise.all([open(c), open(c)]); assert.equal(channelOptions.length, 1); assert.equal(tickets.size, 1); assert.ok(replies.some(r => /being created/.test(String(r.content)))); });
    it('same user may open other types; other users can open the same type', async () => { const a = newConfig(), b = newConfig(); await open(a); await open(b); await open(a, otherUser); assert.equal(channelOptions.length, 3); });
    it('existing ticket mentions the actual channel without creating another', async () => { const c = newConfig(), t = await open(c); await open(c); assert.equal(channelOptions.length, 1); assert.match(String(replies.at(-1)!.content), new RegExp(`already have.*${t.channel_id}`)); });
    it('channel failure releases reservation', async () => { const c = newConfig(); failChannel = true; await assert.rejects(() => open(c)); assert.equal([...tickets.values()][0].status, 'failed'); failChannel = false; assert.equal((await open(c)).status, 'open'); });
    it('thread failure compensates the channel and allows retry', async () => { const c = newConfig(); failThread = true; await assert.rejects(() => open(c)); assert.ok(events.includes('delete-channel')); assert.equal([...tickets.values()][0].status, 'failed'); failThread = false; await open(c); });
    it('opening failure retains transcript history and removes unusable channel', async () => { failOpening = true; await assert.rejects(() => open()); const t = [...tickets.values()][0]; assert.equal(t.status, 'failed'); assert.ok(t.thread_id); assert.ok(events.includes('archive')); assert.ok(!channels.has(t.channel_id!)); });
    it('missing category fails before creating any channel', async () => { channels.delete(categoryId); await assert.rejects(() => open()); assert.equal(channelOptions.length, 0); });
    it('missing logs or insufficient permissions fails before creating a channel', async () => { channels.delete(logsId); await assert.rejects(() => open()); assert.equal(channelOptions.length, 0); });
    it('insufficient bot category permissions fails before channel creation', async () => { permitted = false; await assert.rejects(() => open()); assert.equal(channelOptions.length, 0); });
    it('cross-guild custom ID cannot reserve or create a channel', async () => { const c = newConfig(); c.guild_id = otherUser; configs.set(c.id, c); await press(`ticket:create:${c.id}`, userId, panelId); assert.equal(tickets.size, 0); assert.equal(channelOptions.length, 0); });
    it('rejects unusable staff roles', async () => { const c = newConfig(); c.staff_role_ids = [otherUser]; configs.set(c.id, c); await assert.rejects(() => open(c)); assert.equal(channelOptions.length, 0); });
    it('lost open commit response is recovered without destroying the ticket', async () => { lostOpen = true; const t = await open(); assert.equal(t.status, 'open'); assert.ok(channels.has(t.channel_id!)); assert.ok(!events.includes('delete-channel')); });
    it('close requires confirmation; cancel keeps the ticket open', async () => {
        const t = await open(); await press(`ticket:close:${t.id}`, userId, t.channel_id!); assert.equal(tickets.get(t.id)!.status, 'open');
        const rows = replies.at(-1)!.components as { toJSON(): { components: { custom_id: string }[] } }[];
        await press(rows[0].toJSON().components[1].custom_id, userId, t.channel_id!); assert.equal(tickets.get(t.id)!.status, 'open');
    });
    it('confirmed close records attribution, finalizes transcript before deletion, preserves history and permits replacement', async () => {
        const c = newConfig(), t = await open(c); await closeConfirmed(t);
        const closed = tickets.get(t.id)!; assert.equal(closed.status, 'closed'); assert.equal(closed.closed_by, userId); assert.ok(closed.closed_at);
        assert.ok(events.indexOf('archive') < events.indexOf('delete-channel')); assert.ok(events.indexOf('closing') < events.indexOf('freeze'));
        assert.ok(messages.has(t.log_message_id!)); assert.ok(outbox.get(t.id)!.some(e => e.event_key === 'closed')); assert.ok(!activeChannels.has(t.channel_id!)); await open(c);
    });
    it('unrelated user cannot request closure', async () => { const t = await open(); authorized = false; await press(`ticket:close:${t.id}`, otherUser, t.channel_id!); assert.match(String(replies.at(-1)!.content), /Only the creator/); assert.equal(tickets.get(t.id)!.status, 'open'); });
    it('close button cannot target another channel', async () => { const t = await open(); await press(`ticket:close:${t.id}`, userId, panelId); assert.match(String(replies.at(-1)!.content), /inside the ticket channel/); assert.equal(tickets.get(t.id)!.status, 'open'); });
    it('creator can close without moderator authorization', async () => { const t = await open(); authorized = false; await closeConfirmed(t); assert.equal(tickets.get(t.id)!.status, 'closed'); });
    it('configured staff can close another user ticket', async () => { const t = await open(newConfig(), otherUser); authorized = false; await closeConfirmed(t, userId); assert.equal(tickets.get(t.id)!.status, 'closed'); });
    it('double confirmation cannot repeat channel deletion', async () => {
        const t = await open(); await press(`ticket:close:${t.id}`, userId, t.channel_id!);
        const rows = replies.at(-1)!.components as { toJSON(): { components: { custom_id: string }[] } }[]; const id = rows[0].toJSON().components[0].custom_id;
        await Promise.all([press(id, userId, t.channel_id!), press(id, userId, t.channel_id!)]); assert.equal(events.filter(x => x === 'delete-channel').length, 1);
    });
    it('failed channel deletion retains closing state and recovers after lease expiry', async () => {
        const t = await open(); failDelete = true; await closeConfirmed(t); assert.equal(tickets.get(t.id)!.status, 'closing'); assert.ok(channels.has(t.channel_id!));
        failDelete = false; const closing = tickets.get(t.id)!; closing.lease_until = '2020-01-01T00:00:00.000Z'; await recoverTicket(guild, clone(closing)); assert.equal(tickets.get(t.id)!.status, 'closed');
    });
    it('stale missing channel is reconciled and a replacement opens', async () => { const c = newConfig(), t = await open(c); channels.delete(t.channel_id!); const replacement = await open(c); assert.notEqual(replacement.id, t.id); assert.equal(tickets.get(t.id)!.status, 'stale'); assert.ok(outbox.get(t.id)!.some(e => e.event_key === 'closed')); });
    it('expired creation with uncheckpointed channel is adopted by topic and cleaned', async () => {
        const c = newConfig(), t = freshTicket(c, userId, randomUUID()); t.lease_until = '2020-01-01T00:00:00.000Z'; tickets.set(t.id, clone(t));
        const orphan = fakeChannel('100000000000000999', ChannelType.GuildText); orphan.topic = `console-ticket:${t.id}`; channels.set(orphan.id, orphan);
        await recoverTicket(guild, t); assert.equal(tickets.get(t.id)!.status, 'failed'); assert.ok(!channels.has(orphan.id));
    });
    it('restart rebuilds active channel routing from persistence', async () => { const t = await open(); activeChannels.clear(); await restoreTicketRouting(guild); assert.equal(activeChannels.get(t.channel_id!)!.id, t.id); });
    it('disabled panel rejects new tickets while existing tickets remain closable', async () => { const c = newConfig(), t = await open(c); await disablePanel(guild, actor, c); await assert.rejects(() => open(c), /no longer active/); await closeConfirmed(t); assert.equal(tickets.get(t.id)!.status, 'closed'); });
});

describe('ticket panel canonical publication', () => {
    const input = (c: TicketConfig) => ({ name: c.name, panel_channel_id: c.panel_channel_id, category_id: c.category_id, panel_embed: c.panel_embed, opening_embed: c.opening_embed, staff_role_ids: c.staff_role_ids });
    it('publishes panel embed and persistent Create Ticket button, tracking both IDs', async () => { const c = newConfig(), result = await publishPanel(guild, actor, c); assert.ok(result.config.panel_message_id); assert.equal(result.config.published_channel_id, panelId); const payload = sent[0]; assert.equal((payload.components as { toJSON(): { components: { custom_id: string }[] } }[])[0].toJSON().components[0].custom_id, `ticket:create:${c.id}`); });
    it('save edits the same canonical message and repeated publish sends no duplicate', async () => { let c = (await publishPanel(guild, actor, newConfig())).config; const id = c.panel_message_id; c = (await savePanel(guild, actor, { ...input(c), panel_embed: { title: 'Changed', fields: [] } }, c)).config; await publishPanel(guild, actor, c); assert.equal(c.panel_message_id, id); assert.equal(events.filter(e => e === 'panel-send').length, 1); assert.ok(events.includes(`edit:${id}`)); });
    it('missing panel on save clears tracking without sending another; explicit publish restores it', async () => { let c = (await publishPanel(guild, actor, newConfig())).config; messages.delete(c.panel_message_id!); const result = await savePanel(guild, actor, input(c), c); c = result.config; assert.equal(c.panel_message_id, null); assert.match(result.notice, /missing/); assert.equal(events.filter(e => e === 'panel-send').length, 1); c = (await publishPanel(guild, actor, c)).config; assert.ok(c.panel_message_id); });
    it('moving creates and tracks replacement before deleting old panel', async () => { let c = (await publishPanel(guild, actor, newConfig())).config; const old = c.panel_message_id!; c = (await savePanel(guild, actor, { ...input(c), panel_channel_id: logsId }, c)).config; events.length = 0; c = (await publishPanel(guild, actor, c)).config; assert.equal(c.published_channel_id, logsId); assert.ok(events.indexOf('root') < events.indexOf('track-panel')); assert.ok(events.indexOf('track-panel') < events.indexOf(`delete-message:${old}`)); });
    it('stale revision does not touch Discord', async () => { const c = newConfig(); await publishPanel(guild, actor, c); events.length = 0; await assert.rejects(() => publishPanel(guild, actor, c), /Revision/); assert.equal(events.length, 0); });
    it('failed publication persistence removes replacement and retains prior tracking', async () => { const c = newConfig(); failPublication = true; const r = await publishPanel(guild, actor, c); assert.match(r.notice, /could not finish/); assert.equal(configs.get(c.id)!.panel_message_id, null); assert.equal(messages.size, 0); });
    it('disable removes canonical message while retaining config', async () => { const c = (await publishPanel(guild, actor, newConfig())).config; const result = await disablePanel(guild, actor, c); assert.equal(result.config.enabled, false); assert.ok(configs.has(c.id)); assert.ok(!messages.has(c.panel_message_id!)); });
    it('disable tolerates already-deleted panel', async () => { const c = (await publishPanel(guild, actor, newConfig())).config; messages.delete(c.panel_message_id!); assert.equal((await disablePanel(guild, actor, c)).config.panel_message_id, null); });
});

describe('shared builder and transcript behavior', () => {
    function builderInteraction(s: Parameters<typeof ticketBuilderMessage>[0], action: string, kind = 'button', value?: string, inputs: Record<string, string> = {}) {
        return { ...interaction(customId(s, action)), message: { id: 'builder' }, values: value ? [value] : [],
            isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal', isFromMessage: () => true, isChannelSelectMenu: () => kind === 'channel', isRoleSelectMenu: () => kind === 'role', isStringSelectMenu: () => kind === 'select',
            fields: { getTextInputValue: (id: string) => inputs[id] ?? '' }, showModal: async (modal: unknown) => { modals.push(modal); } };
    }
    async function builder() { await openTicketBuilder(interaction('') as unknown as ChatInputCommandInteraction); return [...ticketSessions.values()][0]; }
    const act = async (s: Parameters<typeof ticketBuilderMessage>[0], action: string, kind = 'button', value?: string, inputs?: Record<string, string>) => handleTicketBuilder(builderInteraction(s, action, kind, value, inputs) as unknown as ButtonInteraction);
    it('all four commands require moderator and create opens a builder without slash properties', async () => { for (const c of Object.values(commands)) assert.equal(c.requiredRole, 'moderator'); assert.equal(commands.createticket.data.toJSON().options?.length ?? 0, 0); assert.ok(await builder()); });
    it('unauthorized staff cannot open or operate builder', async () => { authorized = false; await builder(); assert.equal(ticketSessions.size, 0); });
    it('revoked moderator permission prevents subsequent builder mutations', async () => { const s = await builder(); authorized = false; await act(s, 'modal-name', 'modal', undefined, { name: 'Unauthorized change' }); assert.equal(s.draft.name, undefined); });
    it('builder ownership and revision reject foreign and stale components', async () => { const s = await builder(); const old = builderInteraction(s, 'panel'); await act(s, 'opening'); await handleTicketBuilder(old as unknown as ButtonInteraction); assert.equal(s.view, 'opening'); const foreign = builderInteraction(s, 'panel'); foreign.user.id = otherUser; await handleTicketBuilder(foreign as unknown as ButtonInteraction); assert.equal(s.view, 'opening'); });
    it('native channel/category/role selections and purpose persist in draft metadata', async () => { const s = await builder(); await act(s, 'panel-channel', 'channel', panelId); await act(s, 'category', 'channel', categoryId); await act(s, 'roles', 'role', roleId); await act(s, 'modal-name', 'modal', undefined, { name: 'Support' }); assert.equal(s.draft.name, 'Support'); assert.equal(s.draft.category_id, categoryId); assert.deepEqual(s.draft.staff_role_ids, [roleId]); assert.match(ticketBuilderMessage(s).content, /Support/); });
    it('both embeds use shared modal edits and remain independent', async () => { const s = await builder(); await act(s, 'panel'); await act(s, 'modal-Title', 'modal', undefined, { title: 'Panel title' }); await act(s, 'opening'); await act(s, 'modal-Title', 'modal', undefined, { title: 'Opening title' }); assert.equal(s.draft.panel_embed.title, 'Panel title'); assert.equal(s.draft.opening_embed.title, 'Opening title'); assert.equal(ticketBuilderMessage(s).embeds[0].title, 'Opening title'); });
    it('shared field add/edit/inline/order/remove works in opening editor', async () => { const s = await builder(); await act(s, 'opening'); await act(s, 'modal-add-field', 'modal', undefined, { name: 'A', value: 'First' }); await act(s, 'modal-add-field', 'modal', undefined, { name: 'B', value: 'Second' }); await act(s, 'inline'); await act(s, 'up'); assert.equal(s.draft.opening_embed.fields[0].name, 'B'); assert.equal(s.draft.opening_embed.fields[0].inline, true); await act(s, 'remove-field'); assert.equal(s.draft.opening_embed.fields.length, 1); });
    it('invalid embed edits do not mutate draft, using shared limits', async () => { const s = await builder(); await act(s, 'panel'); const previous = clone(s.draft.panel_embed); await act(s, 'modal-Title', 'modal', undefined, { title: 'x'.repeat(257) }); assert.deepEqual(s.draft.panel_embed, previous); });
    it('preview Create and Close buttons are disabled and never production-routed', async () => { const s = await builder(); for (const view of ['panel','opening']) { await act(s, view); const rows = ticketBuilderMessage(s).components; const row = rows.at(-1)!.toJSON(); const button = row.components[0]; assert.ok('disabled' in button && button.disabled); assert.ok('custom_id' in button && button.custom_id.startsWith('tkb:')); assert.ok(rows.length <= 5); } });
    it('builder Save and explicit Publish create canonical panel; edit restores templates', async () => { const s = await builder(); await act(s, 'modal-name', 'modal', undefined, { name: 'Support' }); await act(s, 'panel-channel', 'channel', panelId); await act(s, 'category', 'channel', categoryId); await act(s, 'save-ticket'); assert.ok(s.ticketConfig); await act(s, 'publish-ticket'); assert.ok(s.ticketConfig!.panel_message_id); await openTicketBuilder(interaction('') as unknown as ChatInputCommandInteraction, s.ticketConfig!.id); assert.equal([...ticketSessions.values()].at(-1)!.draft.name, 'Support'); });
    it('deletion requires builder confirmation', async () => { const c = newConfig(); await openTicketBuilder(interaction('') as unknown as ChatInputCommandInteraction, c.id, true); assert.equal(configs.get(c.id)!.enabled, true); const s = [...ticketSessions.values()][0]; await act(s, 'delete-confirm'); assert.equal(configs.get(c.id)!.enabled, false); });
    it('contract parity and sanitization', () => { assert.equal(readFileSync(new URL('./contract.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../../../backend/src/lib/tickets/contract.ts', import.meta.url), 'utf8')); assert.equal(ticketChannelName('Cool__User!!','Sécürity  Application'), 'cool-user-security-application'); assert.ok(ticketChannelName('x'.repeat(100), 'y'.repeat(100)).length <= 100); });
    it('long transcripts split without dropping content or breaking surrogate pairs', () => { const body = 'Hello @everyone 😀'.repeat(600), parts = splitTranscript('context', body); assert.ok(parts.every(p => p.length <= 2000)); assert.equal(parts.map(p => p.slice('context\n'.length)).join(''), body); });
    function message(t: Ticket, content: string, partial = false): Message {
        return { id: '100000000000000888', channelId: t.channel_id, guild, client: guild.client, author: { id: userId, username: 'sjkd' }, createdAt: new Date('2026-09-07T00:00:00Z'), editedAt: new Date(), editedTimestamp: 123,
            partial, content, embeds: [], attachments: new Collection([['a', { name: 'proof.png', size: 42, contentType: 'image/png', url: 'https://example.com/proof.png' }]]) } as unknown as Message;
    }
    it('user/staff messages include author, timestamp, attachments and suppress mentions', async () => { const t = await open(); await routeTicketMessage(message(t, '@everyone hi'), 'message'); const entry = outbox.get(t.id)!.find(e => e.event_key.startsWith('message:'))!; assert.match(entry.chunks[0], /sjkd.*100000000000000002/); assert.match(entry.chunks[0], /2026-09-07/); assert.match(entry.chunks[0], /proof.png/); assert.ok(sent.filter(p => typeof p.content === 'string' && p.content.includes('@everyone')).every(p => JSON.stringify(p.allowedMentions).includes('"parse":[]'))); });
    it('edits append before/after and deletes append cached content', async () => { const t = await open(); await routeTicketMessage(message(t, 'After'), 'edit', message(t, 'Before')); await routeTicketMessage(message(t, 'Deleted'), 'delete'); const entries = outbox.get(t.id)!; assert.match(entries.find(e => e.event_key.startsWith('edit:'))!.chunks[0], /Before: Before\nAfter: After/); assert.match(entries.find(e => e.event_key.startsWith('delete:'))!.chunks[0], /Deleted/); });
    it('uncached deletes explicitly state content unavailable', async () => { const t = await open(); const e = messageEvent(message(t, '', true), 'delete'); assert.match(e.chunks[0], /content unavailable/); assert.match(e.chunks[0], /100000000000000888/); });
    it('transcript send failure leaves durable pending chunks for retry', async () => { const t = await open(); failSend = true; await assert.rejects(() => routeTicketMessage(message(t, 'Pending'), 'message')); const pending = outbox.get(t.id)!.find(e => e.event_key.startsWith('message:'))!; assert.equal(pending.delivered, 0); failSend = false; await flushTranscript(guild, t); assert.equal(pending.delivered, pending.chunks.length); });
    it('backend enqueue outage retains edit events and retries before finalization', async () => { const t = await open(); failEnqueue = true; await assert.rejects(() => routeTicketMessage(message(t, 'After outage'), 'edit', message(t, 'Before outage'))); failEnqueue = false; await flushTranscript(guild, t); const entry = outbox.get(t.id)!.find(e => e.event_key.startsWith('edit:'))!; assert.match(entry.chunks[0], /After outage/); assert.equal(entry.delivered, entry.chunks.length); });
    it('unrelated guild channel messages do not query the backend', async () => { const t = await open(); const m = message({ ...t, channel_id: panelId }, 'ignored'); const before = outbox.size; await routeTicketMessage(m, 'message'); assert.equal(outbox.size, before); });
});

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { ChannelType, type ButtonInteraction, type ChatInputCommandInteraction, type Guild } from 'discord.js';
import type { EmbedActor, EmbedConfig, EmbedPublication, SavedEmbed } from './contract.js';
import { createSession, sessions, type EmbedSession } from './session.js';
import { customId } from './ui.js';
import { renderEmbed } from './render.js';

let messageEditFails = false, publicationFails = false, fetchDenied = false, oldDeleteFails = false;
let lostPublicationResponse = false, readFails = false, editDeleted = false, cleanupFails = false;
let messageCounter = 100;
const messageEdits: unknown[] = [], events: string[] = [];
let pauseEdit: (() => Promise<void>) | undefined;
let allowed = true, channelExists = true, channelPermission = true, sendFails = false, saveFails = false, editFails = false;
const sent: unknown[] = [], edits: unknown[] = [], replies: { content: string }[] = [], modals: unknown[] = [];
const stored = new Map<string, SavedEmbed>();
const guildId = '100000000000000001', ownerId = '100000000000000002', channelId = '100000000000000003';
const templateId = '123e4567-e89b-42d3-a456-426614174000';
function fakeMessage(id: string, destination: string) {
    const message = {
        id, guildId, channelId: destination, author: { id: 'bot' }, url: `https://discord.com/channels/${guildId}/${destination}/${id}`,
        edit: async (payload: unknown) => { if (pauseEdit) await pauseEdit(); if (editDeleted) { messages.delete(id); throw { code: 10008 }; } if (messageEditFails) throw { code: 50013 }; messageEdits.push(payload); events.push('edit'); return message; },
        delete: async () => { if (cleanupFails || (oldDeleteFails && destination === channelId)) throw { code: 50013 }; messages.delete(id); events.push(`delete:${id}`); return message; },
    };
    return message;
}
const messages = new Map<string, ReturnType<typeof fakeMessage>>();
const guild = {
    id: guildId, client: { user: { id: 'bot' } },
    members: { fetch: async () => ({ id: ownerId, permissions: { has: () => true } }), fetchMe: async () => ({ id: 'bot' }) },
    channels: { fetch: async (destination: string) => {
        if (fetchDenied) throw { code: 50001 };
        return channelExists ? {
            guildId, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => channelPermission }),
            messages: { fetch: async ({ message }: { message: string }) => { const found = messages.get(message); if (!found) throw { code: 10008 }; return found; } },
            send: async (payload: unknown) => {
                if (sendFails) throw new Error('discord'); sent.push(payload);
                const message = fakeMessage(String(100000000000000000n + BigInt(messageCounter++)), destination);
                messages.set(message.id, message); events.push(`send:${message.id}`); return message;
            },
        } : null;
    } },
};
function currentRecord(guild: string, id: string, revision: number) {
    const current = stored.get(id);
    if (!current || current.guild_id !== guild || current.revision !== revision) throw new Error('This saved embed changed. Reopen it.');
    return structuredClone(current);
}
mock.module('../permissions/permissions.js', { namedExports: {
    getMemberRoleIds: () => [], hasRequiredRoleOrHigher: async () => ({ hasRole: allowed }),
} });
mock.module('../utilities/http.js', { namedExports: { BackendError: class extends Error { } } });
mock.module('./api.js', { namedExports: {
    getSavedEmbed: async (guild: string, id: string) => {
        if (readFails) throw new Error('Backend read unavailable');
        const saved = stored.get(id); if (!saved || saved.guild_id !== guild) throw new Error('Saved embed no longer exists.'); return structuredClone(saved);
    },
    saveEmbed: async (guild: string, _actor: EmbedActor, config: EmbedConfig, target: { name: string } | { id: string; revision: number }) => {
        if (saveFails) throw new Error('Save failed.');
        const existing = 'id' in target ? currentRecord(guild, target.id, target.revision) : undefined;
        const saved: SavedEmbed = { id: templateId, guild_id: guild, name: 'name' in target ? target.name : existing!.name, config: structuredClone(config), created_by: ownerId,
            published_channel_id: existing?.published_channel_id ?? null, published_message_id: existing?.published_message_id ?? null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: (existing?.revision ?? 0) + 1 };
        stored.set(saved.id, structuredClone(saved)); return saved;
    },
    deleteSavedEmbed: async (guild: string, id: string, revision: number) => { currentRecord(guild, id, revision); stored.delete(id); events.push('delete-record'); },
    claimSavedEmbed: async (guild: string, id: string, revision: number) => {
        const next = currentRecord(guild, id, revision); next.revision++; stored.set(id, structuredClone(next)); return next;
    },
    setEmbedPublication: async (guild: string, id: string, revision: number, publication: EmbedPublication | null) => {
        if (publicationFails) throw new Error('Persistence failed');
        const next = currentRecord(guild, id, revision);
        next.published_channel_id = publication?.channel_id ?? null; next.published_message_id = publication?.message_id ?? null; next.revision++;
        stored.set(id, structuredClone(next)); events.push('track');
        if (lostPublicationResponse) throw new Error('Response lost after commit');
        return next;
    },
    listSavedEmbeds: async () => ({ embeds: [...stored.values()], has_more: false }),
} });
const { handleEmbedInteraction, openBuilder, publishEmbed } = await import('./builder.js');
const { createembed, editembed, listembeds, deleteembed } = await import('../../commands/configs/embeds.js');
const { saveManagedEmbed, deleteManagedEmbed } = await import('./publication.js');

function fixture(s: EmbedSession, action: string, kind = 'button', values: string[] = [], inputs: Record<string, string> = {}) {
    const raw = {
        customId: customId(s, action), guildId, guild, user: { id: ownerId }, message: { id: 'builder-message' }, values,
        deferred: false, replied: false,
        isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isChannelSelectMenu: () => kind === 'channel', isModalSubmit: () => kind === 'modal', isFromMessage: () => true,
        fields: { getTextInputValue: (id: string) => inputs[id] ?? '' },
        deferUpdate: async () => { raw.deferred = true; },
        reply: async (payload: { content: string }) => { raw.replied = true; replies.push(payload); },
        followUp: async (payload: { content: string }) => { replies.push(payload); },
        editReply: async (payload: unknown) => { if (editFails) throw new Error('Message update failed.'); edits.push(payload); return { id: 'builder-message' }; },
        showModal: async (payload: unknown) => { modals.push(payload); },
    };
    return raw;
}
async function act(s: EmbedSession, action: string, kind = 'button', values: string[] = [], inputs: Record<string, string> = {}) {
    const interaction = fixture(s, action, kind, values, inputs);
    await handleEmbedInteraction(interaction as unknown as ButtonInteraction);
    return interaction;
}
async function savedDraft() { const s = draft(); await act(s, 'modal-save', 'modal', [], { name: 'test' }); return s; }
function draft() { const s = createSession(guildId, ownerId); s.messageId = 'builder-message'; return s; }
beforeEach(() => { sessions.clear(); stored.clear(); messages.clear(); events.length = messageEdits.length = 0; pauseEdit = undefined; lostPublicationResponse = readFails = editDeleted = cleanupFails = false; messageEditFails = publicationFails = fetchDenied = oldDeleteFails = false; sent.length = edits.length = replies.length = modals.length = 0; allowed = channelExists = channelPermission = true; sendFails = saveFails = editFails = false; });

describe('embed command and editor interactions', () => {
    it('accepts and clears a 4000-character description and rejects 4001 in the editor', async () => {
        const s = draft(); s.config.title = 'Keep';
        await act(s, 'modal-Description', 'modal', [], { description: 'd'.repeat(4000) });
        assert.equal(s.config.description?.length, 4000);
        await act(s, 'modal-Description', 'modal', [], { description: 'd'.repeat(4001) });
        assert.equal(s.config.description?.length, 4000); assert.match(replies.at(-1)!.content, /4000/);
        await act(s, 'modal-Description', 'modal'); assert.equal(s.config.description, undefined);
    });
    it('requires saving a named template before canonical publication', async () => {
        const s = draft(); s.channelId = channelId; await act(s, 'publish');
        assert.equal(sent.length, 0); assert.match(replies.at(-1)!.content, /Save this embed with a name/);
    });
    it('tracks first publication and reopens it with the destination restored', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        assert.equal(sent.length, 1); assert.equal(s.saved?.published_channel_id, channelId);
        assert.ok(messages.has(s.saved!.published_message_id!));
        assert.equal(stored.get(templateId)!.published_message_id, s.saved!.published_message_id);
        await openBuilder({ guildId, guild, user: { id: ownerId }, deferReply: async () => undefined,
            editReply: async () => ({ id: 'builder-message' }) } as unknown as ChatInputCommandInteraction, templateId);
        const opened = [...sessions.values()].at(-1)!;
        assert.equal(opened.channelId, channelId); assert.equal(opened.saved?.published_message_id, s.saved?.published_message_id);
    });
    it('Save Changes persists then edits the exact tracked post and repeated Publish makes no copy', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const id = s.saved!.published_message_id;
        await act(s, 'modal-Title', 'modal', [], { title: 'New rules' }); await act(s, 'save');
        assert.equal(stored.get(templateId)!.config.title, 'New rules');
        assert.deepEqual(messageEdits, [{ embeds: [renderEmbed(s.config)], allowedMentions: { parse: [] } }]);
        assert.equal(s.saved!.published_message_id, id); assert.equal(sent.length, 1);
        await act(s, 'publish'); assert.equal(sent.length, 1); assert.match(s.notice!, /Already published/);
    });
    it('Save reconciles a missing post, keeps configuration, and allows republication', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const oldId = s.saved!.published_message_id!; messages.delete(oldId);
        await act(s, 'modal-Title', 'modal', [], { title: 'Saved after deletion' }); await act(s, 'save');
        assert.equal(s.saved!.config.title, 'Saved after deletion'); assert.equal(s.saved!.published_message_id, null);
        assert.match(s.notice!, /reference was cleared/); assert.equal(sent.length, 1);
        await act(s, 'publish'); assert.equal(sent.length, 2); assert.notEqual(s.saved!.published_message_id, oldId);
    });
    it('Save reconciles a deleted channel but does not confuse Missing Access with deletion', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const id = s.saved!.published_message_id; fetchDenied = true; await act(s, 'save');
        assert.equal(s.saved!.published_message_id, id); assert.match(s.notice!, /Configuration saved, but/);
        fetchDenied = false; channelExists = false; await act(s, 'save');
        assert.equal(s.saved!.published_message_id, null); assert.match(s.notice!, /no longer exists/);
    });
    it('a Discord edit failure retains the saved config and supports retry without a new send', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        await act(s, 'modal-Title', 'modal', [], { title: 'Saved even on failure' }); messageEditFails = true; await act(s, 'save');
        assert.equal(s.saved!.config.title, 'Saved even on failure'); assert.match(s.notice!, /Configuration saved, but/);
        assert.equal(sent.length, 1); messageEditFails = false; await act(s, 'save'); assert.equal(messageEdits.length, 1);
    });
    it('Channel alone and Save do not move; explicit Move sends and tracks the replacement before deleting old', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); const old = s.saved!.published_message_id!;
        const nextChannel = '100000000000000004'; await act(s, 'channel', 'channel', [nextChannel]);
        await act(s, 'save'); assert.equal(sent.length, 1); assert.equal(s.saved!.published_channel_id, channelId);
        await act(s, 'publish'); assert.equal(sent.length, 1); assert.match(s.notice!, /Move Published Embed/);
        events.length = 0; await act(s, 'move');
        assert.equal(sent.length, 2); assert.equal(s.saved!.published_channel_id, nextChannel); assert.equal(messages.has(old), false);
        assert.deepEqual(events, [`send:${s.saved!.published_message_id}`, 'track', `delete:${old}`]);
    });
    it('failed replacement creation retains the old publication and failed old deletion rolls the move back', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); const old = s.saved!.published_message_id!;
        s.channelId = '100000000000000004'; sendFails = true; await act(s, 'move');
        assert.equal(s.saved!.published_message_id, old); assert.equal(messages.has(old), true);
        sendFails = false; oldDeleteFails = true; await act(s, 'move');
        assert.equal(s.saved!.published_message_id, old); assert.equal(messages.size, 1); assert.match(s.notice!, /old publication was restored/);
    });
    it('cleans up newly sent messages if publication persistence fails', async () => {
        const s = await savedDraft(); s.channelId = channelId; publicationFails = true; await act(s, 'publish');
        assert.equal(sent.length, 1); assert.equal(messages.size, 0); assert.equal(s.saved!.published_message_id, null);
        assert.match(s.notice!, /new message was removed/);
    });
    it('a failed move tracking write removes the replacement while retaining the original post', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); const old = s.saved!.published_message_id!;
        s.channelId = '100000000000000004'; publicationFails = true; await act(s, 'move');
        assert.equal(messages.size, 1); assert.ok(messages.has(old)); assert.equal(s.saved!.published_message_id, old);
    });
    it('resolves a lost publication response without deleting a successfully tracked message', async () => {
        const s = await savedDraft(); s.channelId = channelId; lostPublicationResponse = true; await act(s, 'publish');
        assert.equal(messages.size, 1); assert.equal(s.saved!.published_message_id, stored.get(templateId)!.published_message_id);
        assert.match(s.notice!, /Published:/);
    });
    it('recovers lost reconciliation and move-rollback responses from authoritative tracking', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const old = s.saved!.published_message_id!;
        s.channelId = '100000000000000004'; oldDeleteFails = true; lostPublicationResponse = true; await act(s, 'move');
        assert.equal(messages.size, 1); assert.equal(s.saved!.published_message_id, old);
        assert.equal(stored.get(templateId)!.published_message_id, old); assert.match(s.notice!, /old publication was restored/);
        messages.clear(); await act(s, 'save');
        assert.equal(s.saved!.published_message_id, null); assert.match(s.notice!, /reference was cleared/);
    });
    it('reports uncertain tracking and failed cleanup honestly with the created message link', async () => {
        const s = await savedDraft(); s.channelId = channelId; publicationFails = true; readFails = true; await act(s, 'publish');
        assert.equal(messages.size, 1); assert.match(s.notice!, /tracking could not be confirmed/); assert.match(s.notice!, /https:\/\/discord.com/);
        // Separate failure: write definitely failed, but Discord cannot remove the orphan.
        messages.clear(); readFails = false; cleanupFails = true; await act(s, 'publish');
        assert.equal(messages.size, 1); assert.match(s.notice!, /Remove the untracked copy/);
    });
    it('reconciles a post deleted between fetch and edit without losing the saved configuration', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); editDeleted = true; await act(s, 'save');
        assert.equal(s.saved!.published_message_id, null); assert.equal(stored.size, 1); assert.match(s.notice!, /deleted during the update/);
    });
    it('confirmed delete removes the tracked post before the row and closes every builder for it', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); const id = s.saved!.published_message_id!;
        const deletion = createSession(guildId, ownerId, s.saved); deletion.messageId = 'builder-message'; deletion.mode = 'delete';
        events.length = 0; await act(deletion, 'confirm-delete');
        assert.deepEqual(events, [`delete:${id}`, 'delete-record']); assert.equal(stored.size, 0); assert.equal(sessions.size, 0);
    });
    it('confirmed deletion succeeds when the post or channel is already gone', async () => {
        for (const deletedChannel of [false, true]) {
            channelExists = true;
            const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
            messages.clear(); channelExists = !deletedChannel; s.mode = 'delete'; await act(s, 'confirm-delete');
            assert.equal(stored.size, 0); assert.equal(sessions.has(s.id), false);
        }
    });
    it('stale Save and stale Delete never modify the published post', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const stale = createSession(guildId, ownerId, s.saved); stale.messageId = 'builder-message';
        await act(s, 'modal-Title', 'modal', [], { title: 'Winner' }); await act(s, 'save');
        await act(stale, 'modal-Title', 'modal', [], { title: 'Stale' }); await act(stale, 'save');
        assert.equal(messageEdits.length, 1); assert.equal(stored.get(templateId)!.config.title, 'Winner');
        stale.mode = 'delete'; await act(stale, 'confirm-delete'); assert.equal(messages.size, 1); assert.equal(stored.size, 1);
    });
    it('serializes the complete save workflow across two open builders', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        let release: () => void = () => undefined; let entered: () => void = () => undefined;
        const started = new Promise<void>(resolve => { entered = resolve; });
        pauseEdit = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
        const first = saveManagedEmbed(guild as unknown as Guild, s.saved!, s.config, { actor_user_id: ownerId, actor_roles: [], actor_has_admin_permission: true });
        await started;
        try {
            await assert.rejects(saveManagedEmbed(guild as unknown as Guild, stored.get(templateId)!, s.config,
                { actor_user_id: ownerId, actor_roles: [], actor_has_admin_permission: true }), /already being managed/);
        } finally { release(); await first; }
        assert.equal(messageEdits.length, 1);
    });
    it('copy-only reuse does not change canonical publication tracking', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish'); const original = structuredClone(stored.get(templateId));
        renderEmbed(s.saved!.config); await publishEmbed(guild as unknown as Guild, ownerId, '100000000000000004', s.saved!.config);
        assert.deepEqual(stored.get(templateId), original); assert.equal(sent.length, 2);
    });
    it('refuses foreign guilds and tracked messages not authored by this bot', async () => {
        const s = await savedDraft(); s.channelId = channelId; await act(s, 'publish');
        const actor = { actor_user_id: ownerId, actor_roles: [], actor_has_admin_permission: true };
        await assert.rejects(deleteManagedEmbed({ ...guild, id: '100000000000000099' } as unknown as Guild, s.saved!, actor), /another server/);
        messages.get(s.saved!.published_message_id!)!.author.id = 'somebody-else';
        s.mode = 'delete'; await act(s, 'confirm-delete'); assert.equal(stored.size, 1); assert.equal(messages.size, 1);
    });
    it('registers four guild-only Moderator commands with saved-name autocomplete', () => {
        for (const command of [createembed, editembed, listembeds, deleteembed]) {
            assert.equal(command.requiredRole, 'moderator'); assert.equal(command.data.toJSON().dm_permission, false);
        }
        for (const command of [editembed, deleteembed]) assert.ok(command.autocomplete);
    });
    it('/createembed opens one ephemeral builder with a real preview', async () => {
        let flags: unknown;
        await openBuilder({ guildId, guild, user: { id: ownerId }, deferReply: async (options: unknown) => { flags = options; },
            editReply: async (payload: unknown) => { edits.push(payload); return { id: 'builder-message' }; } } as unknown as ChatInputCommandInteraction);
        assert.deepEqual(flags, { flags: 64 }); assert.equal(sessions.size, 1); assert.equal(edits.length, 1);
    });
    it('denies other owners, guilds, messages and revoked moderator access', async () => {
        const s = draft();
        for (const patch of [{ user: { id: 'other' } }, { guildId: 'other' }, { message: { id: 'other' } }]) {
            await handleEmbedInteraction({ ...fixture(s, 'fields'), ...patch } as unknown as ButtonInteraction);
            assert.match(replies.at(-1)!.content, /belongs to someone else/);
        }
        allowed = false; await act(s, 'fields'); assert.match(replies.at(-1)!.content, /Moderator/); assert.equal(edits.length, 0);
    });
    it('opens modals without deferring and rejects stale submissions', async () => {
        const s = draft(); const interaction = await act(s, 'editor', 'select', ['Title']);
        assert.equal(interaction.deferred, false); assert.equal(modals.length, 1);
        const stale = fixture(s, 'modal-Title', 'modal', [], { title: 'Stale' });
        await act(s, 'fields'); await handleEmbedInteraction(stale as unknown as ButtonInteraction);
        assert.equal(s.config.title, undefined); assert.match(replies.at(-1)!.content, /latest controls/);
    });
    for (const [action, inputs, expected] of [
        ['Title', { title: 'Rules' }, { title: 'Rules' }],
        ['Description', { description: 'Description' }, { description: 'Description' }],
        ['Color', { color: '#5865F2' }, { color: 0x5865f2 }],
        ['Media', { thumbnail: 'https://example.com/thumb.png', image: 'https://example.com/image.png' }, { thumbnail: { url: 'https://example.com/thumb.png' }, image: { url: 'https://example.com/image.png' } }],
        ['Footer', { text: 'Footer', icon_url: 'https://example.com/icon.png' }, { footer: { text: 'Footer', icon_url: 'https://example.com/icon.png' } }],
        ['Author', { name: 'Author', url: 'https://example.com', icon_url: '' }, { author: { name: 'Author', url: 'https://example.com', icon_url: undefined } }],
        ['Title URL', { url: 'https://example.com' }, { url: 'https://example.com' }],
    ] as [string, Record<string, string>, Partial<EmbedConfig>][]) it(`editing ${action} updates the same message immediately`, async () => {
        const s = draft(); await act(s, `modal-${action}`, 'modal', [], inputs);
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(s.config[key as keyof EmbedConfig], value);
        assert.equal(edits.length, 1); assert.equal(replies.length, 0);
        assert.deepEqual((edits[0] as { embeds: unknown[] }).embeds, [renderEmbed(s.config)]);
    });
    it('adds, selects field 17, edits, toggles inline, reorders and removes', async () => {
        const s = draft();
        for (let i = 0; i < 17; i++) await act(s, 'modal-add-field', 'modal', [], { name: `Field ${i + 1}`, value: 'Body' });
        await act(s, 'select-field', 'select', ['16']); await act(s, 'modal-edit-field', 'modal', [], { name: 'Edited 17', value: 'Edited body' });
        await act(s, 'inline'); await act(s, 'up');
        assert.deepEqual(s.config.fields[15], { name: 'Edited 17', value: 'Edited body', inline: true });
        await act(s, 'down'); assert.equal(s.config.fields[16].name, 'Edited 17');
        await act(s, 'remove-field'); assert.equal(s.config.fields.length, 16);
    });
    it('clears optional properties and toggles a stable timestamp', async () => {
        const s = draft(); s.config.title = 'Title'; s.config.image = { url: 'https://example.com/a.png' }; s.config.color = 1;
        await act(s, 'modal-Title', 'modal'); await act(s, 'modal-Media', 'modal'); await act(s, 'modal-Color', 'modal');
        assert.equal(s.config.title, undefined); assert.equal(s.config.image, undefined); assert.equal(s.config.color, undefined);
        await act(s, 'editor', 'select', ['Timestamp']); const timestamp = s.config.timestamp;
        assert.ok(timestamp); assert.equal(renderEmbed(s.config).timestamp, timestamp);
        await act(s, 'editor', 'select', ['Timestamp']); assert.equal(s.config.timestamp, undefined);
    });
    it('invalid edits and failed message updates leave the current draft intact', async () => {
        const s = draft(); const original = structuredClone(s.config);
        for (const [action, inputs] of [['modal-Color', { color: 'no' }], ['modal-Media', { image: 'invalid' }], ['modal-add-field', { name: '', value: 'v' }]] as [string, Record<string, string>][]) {
            await act(s, action, 'modal', [], inputs); assert.deepEqual(s.config, original);
        }
        editFails = true; await act(s, 'modal-Title', 'modal', [], { title: 'New' }); assert.deepEqual(s.config, original);
        assert.equal(edits.length, 0);
    });
    it('channel selection stays outside the embed and publish sends only the exact preview', async () => {
        const s = await savedDraft(); edits.length = 0; await act(s, 'publish'); assert.match(replies.at(-1)!.content, /Select a destination/);
        await act(s, 'channel', 'channel', [channelId]);
        const preview = renderEmbed(s.config); await act(s, 'publish');
        assert.deepEqual(sent, [{ embeds: [preview], allowedMentions: { parse: [] } }]);
        assert.match((edits[0] as { content: string }).content, new RegExp(channelId));
        assert.equal(JSON.stringify(preview).includes(channelId), false);
    });
    it('handles deleted channels, missing permissions and publish failures without closing', async () => {
        const s = await savedDraft(); s.channelId = channelId;
        channelExists = false; await act(s, 'publish'); assert.match(s.notice!, /Publication failed/);
        channelExists = true; channelPermission = false; await act(s, 'publish'); assert.match(s.notice!, /permissions/);
        channelPermission = true; sendFails = true; await act(s, 'publish'); assert.match(s.notice!, /before retrying/);
        assert.equal(sessions.has(s.id), true);
    });
    it('recovers a failed post-publication refresh without replaying the send', async () => {
        const s = await savedDraft(); s.channelId = channelId;
        edits.length = 0; const old = fixture(s, 'publish'); editFails = true;
        await handleEmbedInteraction(old as unknown as ButtonInteraction); assert.equal(sent.length, 1);
        editFails = false;
        await handleEmbedInteraction({ ...old, deferred: false } as unknown as ButtonInteraction);
        assert.equal(sent.length, 1); assert.equal(edits.length, 1);
        assert.match(replies.at(-1)!.content, /latest controls/);
    });
    it('rejects busy actions and selected channels that were deleted', async () => {
        const s = draft(); s.busy = true; await act(s, 'publish'); assert.equal(sent.length, 0);
        s.busy = false; channelExists = false; await act(s, 'channel', 'channel', [channelId]);
        assert.equal(s.channelId, undefined); assert.match(replies.at(-1)!.content, /deleted/);
    });
    it('save, unsaved edit, save changes and confirmed deletion have explicit persistence boundaries', async () => {
        const s = draft(); await act(s, 'modal-save', 'modal', [], { name: 'support-ticket' }); assert.equal(s.saved?.name, 'support-ticket');
        await act(s, 'modal-Title', 'modal', [], { title: 'Changed' }); assert.equal(stored.get(templateId)?.config.title, undefined);
        await act(s, 'save'); assert.equal(stored.get(templateId)?.config.title, 'Changed');
        await act(s, 'cancel'); assert.equal(sessions.has(s.id), false); assert.equal(stored.size, 1);
        const deletion = createSession(guildId, ownerId, stored.get(templateId)); deletion.messageId = 'builder-message'; deletion.mode = 'delete';
        assert.equal(stored.size, 1); await act(deletion, 'confirm-delete'); assert.equal(stored.size, 0);
    });
    it('failed save keeps draft, cancel discards only draft, and expired sessions respond gracefully', async () => {
        const s = draft(); saveFails = true; await act(s, 'modal-save', 'modal', [], { name: 'test' }); assert.equal(s.saved, undefined);
        await act(s, 'cancel'); assert.equal(sessions.size, 0);
        await act(s, 'fields'); assert.match(replies.at(-1)!.content, /expired/);
    });
    it('reopens a saved embed with the same preview without sharing mutable data', async () => {
        const s = draft(); await act(s, 'modal-save', 'modal', [], { name: 'test' });
        const opened = createSession(guildId, ownerId, stored.get(templateId));
        assert.deepEqual(renderEmbed(opened.config), renderEmbed(s.config));
        opened.config.description = 'Unsaved'; assert.notEqual(stored.get(templateId)?.config.description, 'Unsaved');
    });
    it('lists saved names ephemerally and guards listing and autocomplete after role removal', async () => {
        const s = draft(); await act(s, 'modal-save', 'modal', [], { name: 'ticket-help' }); edits.length = 0;
        const interaction = {
            guild, guildId, user: { id: ownerId }, options: { getInteger: () => 1, getFocused: () => '' },
            deferReply: async () => undefined, editReply: async (value: unknown) => { edits.push(value); },
            followUp: async () => undefined, respond: async (value: unknown) => { edits.push(value); },
        };
        await listembeds.run(interaction as unknown as ChatInputCommandInteraction);
        assert.match((edits[0] as { content: string }).content, /ticket-help/);
        assert.doesNotMatch(JSON.stringify(edits[0]), /Your embed text goes here/);
        allowed = false;
        await listembeds.run(interaction as unknown as ChatInputCommandInteraction); assert.match(String(edits.at(-1)), /Moderator/);
        await editembed.autocomplete!(interaction as unknown as import('discord.js').AutocompleteInteraction);
        assert.deepEqual(edits.at(-1), []);
    });
    it('publisher rejects non-guild text channels', async () => {
        const badGuild = { ...guild, channels: { fetch: async () => ({ guildId, type: ChannelType.GuildVoice }) } };
        await assert.rejects(publishEmbed(badGuild as unknown as Guild, ownerId, channelId, draft().config), /not a server text channel/);
    });
});

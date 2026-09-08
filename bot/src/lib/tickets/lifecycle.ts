import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Client, type Guild, type Message, type PartialMessage } from 'discord.js';
import { z } from 'zod';
import { renderEmbed } from '../embeds/render.js';
import { embedError } from '../embeds/builder.js';
import { hasRequiredRoleOrHigher } from '../permissions/permissions.js';
import { BackendError } from '../utilities/http.js';
import { createLogger } from '../logging/logger.js';
import * as api from './api.js';
import { actorFor, fetchChannel, logDestination, missing, noMentions, privateOverwrites, systemActor, ticketButton, ticketCategory } from './discord.js';
import { activeChannels, appendEvent, finalizeTranscript, flushTranscript, lifecycle, messageEvent, rootEmbed, serial } from './transcript.js';
import { ticketChannelName, type Ticket } from './contract.js';

const logger = createLogger('Tickets');
const working = new Set<string>();
export function ticketLog(event: string, ticket: Ticket, error?: unknown): void {
    logger.info(event, { guildId: ticket.guild_id, userId: ticket.user_id, configId: ticket.ticket_config_id, ticketId: ticket.id,
        channelId: ticket.channel_id, threadId: ticket.thread_id, failure: error instanceof Error ? error.name : error === undefined ? undefined : 'Discord/API failure' });
}
/** Deletion must succeed before releasing uniqueness. Failed cleanup remains recoverable. */
async function deleteSource(guild: Guild, ticket: Ticket): Promise<void> {
    if (!ticket.channel_id) return;
    const channel = await fetchChannel(guild, ticket.channel_id);
    if (channel) {
        if (channel.guildId !== guild.id || channel.type !== ChannelType.GuildText || channel.topic !== `console-ticket:${ticket.id}`) throw new Error('Ticket channel identity could not be verified; staff must investigate.');
        try { await channel.delete('Console ticket closed'); } catch (e) { if (!missing(e)) throw e; }
    }
    ticketLog('Ticket channel deleted', ticket);
}
async function catchUp(guild: Guild, ticket: Ticket, freeze = true): Promise<void> {
    if (!ticket.channel_id) return;
    const channel = await fetchChannel(guild, ticket.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    // Freeze normal participant writes before final catch-up. Administrators naturally bypass overwrites.
    if (freeze) await channel.permissionOverwrites.set(channel.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type,
        allow: o.allow.remove(PermissionFlagsBits.SendMessages).bitfield, deny: o.deny.add(PermissionFlagsBits.SendMessages).bitfield })));
    let before: string | undefined;
    const pages: Message[][] = [];
    for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
        if (!batch.size) break;
        pages.push([...batch.values()]); before = batch.last()!.id;
        if (batch.size < 100) break;
    }
    for (const page of pages.reverse()) for (const message of page.reverse()) {
        await appendEvent(guild, ticket, messageEvent(message, 'message'));
    }
}
async function finishClose(guild: Guild, ticket: Ticket, status: 'closed' | 'stale' | 'failed'): Promise<Ticket> {
    try { await catchUp(guild, ticket, status !== 'failed'); }
    catch (error) { if (status !== 'failed') throw error; ticketLog('Incomplete creation history unavailable during cleanup', ticket, error); }
    if (ticket.thread_id) {
        try { await finalizeTranscript(guild, ticket, status === 'closed' ? 'Closed' : status === 'stale' ? 'Stale / manually deleted' : 'Failed'); }
        catch (error) {
            ticketLog('Transcript finalization failed', ticket, error);
            // Retain a usable source on ordinary close failure. A source already deleted,
            // or an incomplete creation, must not permanently block its user's next ticket.
            if (status === 'closed') throw error;
        }
    }
    else {
        try { await finalizeTranscript(guild, ticket, status === 'failed' ? 'Failed' : 'Stale'); }
        catch (error) { ticketLog('Root-only recovery audit failed', ticket, error); }
    }
    try { await deleteSource(guild, ticket); }
    catch (error) {
        ticketLog('Channel deletion failed; ticket remains closing', ticket, error);
        if (ticket.thread_id) {
            try {
                await lifecycle(guild, ticket, `cleanup-failed:${Date.now()}`, 'Channel deletion failed. Ticket remains reserved in closing state; automatic recovery will retry.');
            } catch (auditError) { ticketLog('Cleanup failure audit pending', ticket, auditError); }
        }
        throw new Error('The transcript was finalized, but channel deletion failed. This ticket remains in closing state. Restore Manage Channels permission; automatic recovery will retry after the five-minute lease expires.');
    }
    let updated: Ticket;
    try { updated = await api.checkpoint(guild.id, systemActor(guild), ticket.id, ticket.operation_id!, { status }); }
    catch (error) {
        updated = await api.getTicket(guild.id, systemActor(guild), ticket.id);
        if (updated.status !== status) throw error;
    }
    if (ticket.channel_id) activeChannels.delete(ticket.channel_id);
    ticketLog('Ticket closed; transcript finalized', updated);
    return updated;
}
/** Recovery owns an expired lease before reconciling Discord resources. */
export async function recoverTicket(guild: Guild, ticket: Ticket): Promise<void> {
    if (working.has(ticket.id)) return;
    if (ticket.status !== 'open' && ticket.lease_until && Date.parse(ticket.lease_until) >= Date.now()) return;
    const channel = ticket.channel_id ? await fetchChannel(guild, ticket.channel_id) : null;
    if (ticket.status === 'open' && channel) return;
    working.add(ticket.id);
    try {
        let current = await api.close(guild.id, systemActor(guild), ticket.id, randomUUID(), true);
        if (!current.log_message_id && current.log_channel_id) {
            // Recover a root send whose checkpoint never committed, using the stable
            // ticket marker and bot authorship; never infer ownership from a name.
            const logs = await fetchChannel(guild, current.log_channel_id);
            if (logs?.type === ChannelType.GuildText) {
                let before: string | undefined;
                for (;;) {
                    const batch = await logs.messages.fetch({ limit: 100, before, cache: false });
                    const root = batch.find(m => m.author.id === guild.client.user.id && m.embeds.some(e => e.description?.includes(`Ticket: ${ticket.id}\n`)));
                    if (root) { current = await api.checkpoint(guild.id, systemActor(guild), current.id, current.operation_id!, { log_message_id: root.id }); break; }
                    if (batch.size < 100 || batch.last()!.createdTimestamp < Date.parse(ticket.created_at)) break;
                    before = batch.last()!.id;
                }
            }
        }
        if (!current.thread_id && current.log_message_id) {
            // Message-associated Discord threads have the root message's ID.
            const thread = await fetchChannel(guild, current.log_message_id);
            if (thread?.type === ChannelType.PublicThread && thread.parentId === current.log_channel_id) current = await api.checkpoint(guild.id, systemActor(guild), current.id, current.operation_id!, { thread_id: thread.id });
        }
        // Crash between Discord create and its checkpoint: adopt by a stable topic marker, never by name.
        if (!current.channel_id) {
            const channels = await guild.channels.fetch();
            const orphan = channels.find(c => c?.type === ChannelType.GuildText && c.topic === `console-ticket:${ticket.id}`);
            if (orphan) current = await api.checkpoint(guild.id, systemActor(guild), current.id, current.operation_id!, { channel_id: orphan.id });
        }
        ticketLog('Stale or interrupted ticket detected', current);
        await serial(current.id, () => finishClose(guild, current, ticket.status === 'creating' ? 'failed' : channel ? 'closed' : 'stale'));
    } finally { working.delete(ticket.id); }
}
export async function createTicket(interaction: ButtonInteraction, configId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild) throw new Error('Use ticket panels in a server.');
    const guild = interaction.guild;
    logger.info('Create ticket requested', { guildId: guild.id, userId: interaction.user.id, configId });
    const actor = actorFor(await guild.members.fetch(interaction.user.id));
    const operation = randomUUID();
    let result = await api.reserve(guild.id, actor, configId, operation);
    if (!result.won && result.ticket) {
        const existing = result.ticket;
        if (existing.status === 'open') {
            const channel = existing.channel_id ? await fetchChannel(guild, existing.channel_id) : null;
            if (channel) {
                ticketLog('Existing open ticket found', existing);
                await interaction.editReply(`You already have an open ${result.config.name} ticket: <#${channel.id}>`); return;
            }
        }
        await recoverTicket(guild, existing);
        result = await api.reserve(guild.id, actor, configId, operation);
    }
    if (!result.won || !result.ticket) {
        if (result.ticket) ticketLog('Duplicate/concurrent ticket prevented', result.ticket);
        await interaction.editReply('This ticket is being created or closed. Please try again shortly.'); return;
    }
    let ticket = result.ticket;
    working.add(ticket.id);
    ticketLog('Ticket creation reservation won', ticket);
    // Keep IDs locally before each checkpoint so compensation works if a DB response is lost.
    const checkpoint = async (patch: Parameters<typeof api.checkpoint>[4]) => {
        const { status: _status, ...ids } = patch;
        Object.assign(ticket, ids);
        ticket = await api.checkpoint(guild.id, actor, ticket.id, operation, patch);
    };
    try {
        const category = await ticketCategory(guild, result.config.category_id);
        const logs = await logDestination(guild);
        const permissions = await privateOverwrites(guild, ticket);
        const channel = await guild.channels.create({ name: ticketChannelName(interaction.user.username, result.config.name), type: ChannelType.GuildText,
            parent: category.id, topic: `console-ticket:${ticket.id}`, permissionOverwrites: permissions, reason: `Console ticket ${ticket.id}` });
        await checkpoint({ channel_id: channel.id, log_channel_id: logs.id });
        ticketLog('Ticket channel created', ticket);
        const root = await logs.send({ embeds: [rootEmbed(ticket, 'Open')], allowedMentions: noMentions });
        await checkpoint({ log_message_id: root.id });
        ticketLog('Transcript root created', ticket);
        const thread = await root.startThread({ name: `ticket-${ticket.id.slice(0, 8)}-${channel.name}`.slice(0, 100), autoArchiveDuration: 10080, reason: 'Ticket audit transcript' });
        await checkpoint({ thread_id: thread.id });
        ticketLog('Transcript thread created', ticket);
        await lifecycle(guild, ticket, 'opened', `Ticket opened\nType: ${ticket.type_name}\nCreator: ${interaction.user.username} (${ticket.user_id})\nOpened: ${ticket.created_at}\nChannel: <#${channel.id}>`);
        activeChannels.set(channel.id, ticket);
        const opening = await channel.send({ content: `Ticket opened by <@${ticket.user_id}>`, embeds: [renderEmbed(result.config.opening_embed)],
            components: [ticketButton('close', ticket.id)], allowedMentions: { parse: [], users: [ticket.user_id] } });
        await checkpoint({ opening_message_id: opening.id });
        ticketLog('Opening message sent', ticket);
        await checkpoint({ status: 'open' });
        activeChannels.set(channel.id, ticket);
        ticketLog('Ticket transitioned open', ticket);
    } catch (error) {
        ticketLog('Ticket creation failed; compensating', ticket, error);
        try {
            const persisted = await api.getTicket(guild.id, actor, ticket.id);
            // A lost final commit response is success, not a reason to destroy an open ticket.
            if (persisted.status === 'open') { ticket = persisted; activeChannels.set(ticket.channel_id!, ticket); }
            else {
                try { await finalizeTranscript(guild, ticket, 'Failed'); }
                catch (auditError) { ticketLog('Creation compensation audit failed', ticket, auditError); }
                await deleteSource(guild, ticket);
                ticket = await api.checkpoint(guild.id, actor, ticket.id, operation, { status: 'failed' });
                if (ticket.channel_id) activeChannels.delete(ticket.channel_id);
            }
        } catch (cleanup) { ticketLog('Ticket compensation incomplete; recovery will retry', ticket, cleanup); }
        if (ticket.status !== 'open') throw new Error(`Ticket creation could not finish. ${embedError(error)} Any incomplete creation is reserved for automatic cleanup; retry shortly.`);
    } finally { working.delete(ticket.id); }
    await interaction.editReply(`Your ${ticket.type_name} ticket has been created: <#${ticket.channel_id}>`);
}
const confirmations = new Map<string, { user: string; ticket: string; guild: string; expires: number }>();
export async function handleTicketButton(interaction: ButtonInteraction): Promise<void> {
    try {
        const parts = z.tuple([z.literal('ticket'), z.enum(['create','close','confirm','cancel']), z.string().uuid()]).parse(interaction.customId.split(':'));
        const [, action, id] = parts;
        if (action === 'create') { await createTicket(interaction, id); return; }
        if (!interaction.guild) throw new Error('Use tickets in a server.');
        const guild = interaction.guild;
        const member = await guild.members.fetch(interaction.user.id);
        const actor = actorFor(member);
        for (const [key, c] of confirmations) if (c.expires < Date.now()) confirmations.delete(key);
        const confirmation = action === 'confirm' || action === 'cancel' ? confirmations.get(id) : undefined;
        if (action !== 'close' && (!confirmation || confirmation.user !== member.id || confirmation.guild !== guild.id)) throw new Error('This confirmation expired or belongs to someone else. Press Close Ticket again.');
        if (action === 'cancel') { confirmations.delete(id); await interaction.update({ content: 'Ticket kept open.', components: [] }); return; }
        const ticket = await api.getTicket(guild.id, actor, confirmation?.ticket ?? id);
        if (ticket.channel_id !== interaction.channelId) throw new Error('Use Close Ticket inside the ticket channel.');
        if (ticket.user_id !== member.id && !actor.actor_has_admin_permission && !ticket.staff_role_ids.some(r => actor.actor_roles.includes(r))
            && !(await hasRequiredRoleOrHigher(member, 'moderator')).hasRole) throw new Error('Only the creator or authorized ticket staff can close this ticket.');
        if (action === 'close') {
            const token = randomUUID(); confirmations.set(token, { user: member.id, guild: guild.id, ticket: ticket.id, expires: Date.now() + 120_000 });
            await interaction.reply({ content: 'Are you sure you want to close this ticket? Its channel will be deleted after the transcript is finalized.', flags: MessageFlags.Ephemeral,
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`ticket:confirm:${token}`).setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`ticket:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] }); return;
        }
        confirmations.delete(id);
        await interaction.deferUpdate();
        const current = await api.close(guild.id, actor, ticket.id, randomUUID());
        working.add(current.id);
        if (current.channel_id) activeChannels.set(current.channel_id, current);
        ticketLog('Ticket close requested', current);
        try {
            await interaction.editReply({ content: 'Closing ticket and finalizing its transcript…', components: [] });
            await serial(current.id, async () => {
                await lifecycle(guild, current, 'close-requested', `Close requested by ${member.user.username} (${member.id}) at ${current.closed_at}.`);
                await finishClose(guild, current, 'closed');
            });
        } finally { working.delete(current.id); }
    } catch (error) {
        const inactive = error instanceof BackendError && [404, 410].includes(error.status ?? 0) && interaction.customId.startsWith('ticket:create:');
        const content = inactive ? 'This ticket panel is no longer active.' : embedError(error);
        if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
    }
}
export async function routeTicketMessage(message: Message | PartialMessage, kind: 'message' | 'edit' | 'delete', old?: Message | PartialMessage): Promise<void> {
    const ticket = activeChannels.get(message.channelId);
    // Only persisted source channels are mapped; transcript threads never route back here.
    if (!ticket || !message.guild) return;
    await serial(ticket.id, async () => {
        if (!activeChannels.has(message.channelId)) return;
        await appendEvent(message.guild!, ticket, messageEvent(message, kind, old));
        await flushTranscript(message.guild!, ticket);
    });
}
export async function restoreTicketRouting(guild: Guild): Promise<void> {
    let after: string | undefined;
    do {
        const page = await api.active(guild.id, systemActor(guild), after);
        for (const ticket of page.tickets) {
            if (working.has(ticket.id)) continue;
            const restored = ticket.channel_id ? !activeChannels.has(ticket.channel_id) : false;
            if (ticket.channel_id) activeChannels.set(ticket.channel_id, ticket);
            try {
                await recoverTicket(guild, ticket);
                if (ticket.status === 'open' && ticket.thread_id && ticket.channel_id && activeChannels.has(ticket.channel_id)) {
                    await serial(ticket.id, async () => {
                        if (activeChannels.get(ticket.channel_id!)?.status !== 'open') return;
                        if (restored) await catchUp(guild, ticket, false);
                        await flushTranscript(guild, ticket);
                    });
                }
            } catch (error) { ticketLog('Ticket recovery will retry', ticket, error); }
        }
        after = page.next ?? undefined;
    } while (after);
}
export function installTicketEvents(client: Client): void {
    const guarded = (work: Promise<unknown>) => { void work.catch(error => logger.warn('Ticket event/recovery failed; durable pending entries will retry', { failure: error instanceof Error ? error.name : 'Unknown' })); };
    let running = false;
    const hydrate = async () => {
        if (running) return; running = true;
        try {
            for (const guild of client.guilds.cache.values()) {
                await restoreTicketRouting(guild);
            }
        } finally { running = false; }
    };
    client.once('ready', () => { guarded(hydrate()); const timer = setInterval(() => guarded(hydrate()), 60_000); timer.unref(); });
    client.on('guildCreate', () => guarded(hydrate()));
    client.on('messageCreate', m => guarded(routeTicketMessage(m, 'message')));
    client.on('messageUpdate', (old, m) => guarded(routeTicketMessage(m, 'edit', old)));
    client.on('messageDelete', m => guarded(routeTicketMessage(m, 'delete')));
    client.on('messageDeleteBulk', messages => { for (const m of messages.values()) guarded(routeTicketMessage(m, 'delete')); });
    client.on('channelDelete', channel => {
        const ticket = activeChannels.get(channel.id);
        if (ticket && 'guild' in channel) guarded(recoverTicket(channel.guild, ticket));
    });
}

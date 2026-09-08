import { createHash } from 'node:crypto';
import { ChannelType, EmbedBuilder, type Guild, type Message, type PartialMessage } from 'discord.js';
import { z } from 'zod';
import { request } from './api.js';
import { fetchChannel, noMentions, systemActor, missing } from './discord.js';
import type { Ticket } from './contract.js';

export const activeChannels = new Map<string, Ticket>();
const queues = new Map<string, Promise<void>>();
const enqueueRetries = new Map<string, Map<string, ReturnType<typeof messageEvent>>>();
/** Serialize transcripts and finalization in this bot process; rejected sends remain in the DB outbox. */
export async function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.then(() => undefined, () => undefined);
    queues.set(id, tail);
    try { return await next; } finally { if (queues.get(id) === tail) queues.delete(id); }
}
export function splitTranscript(context: string, body: string): string[] {
    const prefix = context.slice(0, 500) + '\n';
    const chunks: string[] = [];
    let rest = body || '(no text)';
    while (rest.length) {
        let length = Math.min(2000 - prefix.length, rest.length);
        if (/[\uD800-\uDBFF]/.test(rest[length - 1]) && length < rest.length) length--;
        chunks.push(prefix + rest.slice(0, length)); rest = rest.slice(length);
    }
    return chunks;
}
export function messageEvent(message: Message | PartialMessage, kind: 'message' | 'edit' | 'delete', old?: Message | PartialMessage) {
    const timestamp = kind === 'message' ? message.createdAt.toISOString() : kind === 'edit' ? (message.editedAt ?? new Date()).toISOString() : new Date().toISOString();
    const author = message.author ? `${message.author.username} (${message.author.id})` : 'Unknown author';
    const context = `[${timestamp}] ${kind.toUpperCase()} — ${author} — Message ${message.id}`;
    const attachments = [...message.attachments.values()].map(a => `Attachment: ${a.name} (${a.size} bytes${a.contentType ? `, ${a.contentType}` : ''})\n${a.url}`).join('\n');
    // Textual audit of already-rendered Discord embeds, including the opening template.
    const embeds = message.embeds.map(embed => [embed.title, embed.description, embed.url,
        ...embed.fields.map(field => `${field.name}\n${field.value}`), embed.author?.name, embed.footer?.text,
        embed.image?.url, embed.thumbnail?.url].filter(Boolean).join('\n')).filter(Boolean).join('\n');
    const body = (kind === 'edit' ? `Before: ${old && !old.partial ? old.content : '(original content unavailable)'}\nAfter: ` : '')
        + (message.partial ? '(content unavailable — uncached message)' : message.content || '(no text)') + (embeds ? '\nEmbed:\n' + embeds : '') + (attachments ? '\n' + attachments : '');
    return { event_key: kind === 'edit' ? `edit:${message.id}:${message.editedTimestamp ?? Date.now()}` : `${kind}:${message.id}`, chunks: splitTranscript(context, body), delivered: 0 };
}
export async function transcriptThread(guild: Guild, ticket: Ticket) {
    if (!ticket.thread_id) throw new Error('Ticket transcript has not been created.');
    const thread = await fetchChannel(guild, ticket.thread_id);
    if (!thread || thread.type !== ChannelType.PublicThread || thread.guildId !== guild.id || thread.parentId !== ticket.log_channel_id) throw new Error('The transcript thread is unavailable. Restore bot-log access before closing this ticket.');
    if (thread.archived) await thread.setArchived(false);
    if (thread.locked) await thread.setLocked(false);
    return thread;
}
const EventsResponse = z.object({ events: z.array(z.object({ event_key: z.string(), chunks: z.array(z.string()), delivered: z.number().int() })) });
export async function flushTranscript(guild: Guild, ticket: Ticket): Promise<void> {
    const a = systemActor(guild);
    // A temporary backend outage can precede durable enqueue. Keep those events in
    // memory and retry before draining/finalizing, including edits and uncached deletes.
    const retries = enqueueRetries.get(ticket.id);
    if (retries) {
        for (const [key, event] of retries) {
            z.object({ ok: z.literal(true) }).parse(await request(guild.id, a, 'enqueue', { id: ticket.id, event }));
            retries.delete(key);
        }
        if (!retries.size) enqueueRetries.delete(ticket.id);
    }
    const thread = await transcriptThread(guild, ticket);
    for (;;) {
        const { events } = EventsResponse.parse(await request(guild.id, a, 'pending', { id: ticket.id }));
        if (!events.length) return;
        for (const event of events) {
            for (let index = event.delivered; index < event.chunks.length; index++) {
                // Discord deduplicates recent retries after a lost HTTP response.
                const nonce = createHash('sha256').update(`${ticket.id}:${event.event_key}:${index}`).digest('hex').slice(0, 24);
                await thread.send({ content: event.chunks[index], allowedMentions: noMentions, nonce, enforceNonce: true });
                z.object({ ok: z.literal(true) }).parse(await request(guild.id, a, 'ack', { id: ticket.id, event: { ...event, delivered: index + 1 } }));
            }
        }
    }
}
export async function appendEvent(guild: Guild, ticket: Ticket, event: ReturnType<typeof messageEvent>): Promise<void> {
    try {
        z.object({ ok: z.literal(true) }).parse(await request(guild.id, systemActor(guild), 'enqueue', { id: ticket.id, event }));
        enqueueRetries.get(ticket.id)?.delete(event.event_key);
    } catch (error) {
        const retries = enqueueRetries.get(ticket.id) ?? new Map();
        retries.set(event.event_key, event); enqueueRetries.set(ticket.id, retries);
        throw error;
    }
}
export async function lifecycle(guild: Guild, ticket: Ticket, key: string, body: string): Promise<void> {
    await appendEvent(guild, ticket, { event_key: key, chunks: splitTranscript(`Ticket ${ticket.id} — ${ticket.type_name}`, body), delivered: 0 });
    await flushTranscript(guild, ticket);
}
export function rootEmbed(ticket: Ticket, status: string) {
    return new EmbedBuilder().setTitle(`${status === 'Open' ? '🎫' : '🔒'} Ticket ${status} — ${ticket.type_name}`)
        .setColor(status === 'Open' ? 0x5865f2 : 0x747f8d)
        .setDescription(`Creator: <@${ticket.user_id}>\nUser ID: ${ticket.user_id}\nTicket: ${ticket.id}\nChannel: ${ticket.channel_id ? `<#${ticket.channel_id}>` : 'Creation interrupted'}\nOpened: ${ticket.opened_at ?? ticket.created_at}\nStatus: ${status}`
            + (ticket.closed_at ? `\nClosed: ${ticket.closed_at}\nClosed by: ${ticket.closed_by ? `<@${ticket.closed_by}>` : 'Manual deletion / recovery'}` : ''));
}
export async function finalizeTranscript(guild: Guild, ticket: Ticket, status: string): Promise<void> {
    if (ticket.thread_id) await lifecycle(guild, ticket, 'closed', `Ticket ${status.toLowerCase()}.\nOpened: ${ticket.opened_at ?? ticket.created_at}\nClosed: ${ticket.closed_at ?? new Date().toISOString()}\nClosed by: ${ticket.closed_by ?? 'Manual deletion / recovery'}`);
    if (ticket.log_channel_id && ticket.log_message_id) {
        const channel = await fetchChannel(guild, ticket.log_channel_id);
        if (channel?.type === ChannelType.GuildText) {
            try {
                const root = await channel.messages.fetch(ticket.log_message_id);
                if (root.author.id === guild.client.user.id) await root.edit({ embeds: [rootEmbed(ticket, status)], allowedMentions: noMentions });
            } catch (e) { if (!missing(e)) throw e; }
        }
    }
    if (!ticket.thread_id) return;
    const thread = await transcriptThread(guild, ticket);
    await thread.setLocked(true);
    await thread.setArchived(true);
}

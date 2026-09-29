import assert from 'node:assert/strict';
import { beforeEach, it, mock } from 'node:test';
import { ChannelType, type Guild } from 'discord.js';
import { z } from 'zod';
import type { Ticket } from './contract.js';

// Durable API boundary model; the real SQL retention invariant is separately
// exercised by backend ticket.integration.test.ts against PostgreSQL.
const Event = z.object({ event_key: z.string(), chunks: z.array(z.string()), delivered: z.number().int() });
type Event = z.infer<typeof Event>;
const rows = new Map<string, Event>();
const sends: { content: string; nonce: string; enforceNonce: boolean }[] = [];
let failSend = 0, ackFailure: 'none' | 'before-commit' | 'after-commit' = 'none';
let ackCount = 0;
mock.module('./api.js', { namedExports: { request: async (_guild: string, _actor: unknown, action: string, payload: Record<string, unknown>) => {
    if (action === 'pending') return { events: structuredClone([...rows.values()].filter(e => e.delivered < e.chunks.length)) };
    const event = Event.parse(payload.event);
    if (action === 'enqueue') { if (!rows.has(event.event_key)) rows.set(event.event_key, structuredClone(event)); }
    if (action === 'ack') {
        ackCount++;
        if (ackFailure === 'before-commit') throw new Error('ACK request lost before commit');
        const row = rows.get(event.event_key)!;
        if (row.delivered === event.delivered - 1 && event.delivered <= row.chunks.length) {
            row.delivered = event.delivered;
            if (row.delivered === row.chunks.length) row.chunks = [];
        }
        if (ackFailure === 'after-commit') throw new Error('ACK response lost after commit');
    }
    return { ok: true };
} } });
const thread = {
    type: ChannelType.PublicThread, guildId: 'guild', parentId: 'logs', archived: false, locked: false,
    send: async (payload: { content: string; nonce: string; enforceNonce: boolean }) => {
        sends.push(payload);
        if (failSend && sends.length === failSend) throw new Error('Discord unavailable');
    },
};
mock.module('./discord.js', { namedExports: {
    fetchChannel: async () => thread, noMentions: { parse: [] }, systemActor: () => ({}), missing: () => false,
} });
const { appendEvent, flushTranscript } = await import('./transcript.js');
const guild = { id: 'guild' } as Guild;
const ticket = { id: 'ticket', thread_id: 'thread', log_channel_id: 'logs' } as Ticket;
beforeEach(() => { rows.clear(); sends.length = 0; failSend = 0; ackFailure = 'none'; ackCount = 0; });
const enqueue = async (chunks = ['message text', 'edit and attachment https://example.com/private']) => {
    const event = { event_key: 'message:123', chunks, delivered: 0 };
    await appendEvent(guild, ticket, event); return event;
};
it('failed first send retains the entire payload; a fresh drain can deliver it', async () => {
    const event = await enqueue(); assert.deepEqual(rows.get(event.event_key), event);
    failSend = 1;
    await assert.rejects(() => flushTranscript(guild, ticket), /Discord unavailable/);
    assert.deepEqual(rows.get(event.event_key), event); assert.equal(ackCount, 0);
    failSend = 0; await flushTranscript(guild, ticket);
    assert.deepEqual(rows.get(event.event_key), { ...event, delivered: 2, chunks: [] });
    assert.deepEqual(sends.slice(1).map(s => s.content), event.chunks);
});
it('mid-event failure retains all chunks, then resumes at the acknowledged cursor without replaying earlier chunks', async () => {
    const event = await enqueue(['first', 'second', 'third']); failSend = 2;
    await assert.rejects(() => flushTranscript(guild, ticket));
    assert.deepEqual(rows.get(event.event_key), { ...event, delivered: 1 });
    failSend = 0;
    // Each drain reads durable pending state; no process-local delivery cursor is used.
    await flushTranscript(guild, { ...ticket });
    assert.deepEqual(sends.map(s => s.content), ['first', 'second', 'second', 'third']);
    assert.deepEqual(rows.get(event.event_key), { ...event, chunks: [], delivered: 3 });
});
it('a lost final ACK before commit keeps the payload and retries with the same Discord nonce', async () => {
    const event = await enqueue(['final']); ackFailure = 'before-commit';
    await assert.rejects(() => flushTranscript(guild, ticket));
    assert.deepEqual(rows.get(event.event_key), event);
    ackFailure = 'none'; await flushTranscript(guild, { ...ticket });
    assert.equal(sends.length, 2); assert.equal(sends[0].nonce, sends[1].nonce);
    assert.ok(sends.every(s => s.enforceNonce));
    assert.deepEqual(rows.get(event.event_key), { ...event, chunks: [], delivered: 1 });
});
it('a lost final ACK response after commit neither replays nor restores cleared content', async () => {
    const event = await enqueue(['final']); ackFailure = 'after-commit';
    await assert.rejects(() => flushTranscript(guild, ticket));
    assert.deepEqual(rows.get(event.event_key), { ...event, chunks: [], delivered: 1 });
    ackFailure = 'none';
    await appendEvent(guild, ticket, event); // Restart catch-up sees the original message again.
    await flushTranscript(guild, { ...ticket });
    assert.equal(sends.length, 1); assert.deepEqual(rows.get(event.event_key)!.chunks, []);
});

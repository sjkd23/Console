/** Compiled production dependencies + real PostgreSQL; requires an explicitly isolated verification DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { backendConfig } from '../config.js';
import { pool } from '../db/pool.js';
import authPlugin from '../plugins/auth.js';
import routes from '../routes/admin/tickets.js';
import { TicketConfigSchema, TicketSchema } from '../lib/tickets/contract.js';

assert.match(new URL(backendConfig.DATABASE_URL).pathname, /^\/console_ticket_verify_[a-z0-9_]+$/, 'Use an isolated console_ticket_verify_* database.');
const app = Fastify();
const guild = `8${Date.now()}000`, user = '800000000000000002';
const actor = { actor_user_id: user, actor_roles: [], actor_has_admin_permission: true };
const call = async (action: string, data: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: `/guilds/${guild}/tickets/${action}`, headers: { 'x-api-key': backendConfig.BACKEND_API_KEY }, payload: { ...actor, ...data } });
    assert.equal(response.statusCode, 200, response.body); return response.json<unknown>();
};
try {
    await app.register(authPlugin); await app.register(routes);
    const panel = '800000000000000003', category = '800000000000000004';
    const { config } = z.object({ config: TicketConfigSchema }).parse(await call('save', {
        config: { name: 'Runtime Support', panel_channel_id: panel, category_id: category, panel_embed: { title: 'Panel' }, opening_embed: { title: 'Opening' }, staff_role_ids: [] },
        resources: { panel: { id: panel, guild_id: guild, type: 0 }, category: { id: category, guild_id: guild, type: 4 }, roles: [] },
    }));
    const operation = randomUUID();
    const reservation = z.object({ won: z.boolean(), ticket: TicketSchema }).parse(await call('reserve', { id: config.id, operation_id: operation }));
    assert.ok(reservation.won);
    const duplicate = z.object({ won: z.boolean() }).parse(await call('reserve', { id: config.id, operation_id: randomUUID() }));
    assert.equal(duplicate.won, false);
    const id = reservation.ticket.id;
    await call('checkpoint', { id, operation_id: operation, patch: { channel_id: panel, log_channel_id: category, log_message_id: '800000000000000005', thread_id: '800000000000000006', opening_message_id: '800000000000000007', status: 'open' } });
    const event = { event_key: 'runtime-opened', chunks: ['Runtime audit entry'], delivered: 0 };
    await call('enqueue', { id, event });
    await call('ack', { id, event: { ...event, delivered: 1 } });
    assert.deepEqual(await call('pending', { id }), { events: [] });
    const closeOperation = randomUUID();
    await call('close', { id, operation_id: closeOperation });
    const closed = z.object({ ticket: TicketSchema }).parse(await call('checkpoint', { id, operation_id: closeOperation, patch: { status: 'closed' } }));
    assert.equal(closed.ticket.status, 'closed');
    console.log('Compiled ticket routes, reservation, outbox and closure passed against isolated PostgreSQL.');
} finally {
    await pool.query('DELETE FROM ticket_transcript_event WHERE ticket_id IN (SELECT id FROM ticket WHERE guild_id=$1)', [guild]);
    await pool.query('DELETE FROM ticket WHERE guild_id=$1', [guild]);
    await pool.query('DELETE FROM ticket_config WHERE guild_id=$1', [guild]);
    await pool.query('DELETE FROM guild WHERE id=$1', [guild]);
    await app.close(); await pool.end();
}

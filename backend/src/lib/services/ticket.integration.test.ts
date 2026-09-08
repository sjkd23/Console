import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ pool: undefined as Pool | undefined, authorized: true }));
vi.mock('../../db/pool.js', () => ({ query: (sql: string, values?: unknown[]) => state.pool!.query(sql, values) }));
vi.mock('../auth/authorization.js', () => ({ hasRequiredRoleOrHigher: async () => state.authorized }));
vi.mock('../database/database-helpers.js', () => ({ ensureGuildExists: async () => undefined, getGuildRoles: async () => ({ moderator: '100000000000000099' }) }));
import routes from '../../routes/admin/tickets.js';
import * as service from './ticket-service.js';
import { ConfigInputSchema, TicketConfigSchema, TicketSchema } from '../tickets/contract.js';
import authPlugin from '../../plugins/auth.js';
import { backendConfig } from '../../config.js';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('tickets PostgreSQL and authenticated HTTP integration', () => {
    const schema = `ticket_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const app = Fastify();
    const guild = '100000000000000001', other = '100000000000000002', user = '100000000000000003';
    const channel = '100000000000000004', category = '100000000000000005';
    const actor = { actor_user_id: user, actor_roles: [], actor_has_admin_permission: false };
    const input = ConfigInputSchema.parse({ name: 'Organizer Application', panel_channel_id: channel, category_id: category,
        panel_embed: { title: 'Panel', fields: [] }, opening_embed: { title: 'Opening', fields: [{ name: 'Question', value: 'Answer here', inline: true }] }, staff_role_ids: [] });
    const resources = { panel: { id: channel, guild_id: guild, type: 0 }, category: { id: category, guild_id: guild, type: 4 }, roles: [] };
    const request = (action: string, payload: Record<string, unknown> = {}, g = guild) => app.inject({ method: 'POST', url: `/guilds/${g}/tickets/${action}`,
        headers: { 'x-api-key': backendConfig.BACKEND_API_KEY }, payload: { ...actor, ...payload } });
    const create = async () => z.object({ config: TicketConfigSchema }).parse((await request('save', { config: input, resources })).json()).config;
    const reserve = async (id: string, u = user) => service.reserve(guild, id, u, [], randomUUID());
    const makeOpen = async (id: string, u = user) => {
        const t = (await reserve(id, u)).ticket!;
        return (await service.checkpoint(guild, t.id, t.operation_id!, { channel_id: channel, log_channel_id: category, log_message_id: '100000000000000006', thread_id: '100000000000000007', opening_message_id: '100000000000000008', status: 'open' }))!;
    };
    beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        state.pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
        await state.pool.query('CREATE TABLE guild(id BIGINT PRIMARY KEY)');
        await state.pool.query('INSERT INTO guild VALUES($1),($2)', [guild, other]);
        for (const file of ['077_tickets.sql','078_ticket_transcript_outbox.sql']) await state.pool.query(readFileSync(resolve('src/db/migrations', file), 'utf8'));
        await app.register(authPlugin); await app.register(routes);
    });
    beforeEach(async () => { state.authorized = true; await state.pool!.query('TRUNCATE ticket_transcript_event,ticket,ticket_config'); });
    afterAll(async () => { await app.close(); await state.pool?.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    it('persists two independently owned structured embed templates', async () => { const c = await create(); expect(c.name).toBe(input.name); expect(c.panel_embed).toEqual(input.panel_embed); expect(c.opening_embed).toEqual(input.opening_embed); expect(await service.getConfig(guild, c.id)).toEqual(c); });
    it('requires backend authentication', async () => { expect((await app.inject({ method: 'POST', url: `/guilds/${guild}/tickets/list`, payload: actor })).statusCode).toBe(401); });
    it.each(['list','get','save','claim','publication','disable'])('rejects unauthorized configuration %s', async action => { state.authorized = false; expect((await request(action)).statusCode).toBe(403); });
    it('permits Discord administrators', async () => { state.authorized = false; expect((await request('save', { config: input, resources, actor_has_admin_permission: true })).statusCode).toBe(200); });
    it('validates purpose and both shared embed limits', async () => {
        for (const config of [{ ...input, name: ' ' }, { ...input, panel_embed: { title: 'x'.repeat(257) } }, { ...input, opening_embed: { fields: Array.from({ length: 26 }, () => ({ name: 'x', value: 'y' })) } }]) expect((await request('save', { config, resources })).statusCode).toBe(400);
    });
    it('rejects cross-guild channels and roles, wrong category type, and everyone access', async () => {
        for (const r of [{ ...resources, panel: { ...resources.panel, guild_id: other } }, { ...resources, category: { ...resources.category, type: 0 } }]) expect((await request('save', { config: input, resources: r })).statusCode).toBe(400);
        expect((await request('save', { config: { ...input, staff_role_ids: [guild] }, resources: { ...resources, roles: [{ id: guild, guild_id: guild }] } })).statusCode).toBe(400);
        expect((await request('save', { config: { ...input, staff_role_ids: [user] }, resources: { ...resources, roles: [{ id: user, guild_id: other }] } })).statusCode).toBe(400);
    });
    it('guild-scopes config reads, updates, publication, disabling and reservations', async () => {
        const c = await create();
        for (const action of ['get','claim','publication','disable','reserve']) expect((await request(action, { id: c.id, revision: 1, operation_id: randomUUID() }, other)).statusCode).toBe(404);
        expect(await service.getConfig(other, c.id)).toBeNull(); expect((await service.listConfigs(other, '', 0)).configs).toEqual([]);
    });
    it('checks revisions and preserves canonical publication on template updates', async () => {
        const c = await create(); const published = (await service.manageConfig(guild, c.id, 1, 'publication', channel, user))!;
        expect(await service.saveConfig(guild, user, input, c.id, 1)).toBeNull();
        const updated = (await service.saveConfig(guild, user, { ...input, opening_embed: { title: 'Future only', fields: [] } }, c.id, published.revision))!;
        expect(updated.panel_message_id).toBe(user); expect(updated.opening_embed.title).toBe('Future only');
    });
    it('reconciles publication as a paired reference', async () => { const c = await create(); const published = (await service.manageConfig(guild, c.id, 1, 'publication', channel, user))!; const cleared = (await service.manageConfig(guild, c.id, published.revision, 'publication'))!; expect(cleared.panel_message_id).toBeNull(); expect(cleared.published_channel_id).toBeNull(); });
    it('simultaneous reservations have exactly one winner', async () => { const c = await create(); const attempts = await Promise.all(Array.from({ length: 12 }, () => reserve(c.id))); expect(attempts.filter(r => r.won)).toHaveLength(1); expect(new Set(attempts.map(r => r.ticket!.id)).size).toBe(1); });
    it('uniqueness uses configuration ID, permits other types and users even with identical type names', async () => { const a = await create(), b = await create(); expect((await reserve(a.id)).won).toBe(true); expect((await reserve(b.id)).won).toBe(true); expect((await reserve(a.id, other)).won).toBe(true); expect((await reserve(a.id)).won).toBe(false); });
    it('failed reservations allow replacement', async () => { const c = await create(); const t = (await reserve(c.id)).ticket!; await service.checkpoint(guild, t.id, t.operation_id!, { status: 'failed' }); expect((await reserve(c.id)).won).toBe(true); });
    it('cannot open without every Discord resource checkpoint', async () => { const c = await create(); const t = (await reserve(c.id)).ticket!; expect(await service.checkpoint(guild, t.id, t.operation_id!, { status: 'open' })).toBeNull(); });
    it('cannot cross guilds or use another worker token for checkpoints', async () => { const c = await create(), t = (await reserve(c.id)).ticket!; expect(await service.checkpoint(other, t.id, t.operation_id!, {})).toBeNull(); expect(await service.checkpoint(guild, t.id, randomUUID(), {})).toBeNull(); });
    it('close is acquired once, retains attribution, and closed history allows a replacement', async () => {
        const c = await create(), t = await makeOpen(c.id);
        const results = await Promise.all([service.acquireClose(guild, t.id, user, randomUUID()), service.acquireClose(guild, t.id, other, randomUUID())]);
        expect(results.filter(Boolean)).toHaveLength(1); const closing = results.find(r => r !== null)!;
        expect(closing.closed_at).not.toBeNull(); expect(closing.closed_by).not.toBeNull(); expect((await reserve(c.id)).won).toBe(false);
        await service.checkpoint(guild, t.id, closing.operation_id!, { status: 'closed' }); expect((await reserve(c.id)).won).toBe(true); expect((await service.getTicket(guild, t.id))!.status).toBe('closed');
    });
    it('backend closure rejects unrelated users and cross-guild tickets', async () => { const c = await create(), t = await makeOpen(c.id); state.authorized = false; expect((await request('close', { id: t.id, operation_id: randomUUID(), actor_user_id: other })).statusCode).toBe(403); expect((await request('close', { id: t.id, operation_id: randomUUID() }, other)).statusCode).toBe(404); expect((await request('close', { id: t.id, operation_id: randomUUID() })).statusCode).toBe(200); });
    it('expired recovery fences the original worker and live leases cannot be stolen', async () => { const c = await create(), t = (await reserve(c.id)).ticket!; expect(await service.acquireClose(guild, t.id, null, randomUUID(), true)).toBeNull(); await state.pool!.query("UPDATE ticket SET lease_until=now()-interval '1 second' WHERE id=$1", [t.id]); const recovered = (await service.acquireClose(guild, t.id, null, randomUUID(), true))!; expect(recovered.status).toBe('closing'); expect(await service.checkpoint(guild, t.id, t.operation_id!, {})).toBeNull(); });
    it('disabled config rejects create but preserves active ticket closure and history', async () => { const c = await create(), t = await makeOpen(c.id); await service.manageConfig(guild, c.id, 1, 'disable'); expect((await request('reserve', { id: c.id, operation_id: randomUUID() })).statusCode).toBe(410); expect(await service.getTicket(guild, t.id)).not.toBeNull(); expect(await service.acquireClose(guild, t.id, user, randomUUID())).not.toBeNull(); });
    it('foreign key prevents cross-guild config ownership and hard deletion of ticket history', async () => { const c = await create(); await reserve(c.id); await expect(state.pool!.query('DELETE FROM ticket_config WHERE id=$1', [c.id])).rejects.toMatchObject({ code: '23503' }); await expect(state.pool!.query('INSERT INTO ticket(id,guild_id,ticket_config_id,user_id,type_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), other, c.id, user, 'x'])).rejects.toMatchObject({ code: '23503' }); });
    it('restart hydration returns persisted active records and excludes finished tickets', async () => { const c = await create(), t = await makeOpen(c.id); expect((await service.activeTickets(guild)).tickets.map(x => x.id)).toEqual([t.id]); expect((await service.activeTickets(other)).tickets).toEqual([]); });
    it('durable transcript deduplicates events, resumes chunks and protects guild scope', async () => {
        const c = await create(), t = await makeOpen(c.id);
        await service.enqueueTranscript(guild, t.id, 'message:1', ['first','second']); await service.enqueueTranscript(guild, t.id, 'message:1', ['wrong']);
        expect(await service.pendingTranscript(other, t.id)).toEqual([]);
        await service.acknowledgeTranscript(guild, t.id, 'message:1', 1);
        expect(await service.pendingTranscript(guild, t.id)).toEqual([{ event_key: 'message:1', chunks: ['first','second'], delivered: 1 }]);
        await service.acknowledgeTranscript(guild, t.id, 'message:1', 2); expect(await service.pendingTranscript(guild, t.id)).toEqual([]);
    });
    it('reservation route uses persisted moderator and configured staff roles', async () => { const c = await create(); const response = await request('reserve', { id: c.id, operation_id: randomUUID() }); const t = z.object({ ticket: TicketSchema }).parse(response.json()).ticket; expect(t.staff_role_ids).toContain('100000000000000099'); });
});

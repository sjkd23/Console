import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    query: vi.fn(),
    status: 'open',
    selectedDungeonKeys: ['NEST'] as string[],
    offers: new Map<string, { userId: string; keyType: string; quantity: number; source: 'headcount' | 'run' }>(),
}));

vi.mock('../../db/pool.js', () => ({ query: testState.query }));
vi.mock('../../lib/database/database-helpers.js', () => ({ ensureMemberExists: vi.fn(), getGuildRoles: vi.fn() }));
vi.mock('../../lib/auth/authorization.js', () => ({
    hasInternalRole: vi.fn(), authorizeRunActor: vi.fn(), buildRunActorContext: vi.fn(),
}));
vi.mock('../../lib/services/run-service.js', () => ({
    createRunWithTransaction: vi.fn(), startRunWithTransaction: vi.fn(), cancelRunWithTransaction: vi.fn(),
    endRunWithTransaction: vi.fn(), recordKeyPopWithTransaction: vi.fn(), chainOryx3RunWithTransaction: vi.fn(),
    RunLifecycleError: class extends Error {}, Oryx3KeyPopError: class extends Error {},
}));

import runsRoutes from './runs.js';

const guildId = '100000000000000001';
const userId = '100000000000000002';
const runId = 42;

function offerKey(keyType: string, offerUserId = userId): string {
    return `${offerUserId}:${keyType}`;
}

describe('run key quantities', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        vi.clearAllMocks();
        testState.status = 'open';
        testState.selectedDungeonKeys = ['NEST'];
        testState.offers.clear();
        testState.query.mockImplementation((sql: unknown, params?: unknown[]) => {
            const statement = String(sql);
            if (statement.includes('SELECT status, guild_id, run_kind, o3_stage')) {
                return Promise.resolve({ rowCount: 1, rows: [{
                    status: testState.status, guild_id: guildId, run_kind: 'single', o3_stage: null,
                    selected_dungeon_keys: testState.selectedDungeonKeys,
                }] });
            }
            if (statement.includes('SELECT guild_id, status, run_kind, o3_stage')) {
                return Promise.resolve({ rowCount: 1, rows: [{
                    guild_id: guildId, status: testState.status, run_kind: 'single', o3_stage: null,
                    selected_dungeon_keys: testState.selectedDungeonKeys,
                }] });
            }
            if (statement.includes('SELECT guild_id, organizer_id, status,')) {
                return Promise.resolve({ rowCount: 1, rows: [{
                    guild_id: guildId, organizer_id: userId, status: testState.status,
                    selected_dungeon_keys: testState.selectedDungeonKeys,
                }] });
            }
            if (statement.includes('SELECT guild_id FROM run')) {
                return Promise.resolve({ rowCount: 1, rows: [{ guild_id: guildId }] });
            }
            if (statement.includes('INSERT INTO key_reaction')) {
                if (testState.status !== 'open' && testState.status !== 'live') return Promise.resolve({ rowCount: 0, rows: [] });
                const isBulk = statement.includes('VALUES');
                const [, savedUserId, keyType] = params ?? [];
                const source = isBulk ? String(params?.[3]) as 'headcount' | 'run' : 'run';
                const quantity = params?.[isBulk ? 4 : 3];
                testState.offers.set(offerKey(String(keyType), String(savedUserId)), {
                    userId: String(savedUserId), keyType: String(keyType), quantity: Number(quantity), source,
                });
                return Promise.resolve({ rowCount: 1, rows: [{ quantity }] });
            }
            if (statement.includes('DELETE FROM key_reaction reaction')) {
                const [, savedUserId, keyType] = params ?? [];
                const removed = testState.offers.delete(offerKey(String(keyType), String(savedUserId)));
                return Promise.resolve({ rowCount: removed ? 1 : 0, rows: removed ? [{ key_type: keyType }] : [] });
            }
            if (statement.includes('SELECT key_type, user_id, quantity, source')) {
                return Promise.resolve({ rowCount: testState.offers.size, rows: [...testState.offers.values()].map(offer => ({
                    key_type: offer.keyType, user_id: offer.userId, quantity: offer.quantity, source: offer.source,
                })) });
            }
            throw new Error(`Unexpected query in key quantity test: ${statement}`);
        });

        app = Fastify();
        app.addHook('preHandler', async request => {
            Object.assign(request, { guildContext: { guildId } });
        });
        await app.register(runsRoutes);
    });

    afterEach(async () => app.close());

    async function submit(quantity: number | string, keyType = 'NEST_KEY') {
        return app.inject({
            method: 'POST', url: `/runs/${runId}/key-reactions`,
            payload: { userId, keyType, quantity },
        });
    }

    it('accepts quantities 1 and 10 and returns actual totals plus users', async () => {
        expect((await submit(1)).statusCode).toBe(200);
        const response = await submit(10);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            keyCounts: { NEST_KEY: 10 },
            keyOffers: { NEST_KEY: [{ userId, quantity: 10 }] },
        });
    });

    it.each([0, 11, -1, 1.5, 'three'])('rejects invalid quantity %s', async quantity => {
        expect((await submit(quantity)).statusCode).toBe(400);
        expect(testState.offers.size).toBe(0);
    });

    it('atomically replaces 2 with 5 without creating or summing rows', async () => {
        await submit(2);
        const response = await submit(5);
        expect(testState.offers.size).toBe(1);
        expect(response.json()).toMatchObject({ keyCounts: { NEST_KEY: 5 } });
        expect(testState.offers.get(offerKey('NEST_KEY'))?.quantity).toBe(5);
        const inserts = testState.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO key_reaction'));
        expect(String(inserts[1][0])).toContain('ON CONFLICT (run_id, user_id, key_type)');
        expect(String(inserts[1][0])).toContain('DO UPDATE SET quantity = EXCLUDED.quantity');
        expect(String(inserts[1][0])).toContain('FOR UPDATE');
    });

    it('treats a legacy/default row as quantity one', async () => {
        testState.offers.set(offerKey('NEST_KEY'), { userId, keyType: 'NEST_KEY', quantity: 1, source: 'run' });
        const response = await app.inject({ method: 'GET', url: `/runs/${runId}/key-reactions` });
        expect(response.json()).toMatchObject({
            keyCounts: { NEST_KEY: 1 }, keyOffers: { NEST_KEY: [{ userId, quantity: 1 }] },
        });
    });

    it('sums quantities without confusing the user count with the total', async () => {
        testState.offers.set(offerKey('NEST_KEY'), { userId, keyType: 'NEST_KEY', quantity: 3, source: 'run' });
        const secondUser = '100000000000000003';
        testState.offers.set(offerKey('NEST_KEY', secondUser), {
            userId: secondUser, keyType: 'NEST_KEY', quantity: 2, source: 'headcount',
        });
        const response = await app.inject({ method: 'GET', url: `/runs/${runId}/key-reactions` });
        expect(response.json().keyCounts.NEST_KEY).toBe(5);
        expect(response.json().keyOffers.NEST_KEY).toHaveLength(2);
    });

    it('withdraws the one current offer without accepting zero as a quantity', async () => {
        await submit(4);
        const response = await app.inject({
            method: 'DELETE', url: `/runs/${runId}/key-reactions`, payload: { userId, keyType: 'NEST_KEY' },
        });
        expect(response.json()).toMatchObject({ removed: true, keyCounts: {}, keyOffers: {} });
        expect(testState.offers.size).toBe(0);
    });

    it('imports a headcount quantity into the same canonical run key record', async () => {
        const response = await app.inject({
            method: 'POST', url: `/runs/${runId}/keys/bulk`,
            payload: { keys: [{ userId, keyType: 'NEST_KEY', quantity: 7 }], source: 'headcount' },
        });
        expect(response.statusCode).toBe(200);
        expect(testState.offers.get(offerKey('NEST_KEY'))).toMatchObject({ quantity: 7, source: 'headcount' });

        await submit(4);
        expect(testState.offers.size).toBe(1);
        expect(testState.offers.get(offerKey('NEST_KEY'))).toMatchObject({ quantity: 4, source: 'run' });
    });

    it('rejects keys outside the run and rejects ended runs', async () => {
        expect((await submit(3, 'FUNGAL_CAVERN_KEY')).statusCode).toBe(400);
        testState.status = 'ended';
        expect((await submit(3)).statusCode).toBe(409);
        expect(testState.offers.size).toBe(0);
    });

    it('uses a database constraint and migrates legacy rows to quantity one', () => {
        const migration = readFileSync(new URL('../../db/migrations/072_key_reaction_quantity.sql', import.meta.url), 'utf8');
        expect(migration).toContain('quantity INTEGER NOT NULL DEFAULT 1');
        expect(migration).toMatch(/CHECK \(quantity >= 1 AND quantity <= 10\)/);
        expect(migration).toContain('PRIMARY KEY (run_id, user_id, key_type)');
    });
});

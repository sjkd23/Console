import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    keyPopCount: 0,
    query: vi.fn(),
    recordKeyPopWithTransaction: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
    query: testState.query,
}));

vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureMemberExists: vi.fn(),
    getGuildRoles: vi.fn(),
}));

vi.mock('../../lib/services/run-service.js', () => ({
    createRunWithTransaction: vi.fn(),
    endRunWithTransaction: vi.fn(),
    recordKeyPopWithTransaction: testState.recordKeyPopWithTransaction,
}));

import runsRoutes from './runs.js';

const runId = 42;
const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const organizerRoleId = '100000000000000003';

async function popKey() {
    const app = Fastify();
    await app.register(runsRoutes);

    try {
        return await app.inject({
            method: 'PATCH',
            url: `/runs/${runId}/key-window`,
            payload: {
                actor_user_id: organizerId,
                actor_roles: [organizerRoleId],
                actor_role_positions: { [organizerRoleId]: 10 },
                seconds: 25,
            },
        });
    } finally {
        await app.close();
    }
}

describe('PATCH /runs/:id/key-window organizer completion trigger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        testState.keyPopCount = 0;
        testState.recordKeyPopWithTransaction.mockImplementation(() => {
            testState.keyPopCount += 1;
            return Promise.resolve({
                keyWindowEndsAt: '2026-08-28T20:00:25.000Z',
                keyPopCount: testState.keyPopCount,
                organizerQuotaPoints: 1,
                previousSnapshotRaidersAwarded: testState.keyPopCount > 1 ? 2 : 0,
                snapshotCount: 2,
            });
        });
        testState.query.mockImplementation((sql: unknown) => {
            const statement = String(sql);

            if (statement.includes('SELECT status, organizer_id, guild_id, dungeon_key, key_pop_count')) {
                return Promise.resolve({
                    rowCount: 1,
                    rows: [{
                        status: 'live',
                        organizer_id: organizerId,
                        guild_id: guildId,
                        dungeon_key: 'SHATTERS',
                        key_pop_count: testState.keyPopCount,
                    }],
                });
            }

            throw new Error(`Unexpected query in key-window test: ${statement}`);
        });
    });

    it('awards exactly one organizer completion for the first key pop', async () => {
        const response = await popKey();

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ key_pop_count: 1 });
        expect(testState.recordKeyPopWithTransaction).toHaveBeenCalledOnce();
        expect(testState.recordKeyPopWithTransaction).toHaveBeenCalledWith({
            guildId,
            dungeonKey: 'SHATTERS',
            runId,
            organizerId,
            organizerRoles: [organizerRoleId],
            organizerRolePositions: { [organizerRoleId]: 10 },
            keyPopCount: 0,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        });
    });

    it('awards exactly two organizer completions across two key pops and finalizes the prior snapshot', async () => {
        const firstResponse = await popKey();
        const secondResponse = await popKey();

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(200);
        expect(secondResponse.json()).toMatchObject({ key_pop_count: 2 });
        expect(testState.recordKeyPopWithTransaction).toHaveBeenCalledTimes(2);
        expect(testState.recordKeyPopWithTransaction).toHaveBeenNthCalledWith(
            1, expect.objectContaining({ expectedKeyPopCount: 0 })
        );
        expect(testState.recordKeyPopWithTransaction).toHaveBeenNthCalledWith(
            2, expect.objectContaining({ expectedKeyPopCount: 1 })
        );
    });
});

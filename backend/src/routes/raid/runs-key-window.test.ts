import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    keyPopCount: 0,
    query: vi.fn(),
    snapshotRaidersAtKeyPop: vi.fn(),
    awardOrganizerQuota: vi.fn(),
    awardRaidersQuotaFromSnapshot: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
    query: testState.query,
}));

vi.mock('../../lib/quota/quota.js', () => ({
    snapshotRaidersAtKeyPop: testState.snapshotRaidersAtKeyPop,
}));

vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureMemberExists: vi.fn(),
    getGuildRoles: vi.fn(),
}));

vi.mock('../../lib/services/run-service.js', () => ({
    createRunWithTransaction: vi.fn(),
    endRunWithTransaction: vi.fn(),
}));

vi.mock('../../lib/services/quota-service.js', () => ({
    QuotaService: class {
        awardOrganizerQuota = testState.awardOrganizerQuota;
        awardRaidersQuotaFromSnapshot = testState.awardRaidersQuotaFromSnapshot;
    },
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
        testState.snapshotRaidersAtKeyPop.mockResolvedValue(2);
        testState.awardOrganizerQuota.mockResolvedValue(1);
        testState.awardRaidersQuotaFromSnapshot.mockResolvedValue(2);
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

            if (statement.includes('key_pop_count = key_pop_count + 1')) {
                testState.keyPopCount += 1;
                return Promise.resolve({
                    rowCount: 1,
                    rows: [{
                        key_window_ends_at: '2026-08-28T20:00:25.000Z',
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
        expect(testState.awardOrganizerQuota).toHaveBeenCalledOnce();
        expect(testState.awardOrganizerQuota).toHaveBeenCalledWith({
            guildId,
            dungeonKey: 'SHATTERS',
            runId,
            organizerDiscordId: organizerId,
            organizerRoles: [organizerRoleId],
            organizerRolePositions: { [organizerRoleId]: 10 },
            keyPopNumber: 1,
        });
        expect(testState.snapshotRaidersAtKeyPop).toHaveBeenCalledWith(runId, 1);
        expect(testState.awardRaidersQuotaFromSnapshot).not.toHaveBeenCalled();
    });

    it('awards exactly two organizer completions across two key pops and finalizes the prior snapshot', async () => {
        const firstResponse = await popKey();
        const secondResponse = await popKey();

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(200);
        expect(secondResponse.json()).toMatchObject({ key_pop_count: 2 });
        expect(testState.awardOrganizerQuota).toHaveBeenCalledTimes(2);
        expect(testState.awardOrganizerQuota).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ keyPopNumber: 1 })
        );
        expect(testState.awardOrganizerQuota).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ keyPopNumber: 2 })
        );
        expect(testState.snapshotRaidersAtKeyPop).toHaveBeenNthCalledWith(1, runId, 1);
        expect(testState.snapshotRaidersAtKeyPop).toHaveBeenNthCalledWith(2, runId, 2);
        expect(testState.awardRaidersQuotaFromSnapshot).toHaveBeenCalledOnce();
        expect(testState.awardRaidersQuotaFromSnapshot).toHaveBeenCalledWith({
            guildId,
            dungeonKey: 'SHATTERS',
            runId,
            keyPopNumber: 1,
        });
    });
});

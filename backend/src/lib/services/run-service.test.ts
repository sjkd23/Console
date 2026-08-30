import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transactionClient, businessQuery, lifecycleState, quotaServiceMock, activityMock, snapshotMock } = vi.hoisted(() => {
    const businessQuery = vi.fn();
    const lifecycleState = { status: 'live' };
    return {
        businessQuery,
        lifecycleState,
        transactionClient: {
            query: vi.fn(async (sql: string, params?: unknown[]) => {
                if (sql.includes('SELECT status, finalization_kind FROM run')) {
                    return { rowCount: 1, rows: [{ status: lifecycleState.status, finalization_kind: null }] };
                }
                if (sql.includes("SET status = 'ended'")) lifecycleState.status = 'ended';
                return businessQuery(sql, params);
            }),
        },
        quotaServiceMock: {
            awardOrganizerQuota: vi.fn(),
            awardRaidersQuotaFromSnapshot: vi.fn(),
            awardRaidersQuotaFromParticipants: vi.fn(),
        },
        activityMock: vi.fn(),
        snapshotMock: vi.fn(),
    };
});

beforeEach(() => {
    businessQuery.mockReset();
    lifecycleState.status = 'live';
});

vi.mock('../database/transaction.js', () => ({
    withTransaction: vi.fn(async (work: (client: typeof transactionClient) => Promise<unknown>) =>
        work(transactionClient)),
}));

vi.mock('./quota-service.js', () => ({
    QuotaService: class {
        awardOrganizerQuota = quotaServiceMock.awardOrganizerQuota;
        awardRaidersQuotaFromSnapshot = quotaServiceMock.awardRaidersQuotaFromSnapshot;
        awardRaidersQuotaFromParticipants = quotaServiceMock.awardRaidersQuotaFromParticipants;
    },
}));

vi.mock('../dungeon-activity/activity-service.js', () => ({
    recordDungeonActivity: activityMock,
}));

vi.mock('../quota/quota.js', () => ({
    snapshotRaidersAtKeyPop: snapshotMock,
}));

import {
    createRunWithTransaction,
    endRunWithTransaction,
    Oryx3KeyPopError,
    recordKeyPopWithTransaction,
    type CreateRunInput,
    type EndRunInput,
} from './run-service.js';

const baseInput: EndRunInput = {
    runId: 42,
    guildId: '100000000000000001',
    organizerId: '100000000000000002',
    dungeonKey: 'SHATTERS',
    keyPopCount: 1,
    organizerRoles: ['100000000000000003'],
    organizerRolePositions: { '100000000000000003': 10 },
};

describe('endRunWithTransaction organizer completion trigger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        businessQuery.mockResolvedValue({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z',
                organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS',
                activity_key: 'SHATTERS',
                run_kind: 'single',
                key_pop_count: 1,
            }],
        });
        activityMock.mockResolvedValue('inserted');
        snapshotMock.mockResolvedValue(2);
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(1);
        quotaServiceMock.awardRaidersQuotaFromSnapshot.mockResolvedValue(1);
        quotaServiceMock.awardRaidersQuotaFromParticipants.mockResolvedValue(1);
    });

    it('keeps a one-key normal dungeon at its single key-pop organizer completion', async () => {
        const organizerCompletionsAfterKeyPops = 1;

        const result = await endRunWithTransaction(baseInput);

        expect(organizerCompletionsAfterKeyPops + result.organizerQuotaPoints).toBe(1);
        expect(result.organizerQuotaPoints).toBe(0);
        expect(quotaServiceMock.awardOrganizerQuota).not.toHaveBeenCalled();
    });

    it('awards no organizer completion when a normal dungeon ends without a key pop', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single', key_pop_count: 0,
            }],
        });
        const result = await endRunWithTransaction({
            ...baseInput,
            keyPopCount: 0,
        });

        expect(result.organizerQuotaPoints).toBe(0);
        expect(quotaServiceMock.awardOrganizerQuota).not.toHaveBeenCalled();
    });

    it('keeps a two-key normal dungeon at its two key-pop organizer completions', async () => {
        const organizerCompletionsAfterKeyPops = 2;

        const result = await endRunWithTransaction({
            ...baseInput,
            keyPopCount: 2,
        });

        expect(organizerCompletionsAfterKeyPops + result.organizerQuotaPoints).toBe(2);
        expect(result.organizerQuotaPoints).toBe(0);
        expect(quotaServiceMock.awardOrganizerQuota).not.toHaveBeenCalled();
    });

    it('awards Oryx 3 once at end and skips accounting on a stale terminal retry', async () => {
        businessQuery.mockResolvedValue({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: 'ORYX_3', activity_key: 'ORYX_3', run_kind: 'oryx_3', key_pop_count: 0,
            }],
        });
        quotaServiceMock.awardOrganizerQuota
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        const input: EndRunInput = {
            ...baseInput,
            dungeonKey: 'ORYX_3',
            keyPopCount: 0,
        };

        const firstResult = await endRunWithTransaction(input);
        const retryResult = await endRunWithTransaction(input);

        expect(firstResult.organizerQuotaPoints).toBe(1);
        expect(retryResult.organizerQuotaPoints).toBe(0);
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledTimes(1);
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledWith(
            expect.objectContaining({
                dungeonKey: 'ORYX_3',
                runId: input.runId,
                organizerDiscordId: input.organizerId,
            }),
            transactionClient
        );
        expect(activityMock).toHaveBeenCalledTimes(1);
        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'organizer',
                dungeonStatsKey: 'ORYX_3',
                subjectId: `run:${input.runId}:o3:organizer`,
                source: 'o3_end',
            }),
            transactionClient
        );
    });

    it('still finalizes the last key-pop raider snapshot for a normal dungeon', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single', key_pop_count: 2,
            }],
        });
        quotaServiceMock.awardRaidersQuotaFromSnapshot.mockResolvedValue(3);

        const result = await endRunWithTransaction({
            ...baseInput,
            keyPopCount: 2,
        });

        expect(result.raiderPointsAwarded).toBe(3);
        expect(quotaServiceMock.awardRaidersQuotaFromSnapshot).toHaveBeenCalledOnce();
        expect(quotaServiceMock.awardRaidersQuotaFromSnapshot).toHaveBeenCalledWith(
            {
                guildId: baseInput.guildId,
                dungeonKey: baseInput.dungeonKey,
                activityKey: baseInput.dungeonKey,
                runId: baseInput.runId,
                keyPopNumber: 2,
            },
            transactionClient
        );
        expect(quotaServiceMock.awardRaidersQuotaFromParticipants).not.toHaveBeenCalled();
    });

    it('still ends and performs no-key participant finalization for a normal dungeon', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single', key_pop_count: 0,
            }],
        });
        quotaServiceMock.awardRaidersQuotaFromParticipants.mockResolvedValue(2);

        const result = await endRunWithTransaction({
            ...baseInput,
            keyPopCount: 0,
        });

        expect(result).toEqual({
            organizerQuotaPoints: 0,
            raiderPointsAwarded: 2,
        });
        expect(transactionClient.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'ended'"),
            [baseInput.runId, baseInput.guildId]
        );
        expect(quotaServiceMock.awardRaidersQuotaFromParticipants).toHaveBeenCalledOnce();
    });

    it('records normal organizer key-pop activity even when configured quota is zero', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
                organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS',
                activity_key: 'SHATTERS',
                run_kind: 'single',
            }],
        });
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(0);

        const result = await recordKeyPopWithTransaction({
            ...baseInput,
            keyPopCount: 0,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        });

        expect(result).toMatchObject({ keyPopCount: 1, organizerQuotaPoints: 0, snapshotCount: 2 });
        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectId: `run:${baseInput.runId}:keypop:1:organizer`,
                dungeonStatsKey: baseInput.dungeonKey,
                count: 1,
            }),
            transactionClient
        );
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledAfter(activityMock);
    });

    it('records one normal organizer activity and preserves the configured nonzero quota award', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
                organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS',
                activity_key: 'SHATTERS',
                run_kind: 'single',
            }],
        });
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(2);

        const result = await recordKeyPopWithTransaction({
            ...baseInput,
            keyPopCount: 0,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        });

        expect(result?.organizerQuotaPoints).toBe(2);
        expect(activityMock).toHaveBeenCalledOnce();
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledOnce();
    });

    it('does not duplicate organizer activity or quota on a stale key-pop retry', async () => {
        businessQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    key_window_ends_at: '2026-08-28T20:15:25.000Z',
                    key_pop_count: 1,
                    occurred_at: '2026-08-28T20:15:00.000Z',
                    organizer_id: baseInput.organizerId,
                    dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single',
                }],
            })
            .mockResolvedValueOnce({ rowCount: 0, rows: [] });

        const input = {
            ...baseInput,
            keyPopCount: 0,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        };
        expect(await recordKeyPopWithTransaction(input)).not.toBeNull();
        expect(await recordKeyPopWithTransaction(input)).toBeNull();

        expect(activityMock).toHaveBeenCalledOnce();
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledOnce();
    });

    it('does not attempt quota when the organizer activity write fails', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
                organizer_id: baseInput.organizerId,
                dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single',
            }],
        });
        activityMock.mockRejectedValue(new Error('activity write failed'));

        await expect(recordKeyPopWithTransaction({
            ...baseInput,
            keyPopCount: 0,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        })).rejects.toThrow('activity write failed');
        expect(quotaServiceMock.awardOrganizerQuota).not.toHaveBeenCalled();
    });

    it('uses distinct organizer activity identities across multiple key pops', async () => {
        businessQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ key_window_ends_at: new Date(), key_pop_count: 1, occurred_at: new Date(), organizer_id: baseInput.organizerId, dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single' }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ key_window_ends_at: new Date(), key_pop_count: 2, occurred_at: new Date(), organizer_id: baseInput.organizerId, dungeon_key: 'SHATTERS', activity_key: 'SHATTERS', run_kind: 'single' }],
            });

        await recordKeyPopWithTransaction({
            ...baseInput, keyPopCount: 0, expectedKeyPopCount: 0, keyWindowSeconds: 25,
        });
        await recordKeyPopWithTransaction({
            ...baseInput, keyPopCount: 1, expectedKeyPopCount: 1, keyWindowSeconds: 25,
        });

        expect(activityMock).toHaveBeenNthCalledWith(
            1, expect.objectContaining({ subjectId: `run:${baseInput.runId}:keypop:1:organizer` }), transactionClient
        );
        expect(activityMock).toHaveBeenNthCalledWith(
            2, expect.objectContaining({ subjectId: `run:${baseInput.runId}:keypop:2:organizer` }), transactionClient
        );
        expect(quotaServiceMock.awardRaidersQuotaFromSnapshot).toHaveBeenCalledOnce();
    });

    it('records O3 organizer activity when configured quota is zero', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                ended_at: '2026-08-28T20:48:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: 'ORYX_3', activity_key: 'ORYX_3', run_kind: 'oryx_3', key_pop_count: 0,
            }],
        });
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(0);

        const result = await endRunWithTransaction({ ...baseInput, dungeonKey: 'ORYX_3', keyPopCount: 0 });

        expect(result.organizerQuotaPoints).toBe(0);
        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({ subjectId: `run:${baseInput.runId}:o3:organizer` }),
            transactionClient
        );
    });
});

describe('createRunWithTransaction normalized persistence', () => {
    const createInput: CreateRunInput = {
        guildId: baseInput.guildId,
        guildName: 'Test Guild',
        organizerId: baseInput.organizerId!,
        organizerUsername: 'Organizer',
        channelId: '100000000000000004',
        selectedDungeonKeys: ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS'],
        autoEndMinutes: 120,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        businessQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })
            // pg returns BIGSERIAL/BIGINT values as strings by default.
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: '674' }] })
            .mockResolvedValue({ rowCount: 1, rows: [] });
    });

    it('persists authoritative parent taxonomy and ordered backend-resolved selection snapshots', async () => {
        const spoofed = {
            ...createInput,
            dungeonLabel: 'Spoofed',
            runKind: 'single',
            activityKey: 'NEST',
        };
        const result = await createRunWithTransaction(spoofed);

        expect(result).toMatchObject({
            runId: 674,
            runKind: 'multi_exalt',
            activityKey: 'EXALTATION_DUNGEONS',
            dungeonKey: 'EXALTATION_DUNGEONS',
            dungeonLabel: 'Exaltation Dungeons',
        });
        expect(result.selectedDungeons).toEqual([
            { dungeonKey: 'NEST', dungeonLabel: 'Nest', selectionOrder: 1 },
            { dungeonKey: 'FUNGAL_CAVERN', dungeonLabel: 'Fungal Cavern', selectionOrder: 2 },
            { dungeonKey: 'STEAMWORKS', dungeonLabel: 'Steamworks', selectionOrder: 3 },
        ]);
        expect(transactionClient.query).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO run'),
            expect.arrayContaining(['EXALTATION_DUNGEONS', 'Exaltation Dungeons', 'multi_exalt'])
        );
        expect(transactionClient.query).toHaveBeenNthCalledWith(
            4,
            expect.stringContaining('INSERT INTO run_dungeon_selection'),
            [674, 'NEST', 'Nest', 1]
        );
        expect(transactionClient.query).toHaveBeenNthCalledWith(
            6,
            expect.stringContaining('INSERT INTO run_dungeon_selection'),
            [674, 'STEAMWORKS', 'Steamworks', 3]
        );
    });

    it('fails the transactional creation if a selection insert fails', async () => {
        businessQuery
            .mockReset()
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 91 }] })
            .mockRejectedValueOnce(new Error('selection insert failed'));

        await expect(createRunWithTransaction(createInput)).rejects.toThrow('selection insert failed');
    });
});

describe('persisted taxonomy activity and fallback routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activityMock.mockResolvedValue('inserted');
        snapshotMock.mockResolvedValue(2);
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(0);
        quotaServiceMock.awardRaidersQuotaFromSnapshot.mockResolvedValue(0);
        quotaServiceMock.awardRaidersQuotaFromParticipants.mockResolvedValue(0);
    });

    it.each([
        ['single', 'NEST', 'NEST', undefined],
        ['realm_clearing', 'REALM_DUNGEON', 'MISC_DUNGEONS', 'non_exalt'],
        ['multi_non_exalt', 'MISC_DUNGEONS', 'MISC_DUNGEONS', 'non_exalt'],
        ['multi_exalt', 'EXALTATION_DUNGEONS', 'EXALTATION_DUNGEONS', 'exalt'],
    ] as const)('routes %s Dungeon Entered through persisted activity_key', async (runKind, dungeonKey, activityKey, baseCategory) => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z', key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z', organizer_id: baseInput.organizerId,
                dungeon_key: dungeonKey, activity_key: activityKey, run_kind: runKind,
            }],
        });

        await recordKeyPopWithTransaction({
            runId: baseInput.runId,
            guildId: baseInput.guildId,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        });

        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dungeonStatsKey: activityKey,
                subjectId: `run:${baseInput.runId}:keypop:1:organizer`,
            }),
            transactionClient
        );
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledWith(
            expect.objectContaining({ dungeonKey, activityKey, baseCategory }), transactionClient
        );
    });

    it('explicitly rejects normal Dungeon Entered for persisted O3', async () => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: new Date(), key_pop_count: 1, occurred_at: new Date(),
                organizer_id: baseInput.organizerId, dungeon_key: 'ORYX_3', activity_key: 'ORYX_3', run_kind: 'oryx_3',
            }],
        });

        await expect(recordKeyPopWithTransaction({
            runId: baseInput.runId,
            guildId: baseInput.guildId,
            expectedKeyPopCount: 0,
            keyWindowSeconds: 25,
        })).rejects.toBeInstanceOf(Oryx3KeyPopError);
        expect(activityMock).not.toHaveBeenCalled();
        expect(quotaServiceMock.awardOrganizerQuota).not.toHaveBeenCalled();
    });

    it('routes prior-pop and final-pop multi-exalt raider snapshots through the aggregate activity key', async () => {
        businessQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    key_window_ends_at: new Date(), key_pop_count: 2, occurred_at: new Date(),
                    organizer_id: baseInput.organizerId, dungeon_key: 'EXALTATION_DUNGEONS',
                    activity_key: 'EXALTATION_DUNGEONS', run_kind: 'multi_exalt',
                }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    ended_at: new Date(), organizer_id: baseInput.organizerId,
                    dungeon_key: 'EXALTATION_DUNGEONS', activity_key: 'EXALTATION_DUNGEONS',
                    run_kind: 'multi_exalt', key_pop_count: 2,
                }],
            });

        await recordKeyPopWithTransaction({
            runId: baseInput.runId,
            guildId: baseInput.guildId,
            expectedKeyPopCount: 1,
            keyWindowSeconds: 25,
        });
        await endRunWithTransaction({ runId: baseInput.runId, guildId: baseInput.guildId });

        expect(quotaServiceMock.awardRaidersQuotaFromSnapshot).toHaveBeenNthCalledWith(1, {
            guildId: baseInput.guildId,
            dungeonKey: 'EXALTATION_DUNGEONS',
            activityKey: 'EXALTATION_DUNGEONS',
            baseCategory: 'exalt',
            runId: baseInput.runId,
            keyPopNumber: 1,
        }, transactionClient);
        expect(quotaServiceMock.awardRaidersQuotaFromSnapshot).toHaveBeenNthCalledWith(2, {
            guildId: baseInput.guildId,
            dungeonKey: 'EXALTATION_DUNGEONS',
            activityKey: 'EXALTATION_DUNGEONS',
            baseCategory: 'exalt',
            runId: baseInput.runId,
            keyPopNumber: 2,
        }, transactionClient);
    });

    it.each([
        ['realm_clearing', 'REALM_DUNGEON', 'MISC_DUNGEONS'],
        ['multi_non_exalt', 'MISC_DUNGEONS', 'MISC_DUNGEONS'],
        ['multi_exalt', 'EXALTATION_DUNGEONS', 'EXALTATION_DUNGEONS'],
    ] as const)('does not fabricate no-pop participant activity for %s', async (runKind, dungeonKey, activityKey) => {
        businessQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                ended_at: new Date(), organizer_id: baseInput.organizerId,
                dungeon_key: dungeonKey, activity_key: activityKey, run_kind: runKind, key_pop_count: 0,
            }],
        });

        const result = await endRunWithTransaction({ runId: baseInput.runId, guildId: baseInput.guildId });

        expect(result).toEqual({ organizerQuotaPoints: 0, raiderPointsAwarded: 0 });
        expect(quotaServiceMock.awardRaidersQuotaFromParticipants).not.toHaveBeenCalled();
        expect(activityMock).not.toHaveBeenCalled();
    });
});

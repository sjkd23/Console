import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transactionClient, quotaServiceMock, activityMock, snapshotMock } = vi.hoisted(() => ({
    transactionClient: {
        query: vi.fn(),
    },
    quotaServiceMock: {
        awardOrganizerQuota: vi.fn(),
        awardRaidersQuotaFromSnapshot: vi.fn(),
        awardRaidersQuotaFromParticipants: vi.fn(),
    },
    activityMock: vi.fn(),
    snapshotMock: vi.fn(),
}));

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

import { endRunWithTransaction, recordKeyPopWithTransaction, type EndRunInput } from './run-service.js';

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
        transactionClient.query.mockResolvedValue({
            rowCount: 1,
            rows: [{ ended_at: '2026-08-28T20:48:00.000Z' }],
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

    it('awards Oryx 3 once at end and relies on the existing writer idempotency for a stale retry', async () => {
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
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledTimes(2);
        expect(quotaServiceMock.awardOrganizerQuota).toHaveBeenCalledWith(
            expect.objectContaining({
                dungeonKey: 'ORYX_3',
                runId: input.runId,
                organizerDiscordId: input.organizerId,
            }),
            transactionClient
        );
        expect(activityMock).toHaveBeenCalledTimes(2);
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
                runId: baseInput.runId,
                keyPopNumber: 2,
            },
            transactionClient
        );
        expect(quotaServiceMock.awardRaidersQuotaFromParticipants).not.toHaveBeenCalled();
    });

    it('still ends and performs no-key participant finalization for a normal dungeon', async () => {
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
        transactionClient.query.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
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
        transactionClient.query.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
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
        transactionClient.query
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    key_window_ends_at: '2026-08-28T20:15:25.000Z',
                    key_pop_count: 1,
                    occurred_at: '2026-08-28T20:15:00.000Z',
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
        transactionClient.query.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                key_window_ends_at: '2026-08-28T20:15:25.000Z',
                key_pop_count: 1,
                occurred_at: '2026-08-28T20:15:00.000Z',
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
        transactionClient.query
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ key_window_ends_at: new Date(), key_pop_count: 1, occurred_at: new Date() }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ key_window_ends_at: new Date(), key_pop_count: 2, occurred_at: new Date() }],
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
        quotaServiceMock.awardOrganizerQuota.mockResolvedValue(0);

        const result = await endRunWithTransaction({ ...baseInput, dungeonKey: 'ORYX_3', keyPopCount: 0 });

        expect(result.organizerQuotaPoints).toBe(0);
        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({ subjectId: `run:${baseInput.runId}:o3:organizer` }),
            transactionClient
        );
    });
});

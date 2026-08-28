import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transactionClient, quotaServiceMock } = vi.hoisted(() => ({
    transactionClient: {
        query: vi.fn(),
    },
    quotaServiceMock: {
        awardOrganizerQuota: vi.fn(),
        awardRaidersQuotaFromSnapshot: vi.fn(),
        awardRaidersQuotaFromParticipants: vi.fn(),
    },
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

import { endRunWithTransaction, type EndRunInput } from './run-service.js';

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
        transactionClient.query.mockResolvedValue({ rowCount: 1, rows: [] });
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
            [baseInput.runId]
        );
        expect(quotaServiceMock.awardRaidersQuotaFromParticipants).toHaveBeenCalledOnce();
    });
});

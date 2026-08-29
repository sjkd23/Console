import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    query: vi.fn(),
    getQuotaRoleForDungeon: vi.fn(),
    logOrganizerRunCompletionEvent: vi.fn(),
    recordManualRunActivity: vi.fn(),
    transactionClient: { query: vi.fn() },
}));

vi.mock('../../db/pool.js', () => ({ query: testState.query }));

vi.mock('../../lib/auth/authorization.js', () => ({
    hasInternalRole: vi.fn().mockResolvedValue(true),
    hasRequiredRoleOrHigher: vi.fn(),
    requireSecurity: vi.fn(),
    canManageGuildRoles: vi.fn(),
}));

vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureGuildExists: vi.fn(),
    ensureMemberExists: vi.fn(),
    ensureRaiderExists: vi.fn(),
}));

vi.mock('../../lib/quota/quota.js', () => ({
    getQuotaRoleForDungeon: testState.getQuotaRoleForDungeon,
}));

vi.mock('../../lib/services/quota-service.js', () => ({
    QuotaService: class {
        logOrganizerRunCompletionEvent = testState.logOrganizerRunCompletionEvent;
    },
}));

vi.mock('../../lib/database/transaction.js', () => ({
    withTransaction: vi.fn(async (work: (client: typeof testState.transactionClient) => Promise<unknown>) =>
        work(testState.transactionClient)),
}));

vi.mock('../../lib/dungeon-activity/activity-service.js', () => ({
    recordManualRunActivity: testState.recordManualRunActivity,
}));

vi.mock('../../lib/services/quota-period-service.js', () => ({}));

import quotaRoutes from './quota.js';

const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const quotaRoleId = '100000000000000003';

async function logRuns(amount: number) {
    const app = Fastify();
    await app.register(quotaRoutes);
    try {
        return await app.inject({
            method: 'POST',
            url: '/quota/log-run',
            payload: {
                actorId: organizerId,
                guildId,
                dungeonKey: 'NEST',
                amount,
            },
        });
    } finally {
        await app.close();
    }
}

describe('POST /quota/log-run activity dual-write', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        testState.getQuotaRoleForDungeon.mockResolvedValue({ roleId: quotaRoleId, points: 2 });
        testState.logOrganizerRunCompletionEvent.mockResolvedValue(10);
        testState.recordManualRunActivity.mockResolvedValue('inserted');
        testState.query.mockResolvedValue({ rows: [{ total_quota_points: '0' }], rowCount: 1 });
    });

    it('keeps the existing +5 quota award and records one aggregate manual activity in the same transaction', async () => {
        const response = await logRuns(5);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ logged: 5, total_points: 10, quota_role_id: quotaRoleId });
        expect(testState.recordManualRunActivity).toHaveBeenCalledOnce();
        expect(testState.recordManualRunActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                guildId,
                userId: organizerId,
                dungeonStatsKey: 'NEST',
                count: 5,
            }),
            testState.transactionClient
        );
        expect(testState.logOrganizerRunCompletionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ quotaPoints: 10, quotaRoleId }),
            testState.transactionClient
        );
    });

    it('records positive activity even when organizer quota is configured to zero', async () => {
        testState.getQuotaRoleForDungeon.mockResolvedValue({ roleId: quotaRoleId, points: 0 });

        const response = await logRuns(5);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ logged: 0, total_points: 0 });
        expect(testState.recordManualRunActivity).toHaveBeenCalledWith(
            expect.objectContaining({ count: 5 }),
            testState.transactionClient
        );
        expect(testState.logOrganizerRunCompletionEvent).not.toHaveBeenCalled();
    });

    it('preserves negative quota correction while writing the matching activity adjustment', async () => {
        testState.query.mockResolvedValue({ rows: [{ total_quota_points: '20' }], rowCount: 1 });
        testState.logOrganizerRunCompletionEvent.mockResolvedValue(-4);
        testState.recordManualRunActivity.mockResolvedValue('inserted');

        const response = await logRuns(-2);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ logged: 2, total_points: -4 });
        expect(testState.recordManualRunActivity).toHaveBeenCalledWith(
            expect.objectContaining({ count: -2 }),
            testState.transactionClient
        );
        expect(testState.logOrganizerRunCompletionEvent).toHaveBeenCalledWith(
            expect.objectContaining({ quotaPoints: -4 }),
            testState.transactionClient
        );
    });
});

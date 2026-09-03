import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    getCanonicalActivityRows: vi.fn(),
    getCanonicalActivityLeaderboard: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
    pool: { query: mocks.query },
    query: mocks.query,
}));

vi.mock('../dungeon-activity/stats-service.js', async importOriginal => {
    const original = await importOriginal<typeof import('../dungeon-activity/stats-service.js')>();
    return {
        ...original,
        getCanonicalActivityRows: mocks.getCanonicalActivityRows,
        getCanonicalActivityLeaderboard: mocks.getCanonicalActivityLeaderboard,
    };
});

vi.mock('../services/quota-period-service.js', () => ({
    deactivateQuotaAutomationInTransaction: vi.fn(),
    ensureActiveQuotaPeriod: vi.fn(),
    getActiveQuotaPeriod: vi.fn(),
}));

import { getLeaderboard, getUserQuotaStats } from './quota.js';

describe('canonical activity readers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCanonicalActivityRows.mockResolvedValue([
            { user_id: '2', role: 'organizer', dungeon_stats_key: 'NEST', count: 3 },
            { user_id: '2', role: 'raider', dungeon_stats_key: 'NEST', count: 7 },
        ]);
        mocks.query
            .mockResolvedValueOnce({ rows: [{ total: '125' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ total: '40' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ total: '237' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ total: '4' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ dungeon_key: 'NEST', count: '4' }], rowCount: 1 });
    });

    it('/stats takes activity counts from canonical rows while retaining point-ledger totals', async () => {
        const stats = await getUserQuotaStats('1', '2');

        expect(mocks.getCanonicalActivityRows).toHaveBeenCalledWith({ guildId: '1', userId: '2' });
        expect(stats).toMatchObject({
            total_points: 125,
            total_quota_points: 40,
            total_runs_organized: 3,
            non_exalt_run_minutes: 237,
            total_verifications: 2,
            total_keys_popped: 4,
            dungeons: [{ dungeon_key: 'NEST', completed: 7, organized: 3, keys_popped: 4 }],
        });
        expect(mocks.query.mock.calls[0][0]).toContain('SUM(points)');
        expect(mocks.query.mock.calls[1][0]).toContain('SUM(quota_points)');
    });

    it('activity leaderboards use the canonical service and point leaderboards stay on quota_event', async () => {
        mocks.getCanonicalActivityLeaderboard.mockResolvedValue([{ user_id: '2', count: 3 }]);
        expect(await getLeaderboard('1', 'runs_organized', 'NEST')).toEqual([{ user_id: '2', count: 3 }]);
        expect(mocks.getCanonicalActivityLeaderboard).toHaveBeenCalledWith(expect.objectContaining({
            guildId: '1', role: 'organizer', dungeonStatsKey: 'NEST',
        }));

        mocks.query.mockReset();
        mocks.query.mockResolvedValue({ rows: [{ user_id: '2', count: '125' }], rowCount: 1 });
        expect(await getLeaderboard('1', 'points', 'all')).toEqual([{ user_id: '2', count: 125 }]);
        expect(mocks.query.mock.calls[0][0]).toContain('SUM(points)');
    });
});

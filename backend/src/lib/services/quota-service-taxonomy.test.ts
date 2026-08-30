import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, activityMock } = vi.hoisted(() => ({
    poolQueryMock: vi.fn(),
    activityMock: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
    pool: { query: poolQueryMock },
    query: poolQueryMock,
}));

vi.mock('../dungeon-activity/activity-service.js', () => ({
    recordDungeonActivity: activityMock,
}));

import { QuotaService } from './quota-service.js';

const context = {
    guildId: '100000000000000001',
    runId: 42,
    keyPopNumber: 1,
};

function makeClient() {
    return { query: vi.fn(async (sql: unknown, _params?: readonly unknown[]) => {
        const statement = String(sql);
        if (statement.includes('FROM key_pop_snapshot')) {
            return {
                rowCount: 1,
                rows: [{ user_id: '100000000000000009', snapshot_time: '2026-08-28T20:15:00.000Z' }],
            };
        }
        if (statement.includes('FROM raider_points_config')) {
            return { rowCount: 1, rows: [{ points: '9' }] };
        }
        if (statement.includes('INSERT INTO quota_event')) return { rowCount: 1, rows: [{ id: 1 }] };
        if (statement.includes('UPDATE key_pop_snapshot')) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected quota-service test query: ${statement}`);
    }) };
}

describe('aggregate raider point routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activityMock.mockResolvedValue('inserted');
    });

    it.each([
        ['multi exalt', 'EXALTATION_DUNGEONS', 'EXALTATION_DUNGEONS', 'exalt'],
        ['multi non-exalt', 'MISC_DUNGEONS', 'MISC_DUNGEONS', 'non_exalt'],
    ] as const)('uses base/default raider points for %s and never selects a physical override', async (_label, dungeonKey, activityKey, baseCategory) => {
        const client = makeClient();
        const awarded = await new QuotaService().awardRaidersQuotaFromSnapshot({
            ...context,
            dungeonKey,
            activityKey,
            baseCategory,
        }, client as never);

        expect(awarded).toBe(1);
        expect(client.query).not.toHaveBeenCalledWith(
            expect.stringContaining('FROM raider_points_config'),
            expect.anything()
        );
        expect(activityMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dungeonStatsKey: activityKey,
                subjectId: `run:42:keypop:1:raider:100000000000000009`,
            }),
            client
        );
        const quotaInsert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO quota_event'));
        expect(quotaInsert?.[1]).toEqual(expect.arrayContaining([dungeonKey, 1]));
    });

    it('preserves the single-Nest configured raider override path', async () => {
        const client = makeClient();
        await new QuotaService().awardRaidersQuotaFromSnapshot({
            ...context,
            dungeonKey: 'NEST',
            activityKey: 'NEST',
        }, client as never);

        expect(client.query).toHaveBeenCalledWith(
            expect.stringContaining('FROM raider_points_config'),
            [context.guildId, 'NEST']
        );
        const quotaInsert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO quota_event'));
        expect(quotaInsert?.[1]).toEqual(expect.arrayContaining(['NEST', 9]));
    });
});

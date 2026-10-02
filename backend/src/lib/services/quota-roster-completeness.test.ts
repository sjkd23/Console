import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), includeLiveRoster: true }));
vi.mock('../../db/pool.js', () => ({ query: state.query }));
vi.mock('../database/transaction.js', () => ({
    withTransaction: (work: (client: PoolClient) => Promise<unknown>) => work({ query: state.clientQuery } as unknown as PoolClient),
}));
vi.mock('../logging/logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
import { closeAndDeleteQuotaConfig, deactivateQuotaAutomationInTransaction, finalizeDueQuotaPeriods, manuallyResetQuotaPeriod } from './quota-period-service.js';

const guild = '100000000000000001', role = '100000000000000002', zeroMember = '100000000000000003';
const initialPeriod = {
    id: '1', guild_id: guild, quota_role_id: role, starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-01-02T00:00:00Z',
    required_points: '10', rollover_enabled: false, predecessor_period_id: null,
    status: 'active', close_reason: null as string | null, roster_complete: false,
    created_at: '2026-01-01T00:00:00Z', finalized_at: null as string | null, quota_log_posted_at: null,
};
let period = { ...initialPeriod };
const results: Array<Record<string, unknown>> = [];
beforeEach(() => {
    period = { ...initialPeriod }; results.length = 0; state.includeLiveRoster = true;
    state.query.mockReset(); state.clientQuery.mockReset();
    state.query.mockImplementation(async (sql: string) => sql.includes('AS include_live_roster')
        ? { rows: [{ include_live_roster: state.includeLiveRoster }], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    state.clientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM quota_role_config')) return { rows: [{ required_points: '10', reset_interval_days: 7, rollover_enabled: false }] };
        if (sql.includes('SELECT NOW()')) return { rows: [{ now: '2026-01-03T00:00:00Z' }] };
        if (sql.includes('FROM quota_event')) return { rows: [] };
        if (sql.includes('INSERT INTO quota_period_member_result')) {
            results.push({ user_id: params[1], earned_points: params[2], carry_in: params[3], effective_total: params[4], met_quota: params[5], carry_out: params[6], result_source: params[7] });
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes("SET status = 'finalized'")) {
            period = { ...period, status: 'finalized', close_reason: String(params[1]), roster_complete: params[2] === true };
            return { rows: [{ id: '1' }], rowCount: 1 };
        }
        if (sql.includes('FROM quota_period_member_result')) return { rows: results };
        if (sql.includes('FROM quota_period')) return { rows: [period], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    });
});

describe('quota roster completeness', () => {
    for (const complete of [undefined, false, true]) {
        for (const operation of ['scheduled', 'manual', 'delete', 'deactivate'] as const) {
            it(`${operation} records completeness=${String(complete)} and retains available zero-point members`, async () => {
                const memberIds = [zeroMember];
                const finalized = operation === 'scheduled'
                    ? (await finalizeDueQuotaPeriods(guild, role, memberIds, 1, complete)).periods[0]
                    : operation === 'manual'
                        ? (await manuallyResetQuotaPeriod(guild, role, memberIds, complete)).periods[0]
                        : operation === 'delete'
                            ? (await closeAndDeleteQuotaConfig(guild, role, 'config_deleted', memberIds, complete)).periods[0]
                            : await deactivateQuotaAutomationInTransaction({ query: state.clientQuery } as unknown as PoolClient, guild, role, memberIds, complete);
                expect(finalized).toMatchObject({ status: 'finalized', roster_complete: complete === true });
                expect(finalized?.results).toEqual([{
                    user_id: zeroMember, earned_points: 0, carry_in: 0, effective_total: 0,
                    met_quota: false, carry_out: 0, result_source: 'live_roster',
                }]);
            });
        }
    }
    it('does not claim historical reconstructed periods are complete even with a complete current roster', async () => {
        state.includeLiveRoster = false;
        const finalized = await finalizeDueQuotaPeriods(guild, role, [zeroMember], 1, true);
        expect(finalized.periods[0]).toMatchObject({ status: 'finalized', roster_complete: false, results: [] });
    });
    it('does not claim completeness without any live roster on role deletion', async () => {
        const finalized = await closeAndDeleteQuotaConfig(guild, role, 'role_deleted', undefined, true);
        expect(finalized.periods[0]).toMatchObject({ status: 'finalized', roster_complete: false, results: [] });
    });
});

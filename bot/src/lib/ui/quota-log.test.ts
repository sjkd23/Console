import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QuotaPeriod, QuotaPeriodMemberResult } from '../utilities/http.js';
import { buildQuotaLogEmbeds } from './quota-log.js';

const basePeriod: Omit<QuotaPeriod, 'results'> = {
    id: 'period-1',
    guild_id: 'guild-1',
    quota_role_id: 'role-1',
    starts_at: '2026-08-01T00:00:00.000Z',
    ends_at: '2026-08-08T00:00:00.000Z',
    required_points: 10,
    rollover_enabled: true,
    predecessor_period_id: null,
    status: 'finalized',
    close_reason: 'scheduled',
    roster_complete: true,
    created_at: '2026-08-01T00:00:00.000Z',
    finalized_at: '2026-08-08T00:00:00.000Z',
    quota_log_posted_at: null,
};

function result(overrides: Partial<QuotaPeriodMemberResult>): QuotaPeriodMemberResult {
    return {
        user_id: 'user-1',
        earned_points: 0,
        carry_in: 0,
        effective_total: 0,
        met_quota: false,
        carry_out: 0,
        result_source: 'live_roster',
        ...overrides,
    };
}

function memberDescription(memberResult: QuotaPeriodMemberResult): string {
    const embeds = buildQuotaLogEmbeds({ ...basePeriod, results: [memberResult] }, 'Organizer');
    return embeds[1]?.toJSON().description ?? '';
}

describe('finalized quota log rendering', () => {
    const cases: Array<{ name: string; input: Partial<QuotaPeriodMemberResult>; expected: string }> = [
        {
            name: 'shows only the effective total when no rollover is involved',
            input: { earned_points: 12, effective_total: 12, met_quota: true },
            expected: '✅ <@user-1> — 12 pts',
        },
        {
            name: 'shows a missed quota without accounting labels',
            input: { earned_points: 4, effective_total: 4 },
            expected: '❌ <@user-1> — 4 pts',
        },
        {
            name: 'explains earned, rollover, and carry-out points',
            input: { earned_points: 10, carry_in: 10, effective_total: 20, carry_out: 10, met_quota: true },
            expected: '✅ <@user-1> — 20 pts (10 earned + 10 rollover → 10 carries)',
        },
        {
            name: 'omits zero earned and zero carry-out values for rollover-only quota',
            input: { carry_in: 10, effective_total: 10, met_quota: true },
            expected: '✅ <@user-1> — 10 pts (10 rollover)',
        },
        {
            name: 'explains newly earned carry without carry-in',
            input: { earned_points: 20, effective_total: 20, carry_out: 10, met_quota: true },
            expected: '✅ <@user-1> — 20 pts (20 earned → 10 carries)',
        },
        {
            name: 'renders an inactive member as zero points only',
            input: {},
            expected: '❌ <@user-1> — 0 pts',
        },
    ];

    for (const testCase of cases) {
        it(testCase.name, () => {
            assert.equal(memberDescription(result(testCase.input)), testCase.expected);
        });
    }

    it('uses the quota role in a single result embed title', () => {
        const embeds = buildQuotaLogEmbeds({ ...basePeriod, results: [result({})] }, 'Security');
        assert.equal(embeds[1]?.toJSON().title, 'Security Member Results');
    });

    it('uses the quota role and page numbers in every paginated result title', () => {
        const results = Array.from({ length: 250 }, (_, index) => result({ user_id: `member-${index}` }));
        const resultEmbeds = buildQuotaLogEmbeds({ ...basePeriod, results }, 'Administrator').slice(1);

        assert.ok(resultEmbeds.length > 1);
        assert.deepEqual(
            resultEmbeds.map(embed => embed.toJSON().title),
            resultEmbeds.map((_, index) => `Administrator Member Results (${index + 1}/${resultEmbeds.length})`),
        );
        const renderedLines = resultEmbeds.flatMap(embed => embed.toJSON().description?.split('\n') ?? []);
        assert.equal(renderedLines.length, results.length);
        assert.ok(resultEmbeds.every(embed => (embed.toJSON().description?.length ?? 0) <= 3_800));
    });

    it('uses the quota role in the empty-results embed title', () => {
        const embeds = buildQuotaLogEmbeds({ ...basePeriod, results: [] }, 'Organizer');
        assert.equal(embeds[1]?.toJSON().title, 'Organizer Member Results');
    });
});

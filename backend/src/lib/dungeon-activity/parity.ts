import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import type { ActivityQueryClient } from './backfill.js';
import {
    ActivityRoleSchema,
    classifyLegacyQuotaEvent,
    DungeonActivityAggregateSchema,
    getLegacyStatsContributions,
    LegacyQuotaEventSchema,
    type ActivityRole,
    type LegacyExclusionReason,
} from './legacy-classification.js';

export type ParityReason =
    | LegacyExclusionReason
    | 'canonical_activity_has_zero_legacy_points'
    | 'legacy_count_differs_from_canonical_activity'
    | 'legacy_cross_role_points'
    | 'backfill_missing_or_extra_activity'
    | 'unexplained_count_difference';

export type ParityStatus = 'match' | 'explained_mismatch' | 'unexpected_mismatch';

export interface DungeonActivityParityRow {
    guild_id: string;
    user_id: string;
    role: ActivityRole;
    dungeon_stats_key: string | null;
    legacy_count: number;
    activity_count: number;
    difference: number;
    status: ParityStatus;
    reasons: ParityReason[];
}

export interface DungeonActivityParityReport {
    rows: DungeonActivityParityRow[];
    summary: {
        compared_groups: number;
        exact_matches: number;
        explained_mismatches: number;
        unexpected_mismatches: number;
    };
}

interface MutableParityMetric {
    guildId: string;
    userId: string;
    role: ActivityRole;
    dungeonStatsKey: string | null;
    legacyCount: number;
    expectedActivityCount: number;
    activityCount: number;
    reasons: Set<ParityReason>;
    unexpectedReasons: Set<ParityReason>;
}

const KnownExplainedExclusions = new Set<LegacyExclusionReason>([
    'manual_key_points_not_completion',
    'manual_quota_adjustment_not_activity',
    'manual_raider_points_adjustment_not_activity',
    'manual_run_reversal_not_positive_activity',
    'legacy_manual_run_reversal_not_positive_activity',
    'zero_count_manual_run_not_activity',
]);

function metricKey(guildId: string, userId: string, role: ActivityRole, dungeon: string | null): string {
    return JSON.stringify([guildId, userId, role, dungeon]);
}

function getMetric(
    metrics: Map<string, MutableParityMetric>,
    guildId: string,
    userId: string,
    role: ActivityRole,
    dungeonStatsKey: string | null
): MutableParityMetric {
    const key = metricKey(guildId, userId, role, dungeonStatsKey);
    const existing = metrics.get(key);
    if (existing) return existing;

    const created: MutableParityMetric = {
        guildId,
        userId,
        role,
        dungeonStatsKey,
        legacyCount: 0,
        expectedActivityCount: 0,
        activityCount: 0,
        reasons: new Set(),
        unexpectedReasons: new Set(),
    };
    metrics.set(key, created);
    return created;
}

export function compareDungeonActivityParity(
    rawLegacyEvents: readonly unknown[],
    rawActivityAggregates: readonly unknown[]
): DungeonActivityParityReport {
    const metrics = new Map<string, MutableParityMetric>();

    for (const rawLegacy of rawLegacyEvents) {
        const legacy = LegacyQuotaEventSchema.parse(rawLegacy);
        const classification = classifyLegacyQuotaEvent(legacy);
        const contributions = getLegacyStatsContributions(legacy);

        for (const contribution of contributions) {
            const metric = getMetric(
                metrics,
                legacy.guild_id,
                legacy.actor_user_id,
                contribution.role,
                legacy.dungeon_key
            );
            metric.legacyCount += contribution.count;

            if (classification.kind === 'excluded') {
                metric.reasons.add(classification.reason);
                if (!KnownExplainedExclusions.has(classification.reason)) {
                    metric.unexpectedReasons.add(classification.reason);
                }
            } else if (classification.event.role !== contribution.role) {
                metric.reasons.add('legacy_cross_role_points');
            }
        }

        if (classification.kind === 'activity') {
            const expected = getMetric(
                metrics,
                classification.event.guildId,
                classification.event.userId,
                classification.event.role,
                classification.event.dungeonStatsKey
            );
            expected.expectedActivityCount += classification.event.count;

            const legacySameRole = contributions
                .filter(contribution => contribution.role === classification.event.role)
                .reduce((sum, contribution) => sum + contribution.count, 0);

            if (legacySameRole === 0) {
                expected.reasons.add('canonical_activity_has_zero_legacy_points');
            } else if (legacySameRole !== classification.event.count) {
                expected.reasons.add('legacy_count_differs_from_canonical_activity');
                expected.unexpectedReasons.add('legacy_count_differs_from_canonical_activity');
            }
        }
    }

    for (const rawAggregate of rawActivityAggregates) {
        const aggregate = DungeonActivityAggregateSchema.parse(rawAggregate);
        const metric = getMetric(
            metrics,
            aggregate.guild_id,
            aggregate.user_id,
            aggregate.role,
            aggregate.dungeon_stats_key
        );
        metric.activityCount += aggregate.count;
    }

    const rows = [...metrics.values()].map<DungeonActivityParityRow>(metric => {
        if (metric.activityCount !== metric.expectedActivityCount) {
            metric.reasons.add('backfill_missing_or_extra_activity');
            metric.unexpectedReasons.add('backfill_missing_or_extra_activity');
        }

        const difference = metric.activityCount - metric.legacyCount;
        if (difference !== 0 && metric.reasons.size === 0) {
            metric.reasons.add('unexplained_count_difference');
            metric.unexpectedReasons.add('unexplained_count_difference');
        }

        const status: ParityStatus = metric.unexpectedReasons.size > 0
            ? 'unexpected_mismatch'
            : difference !== 0 || metric.reasons.size > 0
                ? 'explained_mismatch'
                : 'match';

        return {
            guild_id: metric.guildId,
            user_id: metric.userId,
            role: metric.role,
            dungeon_stats_key: metric.dungeonStatsKey,
            legacy_count: metric.legacyCount,
            activity_count: metric.activityCount,
            difference,
            status,
            reasons: [...metric.reasons].sort(),
        };
    }).sort((left, right) =>
        left.guild_id.localeCompare(right.guild_id)
        || left.user_id.localeCompare(right.user_id)
        || left.role.localeCompare(right.role)
        || (left.dungeon_stats_key ?? '').localeCompare(right.dungeon_stats_key ?? '')
    );

    return {
        rows,
        summary: {
            compared_groups: rows.length,
            exact_matches: rows.filter(row => row.status === 'match').length,
            explained_mismatches: rows.filter(row => row.status === 'explained_mismatch').length,
            unexpected_mismatches: rows.filter(row => row.status === 'unexpected_mismatch').length,
        },
    };
}

export async function getDungeonActivityStats(
    db: ActivityQueryClient,
    filters: { guildId?: string; userId?: string } = {}
): Promise<z.infer<typeof DungeonActivityAggregateSchema>[]> {
    const result = await db.query<QueryResultRow>(
        `SELECT guild_id::text, user_id::text, role, dungeon_stats_key,
                SUM(count)::text AS count
         FROM dungeon_activity_event
         WHERE ($1::bigint IS NULL OR guild_id = $1::bigint)
           AND ($2::bigint IS NULL OR user_id = $2::bigint)
         GROUP BY guild_id, user_id, role, dungeon_stats_key
         ORDER BY guild_id, user_id, role, dungeon_stats_key`,
        [filters.guildId ?? null, filters.userId ?? null]
    );
    return result.rows.map(row => DungeonActivityAggregateSchema.parse(row));
}

export async function analyzeDungeonActivityParity(
    db: ActivityQueryClient,
    guildId?: string
): Promise<DungeonActivityParityReport> {
    const legacyRows = await db.query<QueryResultRow>(
        `SELECT id::text, guild_id::text, actor_user_id::text, action_type, subject_id,
                dungeon_key, points::text, quota_points::text, created_at
         FROM quota_event
         WHERE ($1::bigint IS NULL OR guild_id = $1::bigint)
         ORDER BY id`,
        [guildId ?? null]
    );
    const activityRows = await getDungeonActivityStats(db, { guildId });
    return compareDungeonActivityParity(legacyRows.rows, activityRows);
}

const GapCountSchema = z.object({
    organizer_key_pop_candidates: z.coerce.number().int().nonnegative(),
    o3_organizer_candidates: z.coerce.number().int().nonnegative(),
    snapshot_raider_candidates: z.coerce.number().int().nonnegative(),
    participant_raider_candidates: z.coerce.number().int().nonnegative(),
});

export interface HistoricalZeroPointGapReport extends z.infer<typeof GapCountSchema> {
    classifications: {
        organizer_key_pop_candidates: 'partially_recoverable';
        o3_organizer_candidates: 'partially_recoverable';
        snapshot_raider_candidates: 'partially_recoverable';
        participant_raider_candidates: 'not_recoverable';
    };
}

/**
 * Reports operational evidence that has no matching quota row. It deliberately
 * does not write canonical activity: writer-version, completion, and historical
 * point-config ambiguity need a product decision before those candidates are used.
 */
export async function analyzeHistoricalZeroPointGaps(
    db: ActivityQueryClient,
    guildId?: string
): Promise<HistoricalZeroPointGapReport> {
    const result = await db.query<QueryResultRow>(
        `WITH scoped_runs AS (
             SELECT * FROM run
             WHERE ($1::bigint IS NULL OR guild_id = $1::bigint)
         ),
         organizer_key_pops AS (
             SELECT run.id, run.guild_id, pop_number
             FROM scoped_runs AS run
             CROSS JOIN LATERAL generate_series(1, run.key_pop_count) AS pop_number
             WHERE run.dungeon_key <> 'ORYX_3'
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'run:' || run.id || ':keypop:' || pop_number
               )
         ),
         o3_organizers AS (
             SELECT run.id
             FROM scoped_runs AS run
             WHERE run.dungeon_key = 'ORYX_3'
               AND run.status = 'ended'
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'run:' || run.id
               )
         ),
         snapshot_raiders AS (
             SELECT snapshot.run_id, snapshot.key_pop_number, snapshot.user_id
             FROM key_pop_snapshot AS snapshot
             JOIN scoped_runs AS run ON run.id = snapshot.run_id
             WHERE (snapshot.key_pop_number < run.key_pop_count OR run.status = 'ended')
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'raider:' || run.id || ':'
                         || snapshot.key_pop_number || ':' || snapshot.user_id
               )
         ),
         participant_raiders AS (
             SELECT DISTINCT reaction.run_id, reaction.user_id
             FROM reaction
             JOIN scoped_runs AS run ON run.id = reaction.run_id
             WHERE run.status = 'ended'
               AND run.key_pop_count = 0
               AND reaction.state = 'join'
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'raider:' || run.id || ':' || reaction.user_id
               )
         )
         SELECT
             (SELECT COUNT(*) FROM organizer_key_pops)::text AS organizer_key_pop_candidates,
             (SELECT COUNT(*) FROM o3_organizers)::text AS o3_organizer_candidates,
             (SELECT COUNT(*) FROM snapshot_raiders)::text AS snapshot_raider_candidates,
             (SELECT COUNT(*) FROM participant_raiders)::text AS participant_raider_candidates`,
        [guildId ?? null]
    );

    return {
        ...GapCountSchema.parse(result.rows[0]),
        classifications: {
            organizer_key_pop_candidates: 'partially_recoverable',
            o3_organizer_candidates: 'partially_recoverable',
            snapshot_raider_candidates: 'partially_recoverable',
            participant_raider_candidates: 'not_recoverable',
        },
    };
}

export const ParityRoleSchema = ActivityRoleSchema;

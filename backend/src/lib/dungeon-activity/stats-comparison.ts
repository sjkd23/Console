import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import type { ActivityQueryClient } from './backfill.js';
import { getCanonicalActivityRows } from './stats-service.js';
import { ActivityRoleSchema, type ActivityRole } from './legacy-classification.js';

export const StatsDifferenceReasonSchema = z.enum([
    'manual_key_points_not_completion',
    'manual_quota_adjustment_not_activity',
    'manual_raider_points_adjustment_not_activity',
    'manual_run_correction_applied',
    'recovered_zero_point_activity',
]);
export type StatsDifferenceReason = z.infer<typeof StatsDifferenceReasonSchema>;

const ComparisonDbRowSchema = z.object({
    guild_id: z.union([z.string(), z.number(), z.bigint()]).transform(String),
    user_id: z.union([z.string(), z.number(), z.bigint()]).transform(String),
    role: ActivityRoleSchema,
    dungeon_stats_key: z.string().nullable(),
    count: z.coerce.number().int(),
});

const ReasonDbRowSchema = ComparisonDbRowSchema.omit({ count: true }).extend({
    reason: StatsDifferenceReasonSchema,
});

export interface CanonicalStatsComparisonRow {
    guild_id: string;
    user_id: string;
    role: ActivityRole;
    dungeon_stats_key: string | null;
    legacy_count: number;
    canonical_count: number;
    difference: number;
    status: 'match' | 'explained_mismatch' | 'unexplained_mismatch';
    reasons: StatsDifferenceReason[];
}

export interface CanonicalStatsComparisonReport {
    rows: CanonicalStatsComparisonRow[];
    summary: {
        compared_groups: number;
        exact_matches: number;
        changed_groups: number;
        explained_mismatches: number;
        unexplained_mismatches: number;
        changes_by_reason: Partial<Record<StatsDifferenceReason, number>>;
        legacy_total: number;
        canonical_total: number;
    };
}

function key(guildId: string, userId: string, role: ActivityRole, dungeon: string | null): string {
    return JSON.stringify([guildId, userId, role, dungeon]);
}

export async function compareCanonicalStatsToLegacy(
    db: ActivityQueryClient,
    guildId?: string
): Promise<CanonicalStatsComparisonReport> {
    const legacyResult = await db.query<QueryResultRow>(
        `WITH contribution AS (
             SELECT guild_id, actor_user_id AS user_id, 'raider'::text AS role, dungeon_key,
                    (CASE WHEN subject_id ~ '^manual_log_run:[0-9]+:[0-9]+:[0-9]+$'
                          THEN split_part(subject_id, ':', 4)::int ELSE 1 END
                     * SIGN(points))::bigint AS amount
             FROM quota_event
             WHERE action_type = 'run_completed' AND points <> 0
               AND ($1::bigint IS NULL OR guild_id = $1::bigint)
             UNION ALL
             SELECT guild_id, actor_user_id, 'organizer'::text, dungeon_key,
                    (CASE WHEN subject_id ~ '^manual_log_run:[0-9]+:[0-9]+:[0-9]+$'
                          THEN split_part(subject_id, ':', 4)::int ELSE 1 END
                     * SIGN(quota_points))::bigint
             FROM quota_event
             WHERE action_type = 'run_completed' AND quota_points <> 0
               AND ($1::bigint IS NULL OR guild_id = $1::bigint)
         )
         SELECT guild_id::text, user_id::text, role, dungeon_key AS dungeon_stats_key,
                SUM(amount)::text AS count
         FROM contribution
         GROUP BY guild_id, user_id, role, dungeon_key`,
        [guildId ?? null]
    );

    const guildResult = await db.query<QueryResultRow>(
        `SELECT DISTINCT guild_id::text
         FROM (
             SELECT guild_id FROM dungeon_activity_event
             UNION SELECT guild_id FROM dungeon_activity_adjustment
         ) AS guilds
         WHERE ($1::bigint IS NULL OR guild_id = $1::bigint)
         ORDER BY guild_id`,
        [guildId ?? null]
    );
    const reasonsResult = await db.query<QueryResultRow>(
         `WITH point_reason AS (
             SELECT guild_id, actor_user_id AS user_id, 'raider'::text AS role,
                    dungeon_key AS dungeon_stats_key,
                    CASE
                        WHEN subject_id LIKE 'key_pop:%' THEN 'manual_key_points_not_completion'
                        WHEN subject_id LIKE 'manual_adjust_points:%' THEN 'manual_raider_points_adjustment_not_activity'
                        ELSE 'manual_quota_adjustment_not_activity'
                    END::text AS reason
             FROM quota_event
             WHERE action_type = 'run_completed'
               AND points <> 0
               AND (subject_id LIKE 'key_pop:%'
                    OR subject_id LIKE 'manual_adjust_points:%'
                    OR subject_id LIKE 'manual_adjust:%')
               AND ($1::bigint IS NULL OR guild_id = $1::bigint)
             UNION ALL
             SELECT guild_id, actor_user_id, 'organizer'::text, dungeon_key,
                    'manual_quota_adjustment_not_activity'::text
             FROM quota_event
             WHERE action_type = 'run_completed'
               AND quota_points <> 0
               AND (subject_id LIKE 'key_pop:%'
                    OR subject_id LIKE 'manual_adjust_points:%'
                    OR subject_id LIKE 'manual_adjust:%')
               AND ($1::bigint IS NULL OR guild_id = $1::bigint)
         ), correction_reason AS (
             SELECT guild_id, user_id, role, dungeon_stats_key,
                    'manual_run_correction_applied'::text AS reason
             FROM dungeon_activity_adjustment
             WHERE ($1::bigint IS NULL OR guild_id = $1::bigint)
         ), recovery_reason AS (
             SELECT activity.guild_id, activity.user_id, activity.role,
                    activity.dungeon_stats_key,
                    'recovered_zero_point_activity'::text AS reason
             FROM dungeon_activity_event AS activity
             WHERE ($1::bigint IS NULL OR activity.guild_id = $1::bigint)
               AND activity.source <> 'historical_quota_event'
         )
         SELECT DISTINCT guild_id::text, user_id::text, role, dungeon_stats_key, reason
         FROM (
             SELECT * FROM point_reason
             UNION ALL SELECT * FROM correction_reason
             UNION ALL SELECT * FROM recovery_reason
         ) AS reasons`,
        [guildId ?? null]
    );

    const values = new Map<string, {
        guildId: string;
        userId: string;
        role: ActivityRole;
        dungeon: string | null;
        legacy: number;
        canonical: number;
        reasons: Set<StatsDifferenceReason>;
    }>();
    const ensure = (guild: string, user: string, role: ActivityRole, dungeon: string | null) => {
        const metricKey = key(guild, user, role, dungeon);
        const existing = values.get(metricKey);
        if (existing) return existing;
        const created = { guildId: guild, userId: user, role, dungeon, legacy: 0, canonical: 0, reasons: new Set<StatsDifferenceReason>() };
        values.set(metricKey, created);
        return created;
    };

    for (const raw of legacyResult.rows) {
        const row = ComparisonDbRowSchema.parse(raw);
        ensure(row.guild_id, row.user_id, row.role, row.dungeon_stats_key).legacy = row.count;
    }
    // Canonical rows do not repeat guild_id because the query is guild-scoped.
    for (const guildRow of guildResult.rows) {
        const scopedGuild = String(guildRow.guild_id);
        const rows = await getCanonicalActivityRows({ guildId: scopedGuild }, db);
        for (const row of rows) {
            ensure(scopedGuild, row.user_id, row.role, row.dungeon_stats_key).canonical = row.count;
        }
    }
    for (const raw of reasonsResult.rows) {
        const row = ReasonDbRowSchema.parse(raw);
        ensure(row.guild_id, row.user_id, row.role, row.dungeon_stats_key).reasons.add(row.reason);
    }

    const rows = [...values.values()].map<CanonicalStatsComparisonRow>(metric => {
        const difference = metric.canonical - metric.legacy;
        // Phase A parity independently proves that historical_quota_event rows
        // match their classified legacy facts. A remaining positive delta is
        // therefore activity with no non-zero legacy currency contribution.
        if (difference > 0 && metric.reasons.size === 0) {
            metric.reasons.add('recovered_zero_point_activity');
        }
        const status = difference === 0
            ? 'match' as const
            : metric.reasons.size > 0 ? 'explained_mismatch' as const : 'unexplained_mismatch' as const;
        return {
            guild_id: metric.guildId,
            user_id: metric.userId,
            role: metric.role,
            dungeon_stats_key: metric.dungeon,
            legacy_count: metric.legacy,
            canonical_count: metric.canonical,
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

    const changesByReason: Partial<Record<StatsDifferenceReason, number>> = {};
    for (const row of rows.filter(item => item.difference !== 0)) {
        for (const reason of row.reasons) changesByReason[reason] = (changesByReason[reason] ?? 0) + 1;
    }
    return {
        rows,
        summary: {
            compared_groups: rows.length,
            exact_matches: rows.filter(row => row.status === 'match').length,
            changed_groups: rows.filter(row => row.difference !== 0).length,
            explained_mismatches: rows.filter(row => row.status === 'explained_mismatch').length,
            unexplained_mismatches: rows.filter(row => row.status === 'unexplained_mismatch').length,
            changes_by_reason: changesByReason,
            legacy_total: rows.reduce((sum, row) => sum + row.legacy_count, 0),
            canonical_total: rows.reduce((sum, row) => sum + row.canonical_count, 0),
        },
    };
}

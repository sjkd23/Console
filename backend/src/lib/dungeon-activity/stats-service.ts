import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { ActivityRoleSchema, type ActivityRole } from './legacy-classification.js';

type StatsDb = Pick<typeof pool, 'query'>;

const CanonicalActivityRowSchema = z.object({
    user_id: z.union([z.string(), z.number(), z.bigint()]).transform(String),
    role: ActivityRoleSchema,
    dungeon_stats_key: z.string().min(1),
    count: z.coerce.number().int().nonnegative(),
});

export interface CanonicalActivityFilters {
    guildId: string;
    userId?: string;
    role?: ActivityRole;
    dungeonStatsKey?: string;
    since?: Date;
    until?: Date;
}

export interface CanonicalActivityRow {
    user_id: string;
    role: ActivityRole;
    dungeon_stats_key: string;
    count: number;
}

interface ProjectionSql {
    ctes: string;
    params: readonly unknown[];
}

/**
 * One canonical projection used by every activity reader:
 * positive facts + signed corrections, grouped by dungeon, then floored at 0.
 * The floor prevents impossible visible totals without rewriting audit history.
 */
function buildCanonicalProjection(filters: CanonicalActivityFilters): ProjectionSql {
    const params: unknown[] = [filters.guildId];
    const eventConditions = ['guild_id = $1::bigint'];
    const adjustmentConditions = ['guild_id = $1::bigint'];

    const addFilter = (eventColumn: string, adjustmentColumn: string, value: unknown): void => {
        params.push(value);
        const placeholder = `$${params.length}`;
        eventConditions.push(`${eventColumn} = ${placeholder}`);
        adjustmentConditions.push(`${adjustmentColumn} = ${placeholder}`);
    };
    if (filters.userId) addFilter('user_id', 'user_id', filters.userId);
    if (filters.role) addFilter('role', 'role', filters.role);
    if (filters.dungeonStatsKey) addFilter('dungeon_stats_key', 'dungeon_stats_key', filters.dungeonStatsKey);
    if (filters.since) {
        params.push(filters.since.toISOString());
        const placeholder = `$${params.length}`;
        eventConditions.push(`occurred_at >= ${placeholder}::timestamptz`);
        adjustmentConditions.push(`occurred_at >= ${placeholder}::timestamptz`);
    }
    if (filters.until) {
        params.push(filters.until.toISOString());
        const placeholder = `$${params.length}`;
        eventConditions.push(`occurred_at <= ${placeholder}::timestamptz`);
        adjustmentConditions.push(`occurred_at <= ${placeholder}::timestamptz`);
    }

    return {
        params,
        ctes: `WITH activity_contribution AS (
                   SELECT user_id, role, dungeon_stats_key, count::bigint AS amount
                   FROM dungeon_activity_event
                   WHERE ${eventConditions.join(' AND ')}
                   UNION ALL
                   SELECT user_id, role, dungeon_stats_key, delta::bigint AS amount
                   FROM dungeon_activity_adjustment
                   WHERE ${adjustmentConditions.join(' AND ')}
               ), canonical_dungeon_activity AS (
                   SELECT user_id, role, dungeon_stats_key,
                          GREATEST(SUM(amount), 0)::bigint AS count
                   FROM activity_contribution
                   GROUP BY user_id, role, dungeon_stats_key
               )`,
    };
}

export async function getCanonicalActivityRows(
    filters: CanonicalActivityFilters,
    db: StatsDb = pool
): Promise<CanonicalActivityRow[]> {
    const projection = buildCanonicalProjection(filters);
    const result = await db.query<QueryResultRow>(
        `${projection.ctes}
         SELECT user_id::text, role, dungeon_stats_key, count::text
         FROM canonical_dungeon_activity
         WHERE count > 0
         ORDER BY user_id, role, dungeon_stats_key`,
        [...projection.params]
    );
    return result.rows.map(row => CanonicalActivityRowSchema.parse(row));
}

export async function getCanonicalActivityLeaderboard(
    filters: CanonicalActivityFilters,
    db: StatsDb = pool
): Promise<Array<{ user_id: string; count: number }>> {
    if (!filters.role) throw new Error('Canonical activity leaderboard requires a role');
    const projection = buildCanonicalProjection(filters);
    const result = await db.query<QueryResultRow>(
        `${projection.ctes}
         SELECT user_id::text, SUM(count)::text AS count
         FROM canonical_dungeon_activity
         GROUP BY user_id
         HAVING SUM(count) > 0
         ORDER BY SUM(count) DESC, user_id ASC`,
        [...projection.params]
    );
    return result.rows.map(row => ({
        user_id: String(row.user_id),
        count: z.coerce.number().int().nonnegative().parse(row.count),
    }));
}

export function summarizeCanonicalActivity(rows: readonly CanonicalActivityRow[]): {
    total_runs_organized: number;
    total_dungeons_completed: number;
    dungeons: Map<string, { completed: number; organized: number }>;
} {
    let totalRunsOrganized = 0;
    let totalDungeonsCompleted = 0;
    const dungeons = new Map<string, { completed: number; organized: number }>();
    for (const row of rows) {
        const current = dungeons.get(row.dungeon_stats_key) ?? { completed: 0, organized: 0 };
        if (row.role === 'organizer') {
            current.organized += row.count;
            totalRunsOrganized += row.count;
        } else {
            current.completed += row.count;
            totalDungeonsCompleted += row.count;
        }
        dungeons.set(row.dungeon_stats_key, current);
    }
    return {
        total_runs_organized: totalRunsOrganized,
        total_dungeons_completed: totalDungeonsCompleted,
        dungeons,
    };
}

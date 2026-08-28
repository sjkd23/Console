import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { withTransaction } from '../database/transaction.js';
import { createLogger } from '../logging/logger.js';
import {
    calculateQuotaResult,
} from './quota-period-accounting.js';

export { calculateQuotaResult } from './quota-period-accounting.js';

const logger = createLogger('QuotaPeriodService');
export const QUOTA_CATCH_UP_BATCH_SIZE = 10;
export const QUOTA_LOG_RETRY_BATCH_SIZE = 10;

export type QuotaPeriodCloseReason = 'scheduled' | 'manual' | 'config_deleted' | 'role_deleted' | 'deactivated';

export interface QuotaPeriodMemberResult {
    user_id: string;
    earned_points: number;
    carry_in: number;
    effective_total: number;
    met_quota: boolean;
    carry_out: number;
    result_source: string;
}

export interface QuotaPeriod {
    id: string;
    guild_id: string;
    quota_role_id: string;
    starts_at: string;
    ends_at: string;
    required_points: number;
    rollover_enabled: boolean;
    predecessor_period_id: string | null;
    status: 'active' | 'finalized';
    close_reason: QuotaPeriodCloseReason | null;
    roster_complete: boolean;
    created_at: string;
    finalized_at: string | null;
    quota_log_posted_at: string | null;
    results: QuotaPeriodMemberResult[];
}

export interface QuotaPeriodScanItem {
    guild_id: string;
    quota_role_id: string;
    reset_interval_days: number;
    active_period: QuotaPeriod;
    due: boolean;
}

export interface PeriodProcessingResult {
    periods: QuotaPeriod[];
    remaining_due: boolean;
}

interface PeriodRow {
    id: string;
    guild_id: string;
    quota_role_id: string;
    starts_at: string;
    ends_at: string;
    required_points: string;
    rollover_enabled: boolean;
    predecessor_period_id: string | null;
    status: 'active' | 'finalized';
    close_reason: QuotaPeriodCloseReason | null;
    roster_complete: boolean;
    created_at: string;
    finalized_at: string | null;
    quota_log_posted_at: string | null;
}

interface ConfigRow {
    required_points: string;
    reset_interval_days: number;
    rollover_enabled: boolean;
}

interface FinalizeOptions {
    guildId: string;
    roleId: string;
    closeReason: QuotaPeriodCloseReason;
    liveMemberIds?: string[];
    includeLiveRoster: boolean;
    forceClose: boolean;
    createSuccessor: boolean;
    deleteConfig: boolean;
    allowInactiveConfig?: boolean;
}

function mapPeriod(row: PeriodRow, results: QuotaPeriodMemberResult[] = []): QuotaPeriod {
    return {
        ...row,
        required_points: Number(row.required_points),
        results,
    };
}

async function getPeriodResults(client: PoolClient, periodId: string): Promise<QuotaPeriodMemberResult[]> {
    const result = await client.query<{
        user_id: string;
        earned_points: string;
        carry_in: string;
        effective_total: string;
        met_quota: boolean;
        carry_out: string;
        result_source: string;
    }>(
        `SELECT user_id::text,
                earned_points::text,
                carry_in::text,
                effective_total::text,
                met_quota,
                carry_out::text,
                result_source
         FROM quota_period_member_result
         WHERE period_id = $1::bigint
         ORDER BY effective_total DESC, user_id ASC`,
        [periodId]
    );

    return result.rows.map(row => ({
        user_id: row.user_id,
        earned_points: Number(row.earned_points),
        carry_in: Number(row.carry_in),
        effective_total: Number(row.effective_total),
        met_quota: row.met_quota,
        carry_out: Number(row.carry_out),
        result_source: row.result_source,
    }));
}

async function getPeriodWithResults(client: PoolClient, periodId: string): Promise<QuotaPeriod> {
    const periodResult = await client.query<PeriodRow>(
        `SELECT period.id::text, period.guild_id::text, period.quota_role_id::text,
                period.starts_at, period.ends_at, period.required_points::text,
                period.rollover_enabled, period.predecessor_period_id::text,
                period.status, period.close_reason, period.roster_complete,
                period.created_at, period.finalized_at, period.quota_log_posted_at
         FROM quota_period AS period
         WHERE period.id = $1::bigint`,
        [periodId]
    );

    if (periodResult.rows.length === 0) {
        throw new Error(`Quota period ${periodId} was not found`);
    }

    return mapPeriod(periodResult.rows[0], await getPeriodResults(client, periodId));
}

/** Must be called in the same transaction that creates or updates the config. */
export async function ensureActiveQuotaPeriod(
    client: PoolClient,
    guildId: string,
    roleId: string
): Promise<void> {
    const configResult = await client.query<ConfigRow>(
        `SELECT required_points::text, reset_interval_days, rollover_enabled
         FROM quota_role_config
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint
         FOR UPDATE`,
        [guildId, roleId]
    );

    if (configResult.rows.length === 0) {
        throw new Error('Cannot create a quota period without a quota configuration');
    }

    const config = configResult.rows[0];
    if (Number(config.required_points) <= 0) {
        return;
    }
    await client.query(
        `INSERT INTO quota_period (
             guild_id, quota_role_id, starts_at, ends_at, required_points,
             rollover_enabled, predecessor_period_id, status
         )
         SELECT $1::bigint,
                $2::bigint,
                NOW(),
                NOW() + ($4::int * INTERVAL '1 day'),
                $3,
                $5,
                NULL,
                'active'
         WHERE NOT EXISTS (
             SELECT 1 FROM quota_period
             WHERE guild_id = $1::bigint
               AND quota_role_id = $2::bigint
               AND status = 'active'
         )`,
        [guildId, roleId, config.required_points, config.reset_interval_days, config.rollover_enabled]
    );
}

export async function getActiveQuotaPeriod(guildId: string, roleId: string): Promise<QuotaPeriod | null> {
    const result = await query<PeriodRow>(
        `SELECT period.id::text, period.guild_id::text, period.quota_role_id::text,
                period.starts_at, period.ends_at, period.required_points::text,
                period.rollover_enabled, period.predecessor_period_id::text,
                period.status, period.close_reason, period.roster_complete,
                period.created_at, period.finalized_at, period.quota_log_posted_at
         FROM quota_period AS period
         JOIN quota_role_config AS config
           ON config.guild_id = period.guild_id
          AND config.discord_role_id = period.quota_role_id
         WHERE period.guild_id = $1::bigint
           AND period.quota_role_id = $2::bigint
           AND period.status = 'active'
           AND config.required_points > 0`,
        [guildId, roleId]
    );

    return result.rows.length === 0 ? null : mapPeriod(result.rows[0]);
}

export async function getQuotaPeriodScanItems(): Promise<QuotaPeriodScanItem[]> {
    const result = await query<PeriodRow & { reset_interval_days: number; due: boolean }>(
        `SELECT period.id::text,
                period.guild_id::text,
                period.quota_role_id::text,
                period.starts_at,
                period.ends_at,
                period.required_points::text,
                period.rollover_enabled,
                period.predecessor_period_id::text,
                period.status,
                period.close_reason,
                period.roster_complete,
                period.created_at,
                period.finalized_at,
                period.quota_log_posted_at,
                config.reset_interval_days,
                period.ends_at <= NOW() AS due
         FROM quota_role_config AS config
         JOIN quota_period AS period
           ON period.guild_id = config.guild_id
          AND period.quota_role_id = config.discord_role_id
          AND period.status = 'active'
         WHERE config.required_points > 0
         ORDER BY period.ends_at ASC`
    );

    return result.rows.map(row => ({
        guild_id: row.guild_id,
        quota_role_id: row.quota_role_id,
        reset_interval_days: row.reset_interval_days,
        active_period: mapPeriod(row),
        due: row.due,
    }));
}

async function finalizeSingleBoundaryInTransaction(
    client: PoolClient,
    options: FinalizeOptions
): Promise<QuotaPeriod | null> {
        const configResult = await client.query<ConfigRow>(
            `SELECT required_points::text, reset_interval_days, rollover_enabled
             FROM quota_role_config
             WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint
             FOR UPDATE`,
            [options.guildId, options.roleId]
        );

        if (configResult.rows.length === 0) {
            return null;
        }

        const config = configResult.rows[0];
        if (Number(config.required_points) <= 0 && !options.allowInactiveConfig) {
            return null;
        }

        const periodResult = await client.query<PeriodRow>(
            `SELECT id::text, guild_id::text, quota_role_id::text, starts_at, ends_at,
                    required_points::text, rollover_enabled, predecessor_period_id::text,
                    status, close_reason, roster_complete, created_at, finalized_at,
                    quota_log_posted_at
             FROM quota_period
             WHERE guild_id = $1::bigint
               AND quota_role_id = $2::bigint
               AND status = 'active'
             FOR UPDATE`,
            [options.guildId, options.roleId]
        );

        if (periodResult.rows.length === 0) {
            if (options.deleteConfig) {
                await client.query(
                    `DELETE FROM quota_role_config
                     WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint`,
                    [options.guildId, options.roleId]
                );
            }
            return null;
        }

        let period = periodResult.rows[0];
        const nowResult = await client.query<{ now: string }>('SELECT NOW() AS now');
        const now = new Date(nowResult.rows[0].now);

        if (!options.forceClose && new Date(period.ends_at) > now) {
            return null;
        }

        if (options.forceClose && new Date(period.ends_at) > now) {
            const shortened = await client.query<PeriodRow>(
                `UPDATE quota_period
                 SET ends_at = NOW()
                 WHERE id = $1::bigint
                   AND status = 'active'
                   AND starts_at < NOW()
                 RETURNING id::text, guild_id::text, quota_role_id::text, starts_at, ends_at,
                           required_points::text, rollover_enabled, predecessor_period_id::text,
                           status, close_reason, roster_complete, created_at, finalized_at,
                           quota_log_posted_at`,
                [period.id]
            );

            if (shortened.rows.length === 0) {
                throw new Error('Quota period cannot be closed at or before its start boundary');
            }
            period = shortened.rows[0];
        }

        const earnedResult = await client.query<{ user_id: string; earned_points: string }>(
            `SELECT actor_user_id::text AS user_id,
                    COALESCE(SUM(quota_points), 0)::text AS earned_points
             FROM quota_event
             WHERE guild_id = $1::bigint
               AND quota_role_id = $2::bigint
               AND created_at >= $3::timestamptz
               AND created_at < $4::timestamptz
             GROUP BY actor_user_id`,
            [options.guildId, options.roleId, period.starts_at, period.ends_at]
        );

        const carryResult = period.predecessor_period_id
            ? await client.query<{ user_id: string; carry_out: string }>(
                `SELECT user_id::text, carry_out::text
                 FROM quota_period_member_result
                 WHERE period_id = $1::bigint AND carry_out > 0`,
                [period.predecessor_period_id]
            )
            : { rows: [] as Array<{ user_id: string; carry_out: string }> };

        const earnedByUser = new Map(earnedResult.rows.map(row => [row.user_id, Number(row.earned_points)]));
        const carryByUser = new Map(carryResult.rows.map(row => [row.user_id, Number(row.carry_out)]));
        const liveMembers = new Set(options.includeLiveRoster ? (options.liveMemberIds ?? []) : []);
        const userIds = new Set<string>([
            ...earnedByUser.keys(),
            ...carryByUser.keys(),
            ...liveMembers,
        ]);

        for (const userId of userIds) {
            const earnedPoints = earnedByUser.get(userId) ?? 0;
            const carryIn = carryByUser.get(userId) ?? 0;
            const calculated = calculateQuotaResult(
                earnedPoints,
                carryIn,
                Number(period.required_points),
                period.rollover_enabled
            );
            const sources = [
                liveMembers.has(userId) ? 'live_roster' : null,
                earnedByUser.has(userId) ? 'activity' : null,
                carryByUser.has(userId) ? 'carry' : null,
            ].filter((source): source is string => source !== null);

            await client.query(
                `INSERT INTO quota_period_member_result (
                     period_id, user_id, earned_points, carry_in, effective_total,
                     met_quota, carry_out, result_source
                 )
                 VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (period_id, user_id) DO NOTHING`,
                [
                    period.id,
                    userId,
                    earnedPoints,
                    carryIn,
                    calculated.effectiveTotal,
                    calculated.metQuota,
                    calculated.carryOut,
                    sources.join('+') || 'unknown',
                ]
            );
        }

        const finalized = await client.query<{ id: string }>(
            `UPDATE quota_period
             SET status = 'finalized',
                 close_reason = $2,
                 roster_complete = $3,
                 finalized_at = NOW()
             WHERE id = $1::bigint AND status = 'active'
             RETURNING id::text`,
            [period.id, options.closeReason, options.includeLiveRoster]
        );

        if (finalized.rows.length === 0) {
            return getPeriodWithResults(client, period.id);
        }

        if (options.createSuccessor) {
            if (Number(config.required_points) > 0) {
                await client.query(
                `INSERT INTO quota_period (
                     guild_id, quota_role_id, starts_at, ends_at, required_points,
                     rollover_enabled, predecessor_period_id, status
                 )
                 VALUES (
                     $1::bigint,
                     $2::bigint,
                     $3::timestamptz,
                     $3::timestamptz + ($5::int * INTERVAL '1 day'),
                     $4,
                     $6,
                     $7::bigint,
                     'active'
                 )
                 ON CONFLICT (predecessor_period_id) WHERE predecessor_period_id IS NOT NULL
                 DO NOTHING`,
                [
                    options.guildId,
                    options.roleId,
                    period.ends_at,
                    config.required_points,
                    config.reset_interval_days,
                    config.rollover_enabled,
                    period.id,
                ]
                );
            }
        }

        if (options.deleteConfig) {
            await client.query(
                `DELETE FROM quota_role_config
                 WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint`,
                [options.guildId, options.roleId]
            );
        }

        return getPeriodWithResults(client, period.id);
}

async function finalizeSingleBoundary(options: FinalizeOptions): Promise<QuotaPeriod | null> {
    return withTransaction(client => finalizeSingleBoundaryInTransaction(client, options));
}

/** Atomically close a positive period when its config is changed to inactive. */
export async function deactivateQuotaAutomationInTransaction(
    client: PoolClient,
    guildId: string,
    roleId: string,
    liveMemberIds?: string[]
): Promise<QuotaPeriod | null> {
    return finalizeSingleBoundaryInTransaction(client, {
        guildId,
        roleId,
        closeReason: 'deactivated',
        liveMemberIds,
        includeLiveRoster: liveMemberIds !== undefined,
        forceClose: true,
        createSuccessor: false,
        deleteConfig: false,
        allowInactiveConfig: true,
    });
}

async function hasDuePeriod(guildId: string, roleId: string): Promise<boolean> {
    const result = await query(
        `SELECT 1
         FROM quota_period AS period
         JOIN quota_role_config AS config
           ON config.guild_id = period.guild_id
          AND config.discord_role_id = period.quota_role_id
         WHERE period.guild_id = $1::bigint
           AND period.quota_role_id = $2::bigint
           AND period.status = 'active'
           AND period.ends_at <= NOW()
           AND config.required_points > 0`,
        [guildId, roleId]
    );
    return (result.rowCount ?? 0) > 0;
}

export async function finalizeDueQuotaPeriods(
    guildId: string,
    roleId: string,
    liveMemberIds: string[],
    maxPeriods = QUOTA_CATCH_UP_BATCH_SIZE
): Promise<PeriodProcessingResult> {
    const periods: QuotaPeriod[] = [];

    for (let index = 0; index < maxPeriods; index += 1) {
        const activeState = await query<{ include_live_roster: boolean }>(
            `SELECT period.ends_at + (config.reset_interval_days * INTERVAL '1 day') > NOW()
                    AS include_live_roster
             FROM quota_period AS period
             JOIN quota_role_config AS config
               ON config.guild_id = period.guild_id
              AND config.discord_role_id = period.quota_role_id
             WHERE period.guild_id = $1::bigint
               AND period.quota_role_id = $2::bigint
               AND period.status = 'active'
               AND period.ends_at <= NOW()
               AND config.required_points > 0`,
            [guildId, roleId]
        );

        if (activeState.rows.length === 0) break;

        const includeLiveRoster = activeState.rows[0].include_live_roster;
        const finalized = await finalizeSingleBoundary({
            guildId,
            roleId,
            closeReason: 'scheduled',
            liveMemberIds,
            includeLiveRoster,
            forceClose: false,
            createSuccessor: true,
            deleteConfig: false,
        });
        if (!finalized) break;
        periods.push(finalized);
    }

    return { periods, remaining_due: await hasDuePeriod(guildId, roleId) };
}

export async function manuallyResetQuotaPeriod(
    guildId: string,
    roleId: string,
    liveMemberIds: string[]
): Promise<PeriodProcessingResult & { caught_up_count: number }> {
    const periods: QuotaPeriod[] = [];
    let safetyCounter = 0;

    while (await hasDuePeriod(guildId, roleId)) {
        if (safetyCounter >= 10_000) throw new Error('Quota catch-up safety limit exceeded');
        const finalized = await finalizeSingleBoundary({
            guildId,
            roleId,
            closeReason: 'scheduled',
            includeLiveRoster: false,
            forceClose: false,
            createSuccessor: true,
            deleteConfig: false,
        });
        if (!finalized) break;
        periods.push(finalized);
        safetyCounter += 1;
    }

    const caughtUpCount = periods.length;
    const current = await finalizeSingleBoundary({
        guildId,
        roleId,
        closeReason: 'manual',
        liveMemberIds,
        includeLiveRoster: true,
        forceClose: true,
        createSuccessor: true,
        deleteConfig: false,
    });
    if (current) periods.push(current);

    return { periods, remaining_due: await hasDuePeriod(guildId, roleId), caught_up_count: caughtUpCount };
}

export async function closeAndDeleteQuotaConfig(
    guildId: string,
    roleId: string,
    reason: 'config_deleted' | 'role_deleted',
    liveMemberIds?: string[]
): Promise<PeriodProcessingResult> {
    const periods: QuotaPeriod[] = [];
    let safetyCounter = 0;

    while (await hasDuePeriod(guildId, roleId)) {
        if (safetyCounter >= 10_000) throw new Error('Quota catch-up safety limit exceeded');
        const finalized = await finalizeSingleBoundary({
            guildId,
            roleId,
            closeReason: 'scheduled',
            includeLiveRoster: false,
            forceClose: false,
            createSuccessor: true,
            deleteConfig: false,
        });
        if (!finalized) break;
        periods.push(finalized);
        safetyCounter += 1;
    }

    const current = await finalizeSingleBoundary({
        guildId,
        roleId,
        closeReason: reason,
        liveMemberIds,
        includeLiveRoster: liveMemberIds !== undefined,
        forceClose: true,
        createSuccessor: false,
        deleteConfig: true,
        allowInactiveConfig: true,
    });
    if (current) periods.push(current);

    logger.info({ guildId, roleId, reason, finalizedPeriods: periods.length }, 'Closed quota chain and deleted config');
    return { periods, remaining_due: false };
}

export async function getUnpostedFinalizedQuotaPeriods(
    limit = QUOTA_LOG_RETRY_BATCH_SIZE
): Promise<QuotaPeriod[]> {
    return withTransaction(async client => {
        const result = await client.query<{ id: string }>(
            `SELECT id::text
             FROM quota_period
             WHERE status = 'finalized'
               AND quota_log_posted_at IS NULL
               AND required_points > 0
             ORDER BY quota_log_last_attempt_at ASC NULLS FIRST, finalized_at ASC
             LIMIT $1`,
            [limit]
        );

        const periods: QuotaPeriod[] = [];
        for (const row of result.rows) {
            periods.push(await getPeriodWithResults(client, row.id));
        }
        return periods;
    });
}

export async function getQuotaPeriodHistory(
    guildId: string,
    roleId: string,
    limit = 50
): Promise<QuotaPeriod[]> {
    return withTransaction(async client => {
        const result = await client.query<{ id: string }>(
            `SELECT id::text
             FROM quota_period
             WHERE guild_id = $1::bigint
               AND quota_role_id = $2::bigint
               AND status = 'finalized'
             ORDER BY ends_at DESC
             LIMIT $3`,
            [guildId, roleId, limit]
        );
        const periods: QuotaPeriod[] = [];
        for (const row of result.rows) periods.push(await getPeriodWithResults(client, row.id));
        return periods;
    });
}

export async function markQuotaLogAttempt(periodId: string, posted: boolean): Promise<boolean> {
    const result = await query(
        `UPDATE quota_period
         SET quota_log_last_attempt_at = NOW(),
             quota_log_posted_at = CASE WHEN $2 THEN COALESCE(quota_log_posted_at, NOW()) ELSE quota_log_posted_at END
         WHERE id = $1::bigint
           AND status = 'finalized'`,
        [periodId, posted]
    );
    return (result.rowCount ?? 0) > 0;
}

export async function getActiveQuotaLeaderboard(
    guildId: string,
    roleId: string,
    memberUserIds: string[]
): Promise<{
    period: QuotaPeriod;
    leaderboard: Array<{
        user_id: string;
        earned_points: number;
        carry_in: number;
        effective_total: number;
        runs: number;
    }>;
}> {
    const period = await getActiveQuotaPeriod(guildId, roleId);
    if (!period) throw new Error('No active quota period found');

    const result = await query<{
        user_id: string;
        earned_points: string;
        carry_in: string;
        effective_total: string;
        runs: string;
    }>(
        `WITH eligible_users AS (
             SELECT UNNEST($3::bigint[]) AS user_id
             UNION
             SELECT member_result.user_id
             FROM quota_period_member_result AS member_result
             WHERE member_result.period_id = $4::bigint
               AND member_result.carry_out > 0
         ),
         earned AS (
             SELECT event.actor_user_id AS user_id,
                    COALESCE(SUM(event.quota_points), 0) AS earned_points,
                    COALESCE(SUM(
                        CASE
                            WHEN event.action_type = 'run_completed'
                             AND event.quota_points != 0
                             AND event.subject_id LIKE 'manual_log_run:%'
                            THEN split_part(event.subject_id, ':', 4)::int * SIGN(event.quota_points)
                            WHEN event.action_type = 'run_completed' AND event.quota_points != 0
                            THEN SIGN(event.quota_points)
                            ELSE 0
                        END
                    ), 0) AS runs
             FROM quota_event AS event
             WHERE event.guild_id = $1::bigint
               AND event.quota_role_id = $2::bigint
               AND event.created_at >= $5::timestamptz
               AND event.created_at < $6::timestamptz
             GROUP BY event.actor_user_id
         ),
         carry AS (
             SELECT user_id, carry_out AS carry_in
             FROM quota_period_member_result
             WHERE period_id = $4::bigint
         )
         SELECT users.user_id::text,
                COALESCE(earned.earned_points, 0)::text AS earned_points,
                COALESCE(carry.carry_in, 0)::text AS carry_in,
                (COALESCE(earned.earned_points, 0) + COALESCE(carry.carry_in, 0))::text AS effective_total,
                COALESCE(earned.runs, 0)::text AS runs
         FROM eligible_users AS users
         LEFT JOIN earned ON earned.user_id = users.user_id
         LEFT JOIN carry ON carry.user_id = users.user_id
         ORDER BY COALESCE(earned.earned_points, 0) DESC,
                  COALESCE(earned.runs, 0) DESC,
                  users.user_id ASC
         LIMIT 50`,
        [
            guildId,
            roleId,
            memberUserIds,
            period.predecessor_period_id,
            period.starts_at,
            period.ends_at,
        ]
    );

    return {
        period,
        leaderboard: result.rows.map(row => ({
            user_id: row.user_id,
            earned_points: Number(row.earned_points),
            carry_in: Number(row.carry_in),
            effective_total: Number(row.effective_total),
            runs: Number(row.runs),
        })),
    };
}

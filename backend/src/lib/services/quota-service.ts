/**
 * QuotaService - Centralized quota/points awarding logic
 * 
 * This service encapsulates all quota and points awarding rules in one place:
 * - Organizer quota points (for organizing runs)
 * - Raider points (for completing runs via snapshot or participant list)
 * 
 * All methods support both standalone and transactional usage via optional PoolClient.
 * External behavior (point values, rules, table writes) is preserved exactly from the original implementation.
 */

import { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('QuotaService');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Base context for quota operations
 */
export interface QuotaContext {
    guildId: string;
    dungeonKey: string;
    runId: number;
}

/**
 * Input for awarding organizer quota points
 */
export interface OrganizerQuotaInput extends QuotaContext {
    organizerDiscordId: string;
    organizerRoles?: string[]; // For dungeon point overrides lookup
    organizerRolePositions?: Record<string, number>; // Discord role positions for failsafe
    keyPopNumber?: number; // Optional: for awarding per key pop in chains
}

/**
 * Input for awarding raider points from participant list (no snapshot)
 */
export interface RaiderQuotaInput extends QuotaContext {
    // No additional fields needed - will query joined users from reaction table
}

/**
 * Input for awarding raider points from key pop snapshot
 */
export interface KeyPopQuotaInput extends QuotaContext {
    keyPopNumber: number;
}

// ============================================================================
// QUOTA SERVICE
// ============================================================================

export class QuotaService {
    /**
     * Award organizer quota points for completing a run.
     * 
     * This logs a quota event with quota_points based on dungeon configuration.
     * Uses idempotency key to prevent double-awarding if called multiple times.
     * 
     * @param input - Organizer quota parameters
     * @param client - Optional transaction client for atomic operations
     * @returns Number of quota points awarded (0 if duplicate/idempotent no-op)
     */
    async awardOrganizerQuota(
        input: OrganizerQuotaInput,
        client?: PoolClient
    ): Promise<number> {
        const db = client || pool;

        // Step 1: Determine which quota role should award points
        const { getQuotaRoleForDungeon } = await import('../quota/quota.js');
        const quotaRole = await getQuotaRoleForDungeon(
            input.guildId,
            input.dungeonKey,
            input.organizerRoles || [],
            input.organizerRolePositions
        );

        if (!quotaRole || quotaRole.points === 0) {
            logger.debug({ 
                runId: input.runId, 
                guildId: input.guildId, 
                organizerId: input.organizerDiscordId,
                dungeonKey: input.dungeonKey
            }, 'No quota role awards points for this dungeon');
            return 0;
        }

        // Step 2: Log quota event with idempotency
        // Use key pop number in idempotency key if provided (for chain tracking)
        const idempotencyKey = input.keyPopNumber 
            ? `run:${input.runId}:keypop:${input.keyPopNumber}` 
            : `run:${input.runId}`;
        
        const res = await db.query<{ id: number; quota_points: string }>(
            `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points, quota_role_id)
             VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, 0, $5, $6::bigint)
             ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
             DO NOTHING
             RETURNING id, quota_points`,
            [
                input.guildId,
                input.organizerDiscordId,
                idempotencyKey,
                input.dungeonKey,
                quotaRole.points,
                quotaRole.roleId,
            ]
        );

        if (res.rowCount === 0) {
            logger.debug({ runId: input.runId, guildId: input.guildId, keyPopNumber: input.keyPopNumber }, 
                'Organizer quota event already logged (idempotent no-op)');
            return 0;
        }

        const quotaPoints = Number(res.rows[0].quota_points);
        logger.info({ 
            runId: input.runId, 
            guildId: input.guildId, 
            organizerId: input.organizerDiscordId,
            dungeonKey: input.dungeonKey,
            keyPopNumber: input.keyPopNumber,
            quotaPoints,
            quotaRoleId: quotaRole.roleId
        }, 'Awarded organizer quota points');

        return quotaPoints;
    }

    /**
     * Award raider points from a key pop snapshot.
     * 
     * This awards points to all raiders captured in the snapshot who haven't been awarded yet.
     * Marks snapshot entries as awarded to prevent double-awarding.
     * 
     * @param input - Key pop quota parameters
     * @param client - Optional transaction client for atomic operations
     * @returns Number of raiders awarded points
     */
    async awardRaidersQuotaFromSnapshot(
        input: KeyPopQuotaInput,
        client?: PoolClient
    ): Promise<number> {
        const db = client || pool;

        // Step 1: Get raider points configuration for this dungeon
        const raiderPoints = await this.getRaiderPointsForDungeon(
            input.guildId,
            input.dungeonKey,
            db
        );

        // If points are 0 (default/not configured), skip awarding
        if (raiderPoints === 0) {
            logger.debug({ 
                runId: input.runId, 
                keyPopNumber: input.keyPopNumber, 
                dungeonKey: input.dungeonKey, 
                guildId: input.guildId 
            }, 'Skipping raider points - dungeon has 0 points configured');
            return 0;
        }

        // Step 2: Get all raiders from this snapshot who haven't been awarded yet
        const raiders = await db.query<{ user_id: string }>(
            `SELECT user_id
             FROM key_pop_snapshot
             WHERE run_id = $1::bigint 
               AND key_pop_number = $2
               AND awarded_completion = FALSE`,
            [input.runId, input.keyPopNumber]
        );

        if (raiders.rowCount === 0) {
            logger.debug({ 
                runId: input.runId, 
                keyPopNumber: input.keyPopNumber, 
                guildId: input.guildId 
            }, 'No raiders to award points from snapshot');
            return 0;
        }

        // Step 3: Award points to each raider
        let awardedCount = 0;
        for (const raider of raiders.rows) {
            try {
                // Use subject_id for idempotency (prevents double-awarding)
                const event = await db.query<{ id: number }>(
                    `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                     VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                     ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
                     DO NOTHING
                     RETURNING id`,
                    [
                        input.guildId,
                        raider.user_id,
                        `raider:${input.runId}:${input.keyPopNumber}:${raider.user_id}`, // Idempotency key
                        input.dungeonKey,
                        raiderPoints,
                    ]
                );

                if (event.rowCount && event.rowCount > 0) {
                    // Mark as awarded in snapshot
                    await db.query(
                        `UPDATE key_pop_snapshot
                         SET awarded_completion = TRUE, awarded_at = NOW()
                         WHERE run_id = $1::bigint AND key_pop_number = $2 AND user_id = $3::bigint`,
                        [input.runId, input.keyPopNumber, raider.user_id]
                    );
                    awardedCount++;
                }
            } catch (err) {
                logger.error({ 
                    err, 
                    userId: raider.user_id, 
                    runId: input.runId, 
                    keyPopNumber: input.keyPopNumber, 
                    guildId: input.guildId 
                }, 'Failed to award completion to raider from snapshot');
                throw err; // Re-throw to trigger rollback if in transaction
            }
        }

        logger.info({ 
            runId: input.runId, 
            keyPopNumber: input.keyPopNumber, 
            dungeonKey: input.dungeonKey, 
            guildId: input.guildId, 
            raiderPoints, 
            awardedCount, 
            totalRaiders: raiders.rowCount 
        }, 'Awarded completions to key pop snapshot');

        return awardedCount;
    }

    /**
     * Award raider points to all joined participants.
     * 
     * This is the fallback behavior when no key pops occurred.
     * Awards points to all users who joined the run (state='join').
     * 
     * @param input - Raider quota parameters
     * @param client - Optional transaction client for atomic operations
     * @returns Number of raiders awarded points
     */
    async awardRaidersQuotaFromParticipants(
        input: RaiderQuotaInput,
        client?: PoolClient
    ): Promise<number> {
        const db = client || pool;

        // Step 1: Get raider points configuration for this dungeon
        const raiderPoints = await this.getRaiderPointsForDungeon(
            input.guildId,
            input.dungeonKey,
            db
        );

        // If points are 0 (default/not configured), skip awarding
        if (raiderPoints === 0) {
            logger.debug({ 
                runId: input.runId, 
                dungeonKey: input.dungeonKey, 
                guildId: input.guildId 
            }, 'Skipping raider points - dungeon has 0 points configured');
            return 0;
        }

        // Step 2: Get all raiders who joined this run
        const raiders = await db.query<{ user_id: string }>(
            `SELECT DISTINCT user_id
             FROM reaction
             WHERE run_id = $1::bigint AND state = 'join'`,
            [input.runId]
        );

        if (raiders.rowCount === 0) {
            logger.debug({ runId: input.runId, guildId: input.guildId }, 
                'No raiders to award points');
            return 0;
        }

        // Step 3: Award points to each raider
        let awardedCount = 0;
        for (const raider of raiders.rows) {
            try {
                // Use subject_id for idempotency (prevents double-awarding)
                const event = await db.query<{ id: number }>(
                    `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                     VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                     ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
                     DO NOTHING
                     RETURNING id`,
                    [
                        input.guildId,
                        raider.user_id,
                        `raider:${input.runId}:${raider.user_id}`, // Idempotency key
                        input.dungeonKey,
                        raiderPoints,
                    ]
                );

                if (event.rowCount && event.rowCount > 0) {
                    awardedCount++;
                }
            } catch (err) {
                logger.error({ 
                    err, 
                    userId: raider.user_id, 
                    runId: input.runId, 
                    guildId: input.guildId 
                }, 'Failed to award points to raider');
                throw err; // Re-throw to trigger rollback if in transaction
            }
        }

        logger.info({ 
            runId: input.runId, 
            dungeonKey: input.dungeonKey, 
            guildId: input.guildId, 
            raiderPoints, 
            awardedCount, 
            totalRaiders: raiders.rowCount 
        }, 'Awarded raider points to all joined participants');

        return awardedCount;
    }

    // ========================================================================
    // PRIVATE HELPERS (copied from quota.ts to keep service self-contained)
    // ========================================================================

    /**
     * Get the point value for a specific dungeon considering all of the user's roles.
     * Returns the HIGHEST point value found across all the user's roles that have quota configs.
     * Priority: dungeon override > base exalt/non-exalt points > default 1
     * 
     * This is a copy of getPointsForDungeon from quota.ts, kept here to encapsulate
     * all quota logic in one place.
     */
    private async getPointsForDungeon(
        guildId: string,
        dungeonKey: string,
        userRoleIds?: string[],
        db: PoolClient | typeof pool = pool
    ): Promise<number> {
        const { isExaltDungeon } = await import('../../config/raid-config.js');
        const isExalt = isExaltDungeon(dungeonKey);

        // If no user roles provided, check across ALL quota configs in the guild
        if (!userRoleIds || userRoleIds.length === 0) {
            // First try to find a dungeon-specific override
            const overrideRes = await db.query<{ points: string }>(
                `SELECT points
                 FROM quota_dungeon_override
                 WHERE guild_id = $1::bigint 
                   AND dungeon_key = $2
                 ORDER BY points DESC
                 LIMIT 1`,
                [guildId, dungeonKey]
            );

            if (overrideRes.rowCount && overrideRes.rowCount > 0) {
                const points = Number(overrideRes.rows[0].points);
                logger.debug({ guildId, dungeonKey, points }, 
                    'Found max dungeon override (no role filter)');
                return points;
            }

            // No override found, check base points from quota_role_config
            const basePointsField = isExalt ? 'base_exalt_points' : 'base_non_exalt_points';
            const baseRes = await db.query<{ points: string }>(
                `SELECT ${basePointsField} as points
                 FROM quota_role_config
                 WHERE guild_id = $1::bigint
                 ORDER BY ${basePointsField} DESC
                 LIMIT 1`,
                [guildId]
            );

            if (baseRes.rowCount && baseRes.rowCount > 0) {
                const points = Number(baseRes.rows[0].points);
                logger.debug({ guildId, dungeonKey, isExalt, points }, 
                    'Using max base points (no role filter)');
                return points;
            }

            logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 
                'No dungeon override or base points found, using default');
            return 1;
        }

        // Query all dungeon overrides for this dungeon across all the user's roles
        const overrideRes = await db.query<{ points: string }>(
            `SELECT points
             FROM quota_dungeon_override
             WHERE guild_id = $1::bigint 
               AND discord_role_id = ANY($2::bigint[])
               AND dungeon_key = $3
             ORDER BY points DESC
             LIMIT 1`,
            [guildId, userRoleIds, dungeonKey]
        );

        // If we found an override, use the highest value
        if (overrideRes.rowCount && overrideRes.rowCount > 0) {
            const points = Number(overrideRes.rows[0].points);
            logger.debug({ guildId, dungeonKey, points, rolesChecked: userRoleIds.length }, 
                'Found dungeon override');
            return points;
        }

        // No override found, check base points for the user's roles
        const basePointsField = isExalt ? 'base_exalt_points' : 'base_non_exalt_points';
        const baseRes = await db.query<{ points: string }>(
            `SELECT ${basePointsField} as points
             FROM quota_role_config
             WHERE guild_id = $1::bigint 
               AND discord_role_id = ANY($2::bigint[])
             ORDER BY ${basePointsField} DESC
             LIMIT 1`,
            [guildId, userRoleIds]
        );

        if (baseRes.rowCount && baseRes.rowCount > 0) {
            const points = Number(baseRes.rows[0].points);
            logger.debug({ guildId, dungeonKey, isExalt, points, rolesChecked: userRoleIds.length }, 
                'Using base points');
            return points;
        }

        // No override or base points found, use default
        logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 
            'No dungeon override or base points found, using default');
        return 1;
    }

    /**
     * Get raider points for a specific dungeon.
     * Returns 1 if no config exists (default is 1 point per completion).
     * 
     * This is a copy of getRaiderPointsForDungeon from quota.ts.
     */
    private async getRaiderPointsForDungeon(
        guildId: string,
        dungeonKey: string,
        db: PoolClient | typeof pool = pool
    ): Promise<number> {
        const res = await db.query<{ points: string }>(
            `SELECT points
             FROM raider_points_config
             WHERE guild_id = $1::bigint AND dungeon_key = $2`,
            [guildId, dungeonKey]
        );

        if (res.rowCount && res.rowCount > 0) {
            return Number(res.rows[0].points);
        }

        return 1; // Default: 1 point per completion
    }
}

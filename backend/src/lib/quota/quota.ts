// backend/src/lib/quota.ts
import { query } from '../../db/pool.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Quota');

/**
 * Action types for quota events.
 * Defines what activities earn quota points.
 */
export type QuotaActionType = 'run_completed' | 'verify_member';

/**
 * Default point values for each action type.
 * These are hardcoded defaults that can later be overridden by guild configuration.
 */
function getDefaultPoints(actionType: QuotaActionType): number {
    switch (actionType) {
        case 'run_completed':
            return 1;
        case 'verify_member':
            return 1;
        default:
            return 1;
    }
}

/**
 * Quota role configuration including reset time and required points
 */
export interface QuotaRoleConfig {
    guild_id: string;
    discord_role_id: string;
    required_points: number;
    reset_at: string; // ISO timestamp
    panel_message_id: string | null;
    created_at: string; // ISO timestamp - when this config was created
    moderation_points: number; // Points awarded for verification activities
}

/**
 * Per-dungeon point override
 */
export interface QuotaDungeonOverride {
    dungeon_key: string;
    points: number;
}

/**
 * Get quota configuration for a specific role in a guild
 */
export async function getQuotaRoleConfig(
    guildId: string,
    discordRoleId: string
): Promise<QuotaRoleConfig | null> {
    const res = await query<{
        guild_id: string;
        discord_role_id: string;
        required_points: string; // DECIMAL comes as string from pg
        reset_at: string;
        panel_message_id: string | null;
        created_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
    }>(
        `SELECT guild_id, discord_role_id, required_points, reset_at, panel_message_id, created_at, moderation_points
         FROM quota_role_config
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint`,
        [guildId, discordRoleId]
    );

    if ((res.rowCount ?? 0) === 0) return null;

    const row = res.rows[0];
    return {
        guild_id: row.guild_id,
        discord_role_id: row.discord_role_id,
        required_points: Number(row.required_points),
        reset_at: row.reset_at,
        panel_message_id: row.panel_message_id,
        created_at: row.created_at,
        moderation_points: Number(row.moderation_points),
    };
}

/**
 * Get all quota role configs for a guild
 */
export async function getAllQuotaRoleConfigs(
    guildId: string
): Promise<QuotaRoleConfig[]> {
    const res = await query<{
        guild_id: string;
        discord_role_id: string;
        required_points: string; // DECIMAL comes as string from pg
        reset_at: string;
        panel_message_id: string | null;
        created_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
    }>(
        `SELECT guild_id, discord_role_id, required_points, reset_at, panel_message_id, created_at, moderation_points
         FROM quota_role_config
         WHERE guild_id = $1::bigint
         ORDER BY discord_role_id`,
        [guildId]
    );

    return res.rows.map(row => ({
        guild_id: row.guild_id,
        discord_role_id: row.discord_role_id,
        required_points: Number(row.required_points),
        reset_at: row.reset_at,
        panel_message_id: row.panel_message_id,
        created_at: row.created_at,
        moderation_points: Number(row.moderation_points),
    }));
}

/**
 * Create or update quota role configuration
 */
export async function upsertQuotaRoleConfig(
    guildId: string,
    discordRoleId: string,
    config: {
        required_points?: number;
        reset_at?: string; // ISO timestamp
        panel_message_id?: string | null;
        created_at?: string; // ISO timestamp - for resetting quota periods
        moderation_points?: number; // Points awarded for verification activities
    }
): Promise<QuotaRoleConfig> {
    const fields: string[] = [];
    const values: any[] = [guildId, discordRoleId];
    let idx = 3;

    // For INSERT, we need default values
    const requiredPoints = config.required_points ?? 0;
    const resetAt = config.reset_at ?? null; // Will use COALESCE in query
    const createdAt = config.created_at ?? null; // Will use COALESCE in query
    const moderationPoints = config.moderation_points ?? 0;

    values.push(requiredPoints); // $3
    values.push(resetAt); // $4
    values.push(createdAt); // $5
    values.push(moderationPoints); // $6

    // Build UPDATE fields
    if (config.required_points !== undefined) {
        fields.push(`required_points = $${idx}`);
    }
    idx++; // Move past $3

    if (config.reset_at !== undefined) {
        fields.push(`reset_at = $${idx}::timestamptz`);
    }
    idx++; // Move past $4

    if (config.created_at !== undefined) {
        fields.push(`created_at = $${idx}::timestamptz`);
    }
    idx++; // Move past $5

    if (config.moderation_points !== undefined) {
        fields.push(`moderation_points = $${idx}`);
    }
    idx++; // Move past $6

    if (config.panel_message_id !== undefined) {
        fields.push(`panel_message_id = $${idx++}::bigint`);
        values.push(config.panel_message_id);
    }

    const updateClause = fields.length > 0 ? `, ${fields.join(', ')}` : '';

    const res = await query<{
        guild_id: string;
        discord_role_id: string;
        required_points: string; // DECIMAL comes as string from pg
        reset_at: string;
        panel_message_id: string | null;
        created_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
    }>(
        `INSERT INTO quota_role_config (guild_id, discord_role_id, required_points, reset_at, created_at, moderation_points, updated_at)
         VALUES ($1::bigint, $2::bigint, 
                 $3, 
                 COALESCE($4::timestamptz, NOW() + INTERVAL '7 days'),
                 COALESCE($5::timestamptz, NOW()),
                 $6,
                 NOW())
         ON CONFLICT (guild_id, discord_role_id)
         DO UPDATE SET updated_at = NOW() ${updateClause}
         RETURNING guild_id, discord_role_id, required_points, reset_at, panel_message_id, created_at, moderation_points`,
        values
    );

    const row = res.rows[0];
    return {
        guild_id: row.guild_id,
        discord_role_id: row.discord_role_id,
        required_points: Number(row.required_points),
        reset_at: row.reset_at,
        panel_message_id: row.panel_message_id,
        created_at: row.created_at,
        moderation_points: Number(row.moderation_points),
    };
}

/**
 * Get dungeon point overrides for a specific role
 */
export async function getDungeonOverrides(
    guildId: string,
    discordRoleId: string
): Promise<Record<string, number>> {
    const res = await query<{ dungeon_key: string; points: string }>(
        `SELECT dungeon_key, points
         FROM quota_dungeon_override
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint`,
        [guildId, discordRoleId]
    );

    const overrides: Record<string, number> = {};
    for (const row of res.rows) {
        overrides[row.dungeon_key] = Number(row.points);
    }
    return overrides;
}

/**
 * Get the point value for a specific dungeon considering all of the user's roles.
 * Returns the HIGHEST point value found across all the user's roles that have quota configs.
 * If no override exists for any role, returns the default of 1 point.
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon identifier (e.g., 'shatters', 'fungal')
 * @param userRoleIds - Array of Discord role IDs the user has (optional)
 * @returns The point value for this dungeon (highest override or default 1)
 */
export async function getPointsForDungeon(
    guildId: string,
    dungeonKey: string,
    userRoleIds?: string[]
): Promise<number> {
    // If no user roles provided, check across ALL quota configs in the guild
    // This is useful for auto-end scenarios where we don't have the organizer's current roles
    if (!userRoleIds || userRoleIds.length === 0) {
        const res = await query<{ points: string }>(
            `SELECT points
             FROM quota_dungeon_override
             WHERE guild_id = $1::bigint 
               AND dungeon_key = $2
             ORDER BY points DESC
             LIMIT 1`,
            [guildId, dungeonKey]
        );

        if (res.rowCount && res.rowCount > 0) {
            const points = Number(res.rows[0].points);
            logger.debug({ guildId, dungeonKey, points }, 'Found max dungeon override (no role filter)');
            return points;
        }

        logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 'No dungeon override found, using default');
        return 1;
    }

    // Query all dungeon overrides for this dungeon across all the user's roles
    const res = await query<{ points: string }>(
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
    if (res.rowCount && res.rowCount > 0) {
        const points = Number(res.rows[0].points);
        logger.debug({ guildId, dungeonKey, points, rolesChecked: userRoleIds.length }, 'Found dungeon override');
        return points;
    }

    // No override found, use default
    logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 'No dungeon override found, using default');
    return 1;
}

/**
 * Set dungeon point override for a specific role
 */
export async function setDungeonOverride(
    guildId: string,
    discordRoleId: string,
    dungeonKey: string,
    points: number
): Promise<void> {
    await query(
        `INSERT INTO quota_dungeon_override (guild_id, discord_role_id, dungeon_key, points, updated_at)
         VALUES ($1::bigint, $2::bigint, $3, $4, NOW())
         ON CONFLICT (guild_id, discord_role_id, dungeon_key)
         DO UPDATE SET points = EXCLUDED.points, updated_at = NOW()`,
        [guildId, discordRoleId, dungeonKey, points]
    );
}

/**
 * Delete dungeon point override (reverts to default 1 point)
 */
export async function deleteDungeonOverride(
    guildId: string,
    discordRoleId: string,
    dungeonKey: string
): Promise<void> {
    await query(
        `DELETE FROM quota_dungeon_override
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint AND dungeon_key = $3`,
        [guildId, discordRoleId, dungeonKey]
    );
}

/**
 * RAIDER POINTS CONFIGURATION
 * These functions manage guild-wide point values for raiders completing dungeons
 */

/**
 * Get all raider points configurations for a guild
 * Returns a map of dungeon_key -> points
 */
export async function getRaiderPointsConfig(
    guildId: string
): Promise<Record<string, number>> {
    const res = await query<{ dungeon_key: string; points: string }>(
        `SELECT dungeon_key, points
         FROM raider_points_config
         WHERE guild_id = $1::bigint`,
        [guildId]
    );

    const config: Record<string, number> = {};
    for (const row of res.rows) {
        config[row.dungeon_key] = Number(row.points);
    }
    return config;
}

/**
 * Get raider points for a specific dungeon
 * Returns 1 if no config exists (default is 1 point per completion)
 */
export async function getRaiderPointsForDungeon(
    guildId: string,
    dungeonKey: string
): Promise<number> {
    const res = await query<{ points: string }>(
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

/**
 * Set raider points for a specific dungeon
 */
export async function setRaiderPointsForDungeon(
    guildId: string,
    dungeonKey: string,
    points: number
): Promise<void> {
    await query(
        `INSERT INTO raider_points_config (guild_id, dungeon_key, points, updated_at)
         VALUES ($1::bigint, $2, $3, NOW())
         ON CONFLICT (guild_id, dungeon_key)
         DO UPDATE SET points = EXCLUDED.points, updated_at = NOW()`,
        [guildId, dungeonKey, points]
    );
}

/**
 * Delete raider points config for a specific dungeon (reverts to default 0 points)
 */
export async function deleteRaiderPointsForDungeon(
    guildId: string,
    dungeonKey: string
): Promise<void> {
    await query(
        `DELETE FROM raider_points_config
         WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );
}

/**
 * KEY POP POINTS CONFIGURATION
 * These functions manage guild-wide point values for raiders popping keys
 */

/**
 * Get all key pop points configurations for a guild
 * Returns a map of dungeon_key -> points
 */
export async function getKeyPopPointsConfig(
    guildId: string
): Promise<Record<string, number>> {
    const res = await query<{ dungeon_key: string; points: string }>(
        `SELECT dungeon_key, points
         FROM key_pop_points_config
         WHERE guild_id = $1::bigint`,
        [guildId]
    );

    const config: Record<string, number> = {};
    for (const row of res.rows) {
        config[row.dungeon_key] = Number(row.points);
    }
    return config;
}

/**
 * Get key pop points for a specific dungeon
 * Returns 5 if no config exists (default is 5 points per key)
 */
export async function getKeyPopPointsForDungeon(
    guildId: string,
    dungeonKey: string
): Promise<number> {
    const res = await query<{ points: string }>(
        `SELECT points
         FROM key_pop_points_config
         WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );

    if (res.rowCount && res.rowCount > 0) {
        return Number(res.rows[0].points);
    }

    return 5; // Default: 5 points per key pop
}

/**
 * Set key pop points for a specific dungeon
 */
export async function setKeyPopPointsForDungeon(
    guildId: string,
    dungeonKey: string,
    points: number
): Promise<void> {
    await query(
        `INSERT INTO key_pop_points_config (guild_id, dungeon_key, points, updated_at)
         VALUES ($1::bigint, $2, $3, NOW())
         ON CONFLICT (guild_id, dungeon_key)
         DO UPDATE SET points = EXCLUDED.points, updated_at = NOW()`,
        [guildId, dungeonKey, points]
    );
}

/**
 * Delete key pop points config for a specific dungeon (reverts to default 0 points)
 */
export async function deleteKeyPopPointsForDungeon(
    guildId: string,
    dungeonKey: string
): Promise<void> {
    await query(
        `DELETE FROM key_pop_points_config
         WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );
}

/**
 * Calculate the start of the current quota period for a given config
 * For absolute datetime: if reset hasn't happened yet, start from when config was created
 * If reset already happened, it marks the start of the last reset (previous period)
 */
export function getQuotaPeriodStart(config: QuotaRoleConfig): Date {
    const resetAt = new Date(config.reset_at);
    const createdAt = new Date(config.created_at);
    const now = new Date();

    // If reset_at is in the future, the current period started when the config was created
    if (resetAt > now) {
        return createdAt;
    }

    // If reset_at has passed, the period started at the last reset time
    return resetAt;
}

/**
 * Calculate the end of the current quota period (next reset)
 * For absolute datetime:
 * - If reset_at is in the future, return reset_at (configured end time)
 * - If reset_at has passed, return NOW (the period is ongoing until a new reset is configured)
 */
export function getQuotaPeriodEnd(config: QuotaRoleConfig): Date {
    const resetAt = new Date(config.reset_at);
    const now = new Date();

    // If reset_at is in the future, that's the end of the current period
    if (resetAt > now) {
        return resetAt;
    }

    // If reset_at has passed, the period is ongoing - return NOW as the end
    // This shows accumulated stats since the last reset
    return now;
}

/**
 * Log a quota event for a guild member.
 * This is an append-only operation that tracks points earned for actions.
 * 
 * Idempotency:
 * - For 'run_completed': Uses unique constraint on (guild_id, subject_id) to prevent double-counting
 * - For 'verify_member': No constraint, each verification is unique
 * 
 * Points vs Quota Points:
 * - points: For raiders completing/joining runs (to be implemented)
 * - quota_points: For organizers organizing runs and verifiers verifying members
 * 
 * @param guildId - Discord guild ID
 * @param actorUserId - Discord user ID who earned the points
 * @param actionType - Type of action that earned points
 * @param subjectId - Optional subject identifier for idempotency (e.g., 'run:123')
 * @param dungeonKey - Optional dungeon identifier for per-dungeon tracking (e.g., 'fungal', 'osanc')
 * @param quotaPoints - Optional point override for quota_points (defaults to action type default)
 * @returns The created quota event or null if it was a duplicate (idempotent no-op)
 */
export async function logQuotaEvent(
    guildId: string,
    actorUserId: string,
    actionType: QuotaActionType,
    subjectId?: string,
    dungeonKey?: string,
    quotaPoints?: number
): Promise<{ id: number; points: number; quota_points: number } | null> {
    const effectiveQuotaPoints = quotaPoints ?? getDefaultPoints(actionType);
    const effectivePoints = 0; // Regular points not yet implemented for raiders

    try {
        const res = await query<{ id: number; points: number; quota_points: number }>(
            `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
             VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7)
             ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
             DO NOTHING
             RETURNING id, points, quota_points`,
            [guildId, actorUserId, actionType, subjectId || null, dungeonKey || null, effectivePoints, effectiveQuotaPoints]
        );

        if (res.rowCount === 0) {
            // Duplicate event (idempotent no-op)
            logger.debug({ guildId, actorUserId, actionType, subjectId, dungeonKey }, 'Skipped duplicate quota event');
            return null;
        }

        logger.info({ guildId, actorUserId, actionType, subjectId, dungeonKey, quotaPoints: effectiveQuotaPoints }, 'Logged quota event');

        // Convert DB numeric fields to numbers (PostgreSQL returns them as strings)
        const row = res.rows[0];
        return {
            id: Number(row.id),
            points: Number(row.points),
            quota_points: Number(row.quota_points)
        };
    } catch (err) {
        logger.error({ err, guildId, actorUserId, actionType }, 'Failed to log quota event');
        throw err;
    }
}

/**
 * Award raider points to all participants when a run completes.
 * This should be called after a run status changes to 'ended'.
 * 
 * @param guildId - Discord guild ID
 * @param runId - Run ID that was completed
 * @param dungeonKey - Dungeon identifier for looking up point config
 * @returns Number of raiders who received points
 */
export async function awardRaiderPoints(
    guildId: string,
    runId: number,
    dungeonKey: string
): Promise<number> {
    // Get raider points configuration for this dungeon
    const raiderPoints = await getRaiderPointsForDungeon(guildId, dungeonKey);

    // If points are 0 (default/not configured), skip awarding points
    if (raiderPoints === 0) {
        logger.debug({ runId, dungeonKey, guildId }, 'Skipping raider points - dungeon has 0 points configured');
        return 0;
    }

    // Get all raiders who joined this run
    const raiders = await query<{ user_id: string }>(
        `SELECT DISTINCT user_id
         FROM reaction
         WHERE run_id = $1::bigint AND state = 'join'`,
        [runId]
    );

    if (raiders.rowCount === 0) {
        logger.debug({ runId, guildId }, 'No raiders to award points');
        return 0;
    }

    // Award points to each raider
    let awardedCount = 0;
    for (const raider of raiders.rows) {
        try {
            // Log quota event for the raider (using subject_id for idempotency)
            // This prevents double-awarding if the run is processed multiple times
            const event = await query<{ id: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                 ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
                 DO NOTHING
                 RETURNING id`,
                [guildId, raider.user_id, `raider:${runId}:${raider.user_id}`, dungeonKey, raiderPoints]
            );

            if (event.rowCount && event.rowCount > 0) {
                awardedCount++;
            }
        } catch (err) {
            logger.error({ err, userId: raider.user_id, runId, guildId }, 'Failed to award points to raider');
        }
    }

    logger.info({ runId, dungeonKey, guildId, raiderPoints, awardedCount, totalRaiders: raiders.rowCount }, 'Awarded raider points');
    return awardedCount;
}

/**
 * Check if a run has already been logged for quota.
 * This is used by manual logging endpoints to prevent double-counting.
 * 
 * @param guildId - Discord guild ID
 * @param runId - Run ID to check
 * @returns true if the run has already been logged, false otherwise
 */
export async function isRunAlreadyLogged(
    guildId: string,
    runId: number
): Promise<boolean> {
    const res = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND action_type = 'run_completed' 
           AND subject_id = $2`,
        [guildId, `run:${runId}`]
    );

    return Number(res.rows[0].count) > 0;
}

/**
 * Get quota statistics for a user in a guild.
 * Returns total points (raiders), total quota points (organizers/verifiers), and per-action/per-dungeon breakdowns.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @returns Quota statistics including total points, total quota points, and breakdowns
 */
export async function getUserQuotaStats(
    guildId: string,
    userId: string
): Promise<{
    total_points: number;
    total_quota_points: number;
    total_runs_organized: number;
    total_verifications: number;
    total_keys_popped: number;
    dungeons: Array<{ dungeon_key: string; completed: number; organized: number; keys_popped: number }>;
}> {
    // Get total points (raiders)
    const totalPointsRes = await query<{ total: string }>(
        `SELECT COALESCE(SUM(points), 0)::text AS total
         FROM quota_event
         WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
        [guildId, userId]
    );

    // Get total quota points (organizers/verifiers)
    const totalQuotaPointsRes = await query<{ total: string }>(
        `SELECT COALESCE(SUM(quota_points), 0)::text AS total
         FROM quota_event
         WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
        [guildId, userId]
    );

    // Get run count (organizer activities - where they earned quota_points)
    const runsRes = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND actor_user_id = $2::bigint
           AND action_type = 'run_completed'
           AND quota_points > 0`,
        [guildId, userId]
    );

    // Get verification count
    const verifRes = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND actor_user_id = $2::bigint
           AND action_type = 'verify_member'`,
        [guildId, userId]
    );

    // Get total keys popped count
    const keysRes = await query<{ total: string }>(
        `SELECT COALESCE(SUM(count), 0)::text AS total
         FROM key_pop
         WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
        [guildId, userId]
    );

    // Get per-dungeon breakdown showing completed, organized, and keys popped
    const dungeonsRes = await query<{ dungeon_key: string; completed: string; organized: string; keys_popped: string }>(
        `SELECT 
            COALESCE(qe.dungeon_key, kp.dungeon_key) AS dungeon_key,
            COALESCE(COUNT(*) FILTER (WHERE qe.points > 0), 0)::text AS completed,
            COALESCE(COUNT(*) FILTER (WHERE qe.quota_points > 0), 0)::text AS organized,
            COALESCE(MAX(kp.count), 0)::text AS keys_popped
         FROM quota_event qe
         FULL OUTER JOIN (
            SELECT dungeon_key, SUM(count) AS count
            FROM key_pop
            WHERE guild_id = $1::bigint AND user_id = $2::bigint
            GROUP BY dungeon_key
         ) kp ON qe.dungeon_key = kp.dungeon_key
         WHERE (qe.guild_id = $1::bigint AND qe.actor_user_id = $2::bigint AND qe.action_type = 'run_completed')
            OR kp.dungeon_key IS NOT NULL
         GROUP BY COALESCE(qe.dungeon_key, kp.dungeon_key)
         HAVING COUNT(*) FILTER (WHERE qe.points > 0) > 0 
             OR COUNT(*) FILTER (WHERE qe.quota_points > 0) > 0
             OR COALESCE(MAX(kp.count), 0) > 0
         ORDER BY (COALESCE(COUNT(*) FILTER (WHERE qe.points > 0), 0) + COALESCE(COUNT(*) FILTER (WHERE qe.quota_points > 0), 0) + COALESCE(MAX(kp.count), 0)) DESC`,
        [guildId, userId]
    );

    return {
        total_points: Number(totalPointsRes.rows[0].total),
        total_quota_points: Number(totalQuotaPointsRes.rows[0].total),
        total_runs_organized: Number(runsRes.rows[0].count),
        total_verifications: Number(verifRes.rows[0].count),
        total_keys_popped: Number(keysRes.rows[0].total),
        dungeons: dungeonsRes.rows.map(row => ({
            dungeon_key: row.dungeon_key,
            completed: Number(row.completed),
            organized: Number(row.organized),
            keys_popped: Number(row.keys_popped),
        })),
    };
}

/**
 * Get quota leaderboard for a specific role and time period
 * Uses quota_points since leaderboards track organizer/verifier activity
 */
export async function getQuotaLeaderboard(
    guildId: string,
    discordRoleId: string,
    memberUserIds: string[],
    periodStart: Date,
    periodEnd: Date
): Promise<Array<{ user_id: string; points: number; runs: number }>> {
    if (memberUserIds.length === 0) {
        return [];
    }

    logger.debug({
        guildId,
        discordRoleId,
        memberCount: memberUserIds.length,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString()
    }, 'Querying quota leaderboard');

    const res = await query<{ actor_user_id: string; total_points: string; run_count: string }>(
        `SELECT actor_user_id, 
                COALESCE(SUM(quota_points), 0)::text AS total_points,
                COUNT(CASE WHEN action_type = 'run_completed' THEN 1 END)::text AS run_count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND actor_user_id = ANY($2::bigint[])
           AND created_at >= $3
           AND created_at < $4
         GROUP BY actor_user_id
         ORDER BY total_points DESC, run_count DESC
         LIMIT 50`,
        [guildId, memberUserIds, periodStart.toISOString(), periodEnd.toISOString()]
    );

    logger.debug({ guildId, rowCount: res.rowCount }, 'Quota leaderboard query completed');

    if (res.rowCount === 0) {
        logger.debug({ guildId }, 'No quota events found in period - checking all-time events');
        const checkRes = await query(
            `SELECT COUNT(*) as count FROM quota_event WHERE guild_id = $1::bigint AND actor_user_id = ANY($2::bigint[])`,
            [guildId, memberUserIds]
        );
        logger.debug({ guildId, totalEvents: checkRes.rows[0].count }, 'Total events for users (all-time)');
    }

    return res.rows.map(row => ({
        user_id: row.actor_user_id,
        points: Number(row.total_points),
        runs: Number(row.run_count),
    }));
}

/**
 * Get quota stats for all members with a specific role in the current period
 * Uses quota_points since this tracks organizer/verifier activity
 */
export async function getQuotaStatsForRole(
    guildId: string,
    memberUserIds: string[],
    periodStart: Date,
    periodEnd: Date
): Promise<Map<string, { points: number; runs: number }>> {
    if (memberUserIds.length === 0) {
        return new Map();
    }

    const res = await query<{ actor_user_id: string; total_points: string; run_count: string }>(
        `SELECT actor_user_id, 
                COALESCE(SUM(quota_points), 0)::text AS total_points,
                COUNT(CASE WHEN action_type = 'run_completed' THEN 1 END)::text AS run_count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND actor_user_id = ANY($2::bigint[])
           AND created_at >= $3
           AND created_at < $4
         GROUP BY actor_user_id`,
        [guildId, memberUserIds, periodStart.toISOString(), periodEnd.toISOString()]
    );

    const statsMap = new Map<string, { points: number; runs: number }>();
    for (const row of res.rows) {
        statsMap.set(row.actor_user_id, {
            points: Number(row.total_points),
            runs: Number(row.run_count),
        });
    }

    return statsMap;
}

/**
 * Create a snapshot of all joined raiders at a key pop.
 * This records who was present during this key pop for later completion awarding.
 * 
 * @param runId - The run ID
 * @param keyPopNumber - The key pop number (1 for first pop, 2 for second, etc.)
 * @returns The number of raiders snapshotted
 */
export async function snapshotRaidersAtKeyPop(
    runId: number,
    keyPopNumber: number
): Promise<number> {
    // Get all raiders currently joined (state='join')
    const raiders = await query<{ user_id: string; class: string | null }>(
        `SELECT user_id, class
         FROM reaction
         WHERE run_id = $1::bigint AND state = 'join'`,
        [runId]
    );

    if (raiders.rowCount === 0) {
        logger.debug({ runId, keyPopNumber }, 'No raiders to snapshot at key pop');
        return 0;
    }

    // Insert snapshot for each raider
    for (const raider of raiders.rows) {
        try {
            await query(
                `INSERT INTO key_pop_snapshot (run_id, key_pop_number, user_id, class)
                 VALUES ($1::bigint, $2, $3::bigint, $4)
                 ON CONFLICT (run_id, key_pop_number, user_id) DO NOTHING`,
                [runId, keyPopNumber, raider.user_id, raider.class]
            );
        } catch (err) {
            logger.error({ err, runId, keyPopNumber, userId: raider.user_id }, 'Failed to snapshot raider at key pop');
        }
    }

    const snapshotCount = raiders.rowCount ?? 0;
    logger.info({ runId, keyPopNumber, raiderCount: snapshotCount }, 'Snapshotted raiders at key pop');
    return snapshotCount;
}

/**
 * Award completion points to raiders from a specific key pop snapshot.
 * This should be called when the next key pops OR when the run ends (for the last snapshot).
 * 
 * @param guildId - The guild ID
 * @param runId - The run ID
 * @param keyPopNumber - The key pop number whose raiders should get completions
 * @param dungeonKey - The dungeon key for points calculation
 * @returns The number of raiders awarded completions
 */
export async function awardCompletionsToKeyPopSnapshot(
    guildId: string,
    runId: number,
    keyPopNumber: number,
    dungeonKey: string
): Promise<number> {
    // Get raider points configuration for this dungeon
    const raiderPoints = await getRaiderPointsForDungeon(guildId, dungeonKey);

    // If points are 0 (default/not configured), skip awarding points
    if (raiderPoints === 0) {
        logger.debug({ runId, keyPopNumber, dungeonKey, guildId }, 'Skipping raider points - dungeon has 0 points configured');
        return 0;
    }

    // Get all raiders from this snapshot who haven't been awarded yet
    const raiders = await query<{ user_id: string }>(
        `SELECT user_id
         FROM key_pop_snapshot
         WHERE run_id = $1::bigint 
           AND key_pop_number = $2
           AND awarded_completion = FALSE`,
        [runId, keyPopNumber]
    );

    if (raiders.rowCount === 0) {
        logger.debug({ runId, keyPopNumber, guildId }, 'No raiders to award points from snapshot');
        return 0;
    }

    // Award points to each raider
    let awardedCount = 0;
    for (const raider of raiders.rows) {
        try {
            // Log quota event for the raider (using subject_id for idempotency)
            // This prevents double-awarding if processed multiple times
            const event = await query<{ id: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                 ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
                 DO NOTHING
                 RETURNING id`,
                [guildId, raider.user_id, `raider:${runId}:${keyPopNumber}:${raider.user_id}`, dungeonKey, raiderPoints]
            );

            if (event.rowCount && event.rowCount > 0) {
                // Mark as awarded in snapshot
                await query(
                    `UPDATE key_pop_snapshot
                     SET awarded_completion = TRUE, awarded_at = NOW()
                     WHERE run_id = $1::bigint AND key_pop_number = $2 AND user_id = $3::bigint`,
                    [runId, keyPopNumber, raider.user_id]
                );
                awardedCount++;
            }
        } catch (err) {
            logger.error({ err, userId: raider.user_id, runId, keyPopNumber, guildId }, 'Failed to award completion to raider from snapshot');
        }
    }

    logger.info({ runId, keyPopNumber, dungeonKey, guildId, raiderPoints, awardedCount, totalRaiders: raiders.rowCount }, 'Awarded completions to key pop snapshot');
    return awardedCount;
}

/**
 * Get leaderboard for a specific category (runs organized, keys popped, dungeon completions, points, or quota points)
 * Optionally filtered by dungeon key and/or date range
 * 
 * @param guildId - Discord guild ID
 * @param category - Category type
 * @param dungeonKey - Optional dungeon key filter (or 'all' for all dungeons)
 * @param since - Optional start date (inclusive) for filtering
 * @param until - Optional end date (inclusive) for filtering
 * @returns Array of leaderboard entries with user_id and count, sorted descending
 */
export async function getLeaderboard(
    guildId: string,
    category: 'runs_organized' | 'keys_popped' | 'dungeon_completions' | 'points' | 'quota_points',
    dungeonKey?: string,
    since?: Date,
    until?: Date
): Promise<Array<{ user_id: string; count: number }>> {
    let queryStr: string;
    let params: any[];

    // Helper to build dynamic WHERE clause and params
    const buildQuery = (baseConditions: string[], baseParams: any[]): { whereClause: string; params: any[] } => {
        const conditions = [...baseConditions];
        const allParams = [...baseParams];
        let paramIndex = baseParams.length + 1;
        
        if (dungeonKey && dungeonKey !== 'all') {
            conditions.push(`dungeon_key = $${paramIndex}`);
            allParams.push(dungeonKey);
            paramIndex++;
        }
        if (since) {
            conditions.push(`created_at >= $${paramIndex}`);
            allParams.push(since.toISOString());
            paramIndex++;
        }
        if (until) {
            conditions.push(`created_at <= $${paramIndex}`);
            allParams.push(until.toISOString());
        }
        
        return {
            whereClause: conditions.join(' AND '),
            params: allParams
        };
    };

    if (category === 'runs_organized') {
        // Count runs where user earned quota points (organizer activity)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'action_type = \'run_completed\'', 'quota_points > 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, COUNT(*)::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING COUNT(*) > 0
            ORDER BY COUNT(*) DESC, actor_user_id ASC
        `;
        params = queryParams;
    } else if (category === 'keys_popped') {
        // Count keys popped from key_pop table
        // Note: key_pop table doesn't have created_at, so date filtering not applicable
        if (dungeonKey && dungeonKey !== 'all') {
            queryStr = `
                SELECT user_id, SUM(count)::text AS count
                FROM key_pop
                WHERE guild_id = $1::bigint 
                  AND dungeon_key = $2
                GROUP BY user_id
                HAVING SUM(count) > 0
                ORDER BY SUM(count) DESC, user_id ASC
            `;
            params = [guildId, dungeonKey];
        } else {
            queryStr = `
                SELECT user_id, SUM(count)::text AS count
                FROM key_pop
                WHERE guild_id = $1::bigint
                GROUP BY user_id
                HAVING SUM(count) > 0
                ORDER BY SUM(count) DESC, user_id ASC
            `;
            params = [guildId];
        }
        
        // Log warning if date filters were provided for keys_popped
        if (since || until) {
            logger.warn({ guildId, category }, 'Date filtering not supported for keys_popped category - ignoring since/until parameters');
        }
    } else if (category === 'dungeon_completions') {
        // Count completions where user earned points (raider activity)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'action_type = \'run_completed\'', 'points > 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, COUNT(*)::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING COUNT(*) > 0
            ORDER BY COUNT(*) DESC, actor_user_id ASC
        `;
        params = queryParams;
    } else if (category === 'points') {
        // Sum total points (raider activity)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'points > 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, SUM(points)::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING SUM(points) > 0
            ORDER BY SUM(points) DESC, actor_user_id ASC
        `;
        params = queryParams;
    } else { // quota_points
        // Sum total quota points (organizer/verifier activity)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'quota_points > 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, SUM(quota_points)::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING SUM(quota_points) > 0
            ORDER BY SUM(quota_points) DESC, actor_user_id ASC
        `;
        params = queryParams;
    }

    const res = await query<{ user_id: string; count: string }>(queryStr, params);

    return res.rows.map(row => ({
        user_id: row.user_id,
        count: Number(row.count),
    }));
}

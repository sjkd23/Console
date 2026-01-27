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
    period_start_at: string; // ISO timestamp - custom start date for quota period (can be past/future)
    moderation_points: number; // DEPRECATED: Use individual command points instead
    base_exalt_points: number; // Base points for exaltation dungeons (default: 1.0)
    base_non_exalt_points: number; // Base points for non-exaltation dungeons (default: 1.0)
    // Individual moderation command points
    verify_points: number; // Points awarded for /verify command
    warn_points: number; // Points awarded for /warn command
    suspend_points: number; // Points awarded for /suspend command
    modmail_reply_points: number; // Points awarded for replying to modmail
    editname_points: number; // Points awarded for /editname command
    addnote_points: number; // Points awarded for /addnote command
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
        period_start_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
        base_exalt_points: string; // DECIMAL comes as string from pg
        base_non_exalt_points: string; // DECIMAL comes as string from pg
        verify_points: string; // DECIMAL comes as string from pg
        warn_points: string; // DECIMAL comes as string from pg
        suspend_points: string; // DECIMAL comes as string from pg
        modmail_reply_points: string; // DECIMAL comes as string from pg
        editname_points: string; // DECIMAL comes as string from pg
        addnote_points: string; // DECIMAL comes as string from pg
    }>(
        `SELECT guild_id, discord_role_id, required_points, reset_at, panel_message_id, period_start_at, 
                moderation_points, base_exalt_points, base_non_exalt_points,
                verify_points, warn_points, suspend_points, modmail_reply_points, editname_points, addnote_points
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
        period_start_at: row.period_start_at,
        moderation_points: Number(row.moderation_points),
        base_exalt_points: Number(row.base_exalt_points),
        base_non_exalt_points: Number(row.base_non_exalt_points),
        verify_points: Number(row.verify_points),
        warn_points: Number(row.warn_points),
        suspend_points: Number(row.suspend_points),
        modmail_reply_points: Number(row.modmail_reply_points),
        editname_points: Number(row.editname_points),
        addnote_points: Number(row.addnote_points),
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
        period_start_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
        base_exalt_points: string; // DECIMAL comes as string from pg
        base_non_exalt_points: string; // DECIMAL comes as string from pg
        verify_points: string; // DECIMAL comes as string from pg
        warn_points: string; // DECIMAL comes as string from pg
        suspend_points: string; // DECIMAL comes as string from pg
        modmail_reply_points: string; // DECIMAL comes as string from pg
        editname_points: string; // DECIMAL comes as string from pg
        addnote_points: string; // DECIMAL comes as string from pg
    }>(
        `SELECT guild_id, discord_role_id, required_points, reset_at, panel_message_id, period_start_at, 
                moderation_points, base_exalt_points, base_non_exalt_points,
                verify_points, warn_points, suspend_points, modmail_reply_points, editname_points, addnote_points
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
        period_start_at: row.period_start_at,
        moderation_points: Number(row.moderation_points),
        base_exalt_points: Number(row.base_exalt_points),
        base_non_exalt_points: Number(row.base_non_exalt_points),
        verify_points: Number(row.verify_points),
        warn_points: Number(row.warn_points),
        suspend_points: Number(row.suspend_points),
        modmail_reply_points: Number(row.modmail_reply_points),
        editname_points: Number(row.editname_points),
        addnote_points: Number(row.addnote_points),
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
        period_start_at?: string; // ISO timestamp - custom start date for quota period
        moderation_points?: number; // DEPRECATED: Use individual command points
        base_exalt_points?: number; // Base points for exaltation dungeons
        base_non_exalt_points?: number; // Base points for non-exaltation dungeons
        verify_points?: number; // Points for /verify command
        warn_points?: number; // Points for /warn command
        suspend_points?: number; // Points for /suspend command
        modmail_reply_points?: number; // Points for replying to modmail
        editname_points?: number; // Points for /editname command
        addnote_points?: number; // Points for /addnote command
    }
): Promise<QuotaRoleConfig> {
    const fields: string[] = [];
    const values: any[] = [guildId, discordRoleId];
    let idx = 3;

    // For INSERT, we need default values
    const requiredPoints = config.required_points ?? 0;
    const resetAt = config.reset_at ?? null; // Will use COALESCE in query
    const periodStartAt = config.period_start_at ?? null; // Will use COALESCE in query
    const moderationPoints = config.moderation_points ?? 0;
    const baseExaltPoints = config.base_exalt_points ?? 1.0;
    const baseNonExaltPoints = config.base_non_exalt_points ?? 1.0;
    const verifyPoints = config.verify_points ?? 0;
    const warnPoints = config.warn_points ?? 0;
    const suspendPoints = config.suspend_points ?? 0;
    const modmailReplyPoints = config.modmail_reply_points ?? 0;
    const editnamePoints = config.editname_points ?? 0;
    const addnotePoints = config.addnote_points ?? 0;

    values.push(requiredPoints); // $3
    values.push(resetAt); // $4
    values.push(periodStartAt); // $5
    values.push(moderationPoints); // $6
    values.push(baseExaltPoints); // $7
    values.push(baseNonExaltPoints); // $8
    values.push(verifyPoints); // $9
    values.push(warnPoints); // $10
    values.push(suspendPoints); // $11
    values.push(modmailReplyPoints); // $12
    values.push(editnamePoints); // $13
    values.push(addnotePoints); // $14

    // Build UPDATE fields
    if (config.required_points !== undefined) {
        fields.push(`required_points = $${idx}`);
    }
    idx++; // Move past $3

    if (config.reset_at !== undefined) {
        fields.push(`reset_at = $${idx}::timestamptz`);
    }
    idx++; // Move past $4

    if (config.period_start_at !== undefined) {
        fields.push(`period_start_at = $${idx}::timestamptz`);
    }
    idx++; // Move past $5

    if (config.moderation_points !== undefined) {
        fields.push(`moderation_points = $${idx}`);
    }
    idx++; // Move past $6

    if (config.base_exalt_points !== undefined) {
        fields.push(`base_exalt_points = $${idx}`);
    }
    idx++; // Move past $7

    if (config.base_non_exalt_points !== undefined) {
        fields.push(`base_non_exalt_points = $${idx}`);
    }
    idx++; // Move past $8

    if (config.verify_points !== undefined) {
        fields.push(`verify_points = $${idx}`);
    }
    idx++; // Move past $9

    if (config.warn_points !== undefined) {
        fields.push(`warn_points = $${idx}`);
    }
    idx++; // Move past $10

    if (config.suspend_points !== undefined) {
        fields.push(`suspend_points = $${idx}`);
    }
    idx++; // Move past $11

    if (config.modmail_reply_points !== undefined) {
        fields.push(`modmail_reply_points = $${idx}`);
    }
    idx++; // Move past $12

    if (config.editname_points !== undefined) {
        fields.push(`editname_points = $${idx}`);
    }
    idx++; // Move past $13

    if (config.addnote_points !== undefined) {
        fields.push(`addnote_points = $${idx}`);
    }
    idx++; // Move past $14

    if (config.panel_message_id !== undefined) {
        fields.push(`panel_message_id = $${idx++}::bigint`);
        values.push(config.panel_message_id);
    }

    const updateClause = fields.length > 0 ? `, ${fields.join(', ')}` : '';

    // CRITICAL: First, try to get the existing config to preserve period_start_at
    // This prevents accidentally resetting the quota period when only updating panel_message_id
    const existing = await getQuotaRoleConfig(guildId, discordRoleId);
    
    // If we have an existing config and period_start_at is not being explicitly set, preserve it
    if (existing && config.period_start_at === undefined) {
        // Override the periodStartAt value with the preserved one
        values[4] = existing.period_start_at; // $5 position
    }

    const res = await query<{
        guild_id: string;
        discord_role_id: string;
        required_points: string; // DECIMAL comes as string from pg
        reset_at: string;
        panel_message_id: string | null;
        period_start_at: string;
        moderation_points: string; // DECIMAL comes as string from pg
        base_exalt_points: string; // DECIMAL comes as string from pg
        base_non_exalt_points: string; // DECIMAL comes as string from pg
        verify_points: string; // DECIMAL comes as string from pg
        warn_points: string; // DECIMAL comes as string from pg
        suspend_points: string; // DECIMAL comes as string from pg
        modmail_reply_points: string; // DECIMAL comes as string from pg
        editname_points: string; // DECIMAL comes as string from pg
        addnote_points: string; // DECIMAL comes as string from pg
    }>(
        `INSERT INTO quota_role_config (guild_id, discord_role_id, required_points, reset_at, period_start_at, 
                moderation_points, base_exalt_points, base_non_exalt_points,
                verify_points, warn_points, suspend_points, modmail_reply_points, editname_points, addnote_points,
                updated_at)
         VALUES ($1::bigint, $2::bigint, 
                 $3, 
                 COALESCE($4::timestamptz, NOW() + INTERVAL '7 days'),
                 COALESCE($5::timestamptz, NOW()),
                 $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 NOW())
         ON CONFLICT (guild_id, discord_role_id)
         DO UPDATE SET updated_at = NOW() ${updateClause}
         RETURNING guild_id, discord_role_id, required_points, reset_at, panel_message_id, period_start_at, 
                   moderation_points, base_exalt_points, base_non_exalt_points,
                   verify_points, warn_points, suspend_points, modmail_reply_points, editname_points, addnote_points`,
        values
    );

    const row = res.rows[0];
    return {
        guild_id: row.guild_id,
        discord_role_id: row.discord_role_id,
        required_points: Number(row.required_points),
        reset_at: row.reset_at,
        panel_message_id: row.panel_message_id,
        period_start_at: row.period_start_at,
        moderation_points: Number(row.moderation_points),
        base_exalt_points: Number(row.base_exalt_points),
        base_non_exalt_points: Number(row.base_non_exalt_points),
        verify_points: Number(row.verify_points),
        warn_points: Number(row.warn_points),
        suspend_points: Number(row.suspend_points),
        modmail_reply_points: Number(row.modmail_reply_points),
        editname_points: Number(row.editname_points),
        addnote_points: Number(row.addnote_points),
    };
}

/**
 * Delete quota role configuration and all associated data.
 * This will cascade delete all dungeon overrides and quota events for this role.
 * 
 * @param guildId - Discord guild ID
 * @param discordRoleId - Discord role ID
 * @returns true if a config was deleted, false if no config existed
 */
export async function deleteQuotaRoleConfig(
    guildId: string,
    discordRoleId: string
): Promise<boolean> {
    const res = await query(
        `DELETE FROM quota_role_config
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint`,
        [guildId, discordRoleId]
    );

    const deleted = (res.rowCount ?? 0) > 0;
    if (deleted) {
        logger.info({ guildId, discordRoleId }, 'Deleted quota role config');
    }
    return deleted;
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
 * Priority: dungeon override > base exalt/non-exalt points > default 1
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon identifier (e.g., 'shatters', 'fungal')
 * @param userRoleIds - Array of Discord role IDs the user has (optional)
 * @returns The point value for this dungeon (highest override or base value)
 */
export async function getPointsForDungeon(
    guildId: string,
    dungeonKey: string,
    userRoleIds?: string[]
): Promise<number> {
    const { isExaltDungeon } = await import('../../config/raid-config.js');
    const isExalt = isExaltDungeon(dungeonKey);

    // If no user roles provided, check across ALL quota configs in the guild
    // This is useful for auto-end scenarios where we don't have the organizer's current roles
    if (!userRoleIds || userRoleIds.length === 0) {
        // First try to find a dungeon-specific override
        const overrideRes = await query<{ points: string }>(
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
            logger.debug({ guildId, dungeonKey, points }, 'Found max dungeon override (no role filter)');
            return points;
        }

        // No override found, check base points from quota_role_config
        const basePointsField = isExalt ? 'base_exalt_points' : 'base_non_exalt_points';
        const baseRes = await query<{ points: string }>(
            `SELECT ${basePointsField} as points
             FROM quota_role_config
             WHERE guild_id = $1::bigint
             ORDER BY ${basePointsField} DESC
             LIMIT 1`,
            [guildId]
        );

        if (baseRes.rowCount && baseRes.rowCount > 0) {
            const points = Number(baseRes.rows[0].points);
            logger.debug({ guildId, dungeonKey, isExalt, points }, 'Using max base points (no role filter)');
            return points;
        }

        logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 'No dungeon override or base points found, using default');
        return 1;
    }

    // Query all dungeon overrides for this dungeon across all the user's roles
    const overrideRes = await query<{ points: string }>(
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
        logger.debug({ guildId, dungeonKey, points, rolesChecked: userRoleIds.length }, 'Found dungeon override');
        return points;
    }

    // No override found, check base points for the user's roles
    const basePointsField = isExalt ? 'base_exalt_points' : 'base_non_exalt_points';
    const baseRes = await query<{ points: string }>(
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
        logger.debug({ guildId, dungeonKey, isExalt, points, rolesChecked: userRoleIds.length }, 'Using base points');
        return points;
    }

    // No override or base points found, use default
    logger.debug({ guildId, dungeonKey, defaultPoints: 1 }, 'No dungeon override or base points found, using default');
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
 * Get the quota role that should award points for a dungeon action.
 * Returns the highest-ranked Discord role that:
 * - User currently has
 * - Has quota config with points > 0 for this dungeon
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon identifier (e.g., 'shatters', 'fungal')
 * @param userRoleIds - Array of Discord role IDs the user has
 * @param userRolePositions - Optional map of roleId -> Discord position (higher = more authority)
 * @returns Object with roleId and points, or null if no role awards points
 */
export async function getQuotaRoleForDungeon(
    guildId: string,
    dungeonKey: string,
    userRoleIds: string[],
    userRolePositions?: Record<string, number>
): Promise<{ roleId: string; points: number } | null> {
    if (!userRoleIds || userRoleIds.length === 0) {
        return null;
    }

    // Get all configs where user has the role
    const configs = await getAllQuotaRoleConfigs(guildId);
    const userConfigs = configs.filter(c => userRoleIds.includes(c.discord_role_id));
    
    if (userConfigs.length === 0) {
        return null;
    }
    
    // For each config, get dungeon points (considering overrides)
    const configsWithPoints = await Promise.all(
        userConfigs.map(async (config) => {
            const points = await getPointsForDungeon(guildId, dungeonKey, [config.discord_role_id]);
            return { roleId: config.discord_role_id, points };
        })
    );
    
    // Filter to only configs with points > 0
    const activeConfigs = configsWithPoints.filter(c => c.points > 0);
    if (activeConfigs.length === 0) {
        return null;
    }
    
    // If multiple roles could award, use highest role position (failsafe)
    if (activeConfigs.length > 1) {
        logger.warn({ 
            guildId, 
            dungeonKey, 
            roleCount: activeConfigs.length,
            roleIds: activeConfigs.map(c => c.roleId)
        }, 'Multiple quota roles could award points - using highest role by position');
        
        if (userRolePositions) {
            // Sort by Discord role position (higher position = higher authority)
            activeConfigs.sort((a, b) => 
                (userRolePositions[b.roleId] ?? 0) - (userRolePositions[a.roleId] ?? 0)
            );
        }
    }
    
    return activeConfigs[0];
}

/**
 * Calculate the start of the current quota period for a given config
 * Uses period_start_at which can be set to any past or future date
 */
export function getQuotaPeriodStart(config: QuotaRoleConfig): Date {
    const resetAt = new Date(config.reset_at);
    const periodStartAt = new Date(config.period_start_at);
    const now = new Date();

    // If reset_at is in the future, the current period started at period_start_at
    if (resetAt > now) {
        return periodStartAt;
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
 * @param quotaRoleId - Optional Discord role ID that awarded these quota points (for panel tracking)
 * @returns The created quota event or null if it was a duplicate (idempotent no-op)
 */
export async function logQuotaEvent(
    guildId: string,
    actorUserId: string,
    actionType: QuotaActionType,
    subjectId?: string,
    dungeonKey?: string,
    quotaPoints?: number,
    quotaRoleId?: string
): Promise<{ id: number; points: number; quota_points: number } | null> {
    const effectiveQuotaPoints = quotaPoints ?? getDefaultPoints(actionType);
    const effectivePoints = 0; // Regular points not yet implemented for raiders

    // Log warning if quota points are being awarded without a role ID
    if (effectiveQuotaPoints !== 0 && !quotaRoleId) {
        logger.warn({ 
            guildId, 
            actorUserId, 
            actionType, 
            quotaPoints: effectiveQuotaPoints 
        }, 'Quota points awarded without quota_role_id - event will not appear in role panels');
    }

    try {
        const res = await query<{ id: number; points: number; quota_points: number }>(
            `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points, quota_role_id)
             VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8::bigint)
             ON CONFLICT (guild_id, subject_id) WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
             DO NOTHING
             RETURNING id, points, quota_points`,
            [guildId, actorUserId, actionType, subjectId || null, dungeonKey || null, effectivePoints, effectiveQuotaPoints, quotaRoleId || null]
        );

        if (res.rowCount === 0) {
            // Duplicate event (idempotent no-op)
            logger.debug({ guildId, actorUserId, actionType, subjectId, dungeonKey }, 'Skipped duplicate quota event');
            return null;
        }

        logger.info({ guildId, actorUserId, actionType, subjectId, dungeonKey, quotaPoints: effectiveQuotaPoints, quotaRoleId }, 'Logged quota event');

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
 * @deprecated Use QuotaService.awardRaidersQuotaFromParticipants instead for run lifecycle operations.
 * This function is kept for backward compatibility and manual operations only.
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

    // Get run count (organizer activities - where they have quota_points)
    // For manual logs, parse the run count from subject_id and multiply by SIGN(quota_points)
    // This handles negative removals correctly (e.g., -1 run when quota_points is negative)
    const runsRes = await query<{ count: string }>(
        `SELECT COALESCE(
            SUM(
                CASE 
                    WHEN subject_id LIKE 'manual_log_run:%' 
                    THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                    ELSE SIGN(quota_points)
                END
            ), 
            0
        )::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint 
           AND actor_user_id = $2::bigint
           AND action_type = 'run_completed'
           AND quota_points != 0`,
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
    // For manual logs, parse the run count from subject_id
    const dungeonsRes = await query<{ dungeon_key: string; completed: string; organized: string; keys_popped: string }>(
        `WITH all_dungeons AS (
            -- Get all dungeons from key_pop
            SELECT DISTINCT dungeon_key
            FROM key_pop
            WHERE guild_id = $1::bigint AND user_id = $2::bigint
            UNION
            -- Get all dungeons from quota_event
            SELECT DISTINCT dungeon_key
            FROM quota_event
            WHERE guild_id = $1::bigint 
              AND actor_user_id = $2::bigint 
              AND action_type = 'run_completed'
              AND dungeon_key IS NOT NULL
         ),
         key_pop_agg AS (
            SELECT dungeon_key, SUM(count) AS count
            FROM key_pop
            WHERE guild_id = $1::bigint AND user_id = $2::bigint
            GROUP BY dungeon_key
         ),
         quota_event_agg AS (
            SELECT 
                dungeon_key,
                SUM(
                    CASE 
                        WHEN points != 0 AND subject_id LIKE 'manual_log_run:%' 
                        THEN (split_part(subject_id, ':', 4)::int * SIGN(points))
                        WHEN points != 0 
                        THEN SIGN(points)
                        ELSE 0
                    END
                ) AS completed,
                SUM(
                    CASE 
                        WHEN quota_points != 0 AND subject_id LIKE 'manual_log_run:%' 
                        THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                        WHEN quota_points != 0 
                        THEN SIGN(quota_points)
                        ELSE 0
                    END
                ) AS organized
            FROM quota_event
            WHERE guild_id = $1::bigint 
              AND actor_user_id = $2::bigint 
              AND action_type = 'run_completed'
            GROUP BY dungeon_key
         )
         SELECT 
            ad.dungeon_key,
            COALESCE(qea.completed, 0)::text AS completed,
            COALESCE(qea.organized, 0)::text AS organized,
            COALESCE(kpa.count, 0)::text AS keys_popped
         FROM all_dungeons ad
         LEFT JOIN quota_event_agg qea ON ad.dungeon_key = qea.dungeon_key
         LEFT JOIN key_pop_agg kpa ON ad.dungeon_key = kpa.dungeon_key
         WHERE COALESCE(qea.completed, 0) > 0 
            OR COALESCE(qea.organized, 0) > 0
            OR COALESCE(kpa.count, 0) > 0
         ORDER BY (
            COALESCE(qea.completed, 0) + 
            COALESCE(qea.organized, 0) + 
            COALESCE(kpa.count, 0)
         ) DESC`,
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
 * Only includes events where quota_role_id matches the specified role
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

    // Use UNNEST to include all members, even those with 0 points
    // This ensures the leaderboard shows everyone with the role, not just those with activity
    // CRITICAL: Filter by quota_role_id to prevent cross-panel contamination
    // For manual logs (subject_id like 'manual_log_run:timestamp:userid:count'), extract the run count from subject_id
    // and multiply by SIGN(quota_points) to handle negative removals correctly
    // For regular run logs (subject_id like 'run:123'), use SIGN(quota_points) as count
    const res = await query<{ actor_user_id: string; total_points: string; run_count: string }>(
        `SELECT members.user_id::text AS actor_user_id,
                COALESCE(SUM(qe.quota_points), 0)::text AS total_points,
                COALESCE(
                    SUM(
                        CASE 
                            WHEN qe.action_type = 'run_completed' AND qe.quota_points != 0 AND qe.subject_id LIKE 'manual_log_run:%' 
                            THEN (split_part(qe.subject_id, ':', 4)::int * SIGN(qe.quota_points))
                            WHEN qe.action_type = 'run_completed' AND qe.quota_points != 0 
                            THEN SIGN(qe.quota_points)
                            ELSE 0
                        END
                    ), 
                    0
                )::text AS run_count
         FROM UNNEST($2::bigint[]) AS members(user_id)
         LEFT JOIN quota_event qe ON qe.guild_id = $1::bigint 
                                  AND qe.actor_user_id = members.user_id
                                  AND qe.created_at >= $3
                                  AND qe.created_at < $4
                                  AND qe.quota_role_id = $5::bigint
         GROUP BY members.user_id
         ORDER BY COALESCE(SUM(qe.quota_points), 0) DESC, 
                  COALESCE(
                      SUM(
                          CASE 
                              WHEN qe.action_type = 'run_completed' AND qe.quota_points != 0 AND qe.subject_id LIKE 'manual_log_run:%' 
                              THEN (split_part(qe.subject_id, ':', 4)::int * SIGN(qe.quota_points))
                              WHEN qe.action_type = 'run_completed' AND qe.quota_points != 0 
                              THEN SIGN(qe.quota_points)
                              ELSE 0
                          END
                      ), 
                      0
                  ) DESC
         LIMIT 50`,
        [guildId, memberUserIds, periodStart.toISOString(), periodEnd.toISOString(), discordRoleId]
    );

    logger.debug({ guildId, totalMembers: memberUserIds.length, membersWithActivity: res.rowCount }, 'Quota leaderboard query completed');

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
                COALESCE(
                    SUM(
                        CASE 
                            WHEN action_type = 'run_completed' AND quota_points != 0 AND subject_id LIKE 'manual_log_run:%' 
                            THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                            WHEN action_type = 'run_completed' AND quota_points != 0 
                            THEN SIGN(quota_points)
                            ELSE 0
                        END
                    ), 
                    0
                )::text AS run_count
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
 * @deprecated Use QuotaService.awardRaidersQuotaFromSnapshot instead for run lifecycle operations.
 * This function is kept for backward compatibility and manual operations only.
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
        // Count runs where user has quota points (organizer activity)
        // For manual logs, parse the run count from subject_id and multiply by SIGN(quota_points)
        // This handles negative removals correctly
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'action_type = \'run_completed\'', 'quota_points != 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, 
                   SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                           ELSE SIGN(quota_points)
                       END
                   )::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                           ELSE SIGN(quota_points)
                       END
                   ) > 0
            ORDER BY SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(quota_points))
                           ELSE SIGN(quota_points)
                       END
                   ) DESC, actor_user_id ASC
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
        // Count completions where user has points (raider activity)
        // For manual logs, parse the run count from subject_id and multiply by SIGN(points)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'action_type = \'run_completed\'', 'points != 0'],
            [guildId]
        );
        
        queryStr = `
            SELECT actor_user_id AS user_id, 
                   SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(points))
                           ELSE SIGN(points)
                       END
                   )::text AS count
            FROM quota_event
            WHERE ${whereClause}
            GROUP BY actor_user_id
            HAVING SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(points))
                           ELSE SIGN(points)
                       END
                   ) > 0
            ORDER BY SUM(
                       CASE 
                           WHEN subject_id LIKE 'manual_log_run:%' 
                           THEN (split_part(subject_id, ':', 4)::int * SIGN(points))
                           ELSE SIGN(points)
                       END
                   ) DESC, actor_user_id ASC
        `;
        params = queryParams;
    } else if (category === 'points') {
        // Sum total points (raider activity)
        const { whereClause, params: queryParams } = buildQuery(
            ['guild_id = $1::bigint', 'points != 0'],
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
            ['guild_id = $1::bigint', 'quota_points != 0'],
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

/**
 * Recalculate quota points for all run_completed events in a quota period.
 * This fetches all runs organized during the period and recalculates their
 * quota_points based on current configuration values.
 * 
 * This is useful when:
 * - Point values change and you want to retroactively apply them
 * - Manual logs were created with incorrect point values
 * - You want to ensure consistency between config and stored points
 * 
 * @param guildId - Discord guild ID
 * @param roleId - Discord role ID for the quota config
 * @returns Number of events recalculated
 */
export async function recalculateQuotaPoints(
    guildId: string,
    roleId: string
): Promise<{ recalculated: number; total_points: number }> {
    logger.info({ guildId, roleId }, 'Starting quota points recalculation');

    // Get the quota config for this role
    const config = await getQuotaRoleConfig(guildId, roleId);
    if (!config) {
        throw new Error(`No quota config found for guild ${guildId}, role ${roleId}`);
    }

    // Determine the current quota period
    const periodStart = getQuotaPeriodStart(config);
    const periodEnd = getQuotaPeriodEnd(config);

    logger.debug({ 
        guildId, 
        roleId, 
        periodStart: periodStart.toISOString(), 
        periodEnd: periodEnd.toISOString() 
    }, 'Calculated quota period for recalculation');

    // Fetch all run_completed events in this period where quota_points > 0
    // (indicating organizer activity, not raider completions)
    // CRITICAL: Filter by quota_role_id to only recalculate points for THIS specific role panel
    const eventsRes = await query<{
        id: string;
        actor_user_id: string;
        dungeon_key: string;
        quota_points: string;
    }>(
        `SELECT id, actor_user_id, dungeon_key, quota_points
         FROM quota_event
         WHERE guild_id = $1::bigint
           AND action_type = 'run_completed'
           AND quota_points > 0
           AND quota_role_id = $4::bigint
           AND created_at >= $2
           AND created_at < $3
         ORDER BY id ASC`,
        [guildId, periodStart.toISOString(), periodEnd.toISOString(), roleId]
    );

    if (eventsRes.rowCount === 0) {
        logger.info({ guildId, roleId }, 'No events to recalculate');
        return { recalculated: 0, total_points: 0 };
    }

    logger.debug({ guildId, roleId, eventCount: eventsRes.rowCount }, 'Found events to recalculate');

    // Recalculate points based on THIS ROLE's current configuration
    // This ensures we're using role-specific dungeon overrides and base points
    let recalculatedCount = 0;
    let totalPoints = 0;

    for (const event of eventsRes.rows) {
        // Recalculate points based on THIS role's configuration
        // Use [roleId] as the role filter to get THIS ROLE's specific point config
        const newPoints = await getPointsForDungeon(
            guildId,
            event.dungeon_key,
            [roleId] // Use THIS role's config specifically
        );

        const oldPoints = Number(event.quota_points);

        // Only update if points changed
        if (newPoints !== oldPoints) {
            await query(
                `UPDATE quota_event
                 SET quota_points = $1
                 WHERE id = $2`,
                [newPoints, event.id]
            );

            logger.debug({
                guildId,
                roleId,
                eventId: event.id,
                dungeonKey: event.dungeon_key,
                oldPoints,
                newPoints
            }, 'Updated event quota points');
        }

        recalculatedCount++;
        totalPoints += newPoints;
    }

    logger.info({ 
        guildId, 
        roleId, 
        recalculated: recalculatedCount,
        totalPoints 
    }, 'Completed quota points recalculation');

    return { recalculated: recalculatedCount, total_points: totalPoints };
}

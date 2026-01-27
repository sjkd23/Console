// backend/src/routes/quota.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { hasInternalRole, hasRequiredRoleOrHigher, requireSecurity, canManageGuildRoles } from '../../lib/auth/authorization.js';
import { ensureGuildExists, ensureMemberExists, ensureRaiderExists } from '../../lib/database/database-helpers.js';
import { createLogger } from '../../lib/logging/logger.js';
import { 
    logQuotaEvent, 
    isRunAlreadyLogged, 
    getUserQuotaStats,
    getQuotaRoleConfig,
    getAllQuotaRoleConfigs,
    upsertQuotaRoleConfig,
    deleteQuotaRoleConfig,
    getDungeonOverrides,
    setDungeonOverride,
    deleteDungeonOverride,
    getQuotaLeaderboard,
    getQuotaPeriodStart,
    getQuotaPeriodEnd,
    getPointsForDungeon,
    getRaiderPointsConfig,
    getRaiderPointsForDungeon,
    setRaiderPointsForDungeon,
    deleteRaiderPointsForDungeon,
    getKeyPopPointsConfig,
    getKeyPopPointsForDungeon,
    setKeyPopPointsForDungeon,
    deleteKeyPopPointsForDungeon,
    getLeaderboard,
    recalculateQuotaPoints,
} from '../../lib/quota/quota.js';

const logger = createLogger('Quota');/**
 * Body schema for manually logging run quota.
 */
const LogRunBody = z.object({
    actorId: zSnowflake,
    actorRoles: z.array(zSnowflake).optional(),
    actorRolePositions: z.record(z.string(), z.number()).optional(), // Discord role positions for failsafe
    guildId: zSnowflake,
    organizerId: zSnowflake.optional(), // Target organizer to log quota for (defaults to actorId)
    dungeonKey: z.string(), // Required: dungeon type for the manual quota log
    amount: z.number().int().default(1), // Amount is count of runs (integer), not points - can be negative
});

/**
 * Body schema for manually logging key pops.
 */
const LogKeyBody = z.object({
    actorId: zSnowflake,
    actorRoles: z.array(zSnowflake).optional(),
    guildId: zSnowflake,
    userId: zSnowflake, // The user who popped the key
    username: z.string().optional(), // Optional username for the user
    userRoles: z.array(zSnowflake).optional(), // Optional roles for the user (to check verification status)
    dungeonKey: z.string(), // The dungeon the key is for
    amount: z.number().int().default(1), // Can be negative to remove key pops
});

export default async function quotaRoutes(app: FastifyInstance) {
    /**
     * POST /quota/log-run
     * Manually log run completion quota for an organizer.
     * This is a fully manual operation - no actual run record is required.
     * Authorization: actorId must have organizer role or higher.
     * Supports negative amounts to remove quota points.
     * 
     * Body: { actorId, actorRoles?, actorRolePositions?, guildId, organizerId?, dungeonKey, amount? }
     * Returns: { logged: number, total_points: number, organizer_id: string, quota_role_id?: string }
     */
    app.post('/quota/log-run', async (req, reply) => {
        const parsed = LogRunBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { actorId, actorRoles, actorRolePositions, guildId, organizerId, dungeonKey, amount } = parsed.data;

        // Default organizerId to actorId if not provided (self-logging)
        const targetOrganizerId = organizerId || actorId;

        // Authorization: actor must have organizer role or higher
        const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
        if (!hasOrganizerRole) {
            logger.warn({ actorId, guildId }, 'User denied - no organizer role');
            return reply.code(403).send({
                error: {
                    code: 'NOT_ORGANIZER',
                    message: 'You must have the Organizer role to log runs',
                },
            });
        }

        // Ensure both actor and target organizer exist in the member table
        try {
            await ensureMemberExists(actorId);
            await ensureMemberExists(targetOrganizerId);
        } catch (err) {
            logger.error({ err, actorId, targetOrganizerId, guildId }, 'Failed to ensure members exist');
            return Errors.internal(reply, 'Failed to process quota logging');
        }

        let totalPoints = 0;
        let loggedCount = 0;
        let quotaRoleId: string | undefined;

        try {
            // Determine which quota role should award points
            const { getQuotaRoleForDungeon } = await import('../../lib/quota/quota.js');
            const quotaRole = await getQuotaRoleForDungeon(
                guildId,
                dungeonKey,
                actorRoles || [],
                actorRolePositions
            );

            if (!quotaRole || quotaRole.points === 0) {
                logger.info({ actorId, guildId, dungeonKey }, 'No quota role awards points for this dungeon');
                return reply.code(200).send({
                    logged: 0,
                    total_points: 0,
                    organizer_id: targetOrganizerId,
                    message: 'No quota role configured with points for this dungeon',
                });
            }

            quotaRoleId = quotaRole.roleId;
            const pointsPerRun = quotaRole.points;
            
            // Calculate total points to be added/removed
            const totalPointsToAdd = pointsPerRun * amount;
            
            // Check if this would result in negative total quota points for the user
            const currentStats = await query<{ total_quota_points: string }>(
                `SELECT COALESCE(SUM(quota_points), 0) as total_quota_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guildId, targetOrganizerId]
            );

            const currentTotal = currentStats.rowCount && currentStats.rowCount > 0 
                ? Number(currentStats.rows[0].total_quota_points)
                : 0;

            const newTotal = currentTotal + totalPointsToAdd;

            // If the new total would be negative, adjust amount to bring them to 0 instead
            let adjustedAmount = amount;
            let adjustedTotalPoints = totalPointsToAdd;
            
            if (newTotal < 0) {
                // Calculate how many runs we can actually remove to bring to 0
                adjustedAmount = amount > 0 ? amount : Math.ceil(-currentTotal / pointsPerRun);
                adjustedTotalPoints = adjustedAmount * pointsPerRun;
            }

            // Log a single event with the total amount
            const event = await logQuotaEvent(
                guildId,
                targetOrganizerId,
                'run_completed',
                `manual_log_run:${Date.now()}:${targetOrganizerId}:${Math.abs(adjustedAmount)}`, // Unique subject_id
                dungeonKey,
                adjustedTotalPoints, // Total quota points (can be positive or negative)
                quotaRoleId // quota_role_id
            );

            if (event) {
                // Use quota_points (organizer points), NOT points (raider points)
                // Convert to number in case DB returns string
                totalPoints = Number(event.quota_points);
                loggedCount = Math.abs(adjustedAmount);
            }

            logger.info({ 
                loggedCount, 
                targetOrganizerId, 
                guildId, 
                dungeonKey, 
                pointsPerRun, 
                totalPoints,
                quotaRoleId
            }, 'Manually logged runs');

            return reply.code(200).send({
                logged: loggedCount,
                total_points: totalPoints,
                organizer_id: targetOrganizerId,
                quota_role_id: quotaRoleId,
            });
        } catch (err) {
            logger.error({ err, guildId, targetOrganizerId, dungeonKey }, 'Failed to manually log run');
            return Errors.internal(reply, 'Failed to log quota event');
        }
    });

    /**
     * POST /quota/log-key
     * Manually log key pops for a raider.
     * Authorization: actorId must have organizer role or higher.
     * Supports negative amounts to remove key pops.
     * 
     * Body: { actorId, actorRoles?, guildId, userId, dungeonKey, amount? }
     * Returns: { logged: number, new_total: number, user_id: string }
     */
    app.post('/quota/log-key', async (req, reply) => {
        const parsed = LogKeyBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { actorId, actorRoles, guildId, userId, username, userRoles, dungeonKey, amount } = parsed.data;

        // Authorization: actor must have organizer role or higher
        const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
        if (!hasOrganizerRole) {
            logger.warn({ actorId, guildId }, 'User denied - no organizer role');
            return reply.code(403).send({
                error: {
                    code: 'NOT_ORGANIZER',
                    message: 'You must have the Organizer role to log key pops',
                },
            });
        }

        // Validate amount is not zero
        if (amount === 0) {
            return Errors.validation(reply, 'Amount cannot be zero');
        }

        // Ensure guild exists
        try {
            await ensureGuildExists(guildId);
        } catch (err) {
            logger.error({ err, guildId }, 'Failed to ensure guild exists');
            return Errors.internal(reply, 'Failed to process key pop logging');
        }

        // Ensure actor exists
        try {
            await ensureMemberExists(actorId);
        } catch (err) {
            logger.error({ err, actorId }, 'Failed to ensure actor exists');
            return Errors.internal(reply, 'Failed to process key pop logging');
        }

        // Ensure target user exists in member table AND raider table
        // This will auto-verify them if they have the verified_raider role
        try {
            await ensureRaiderExists(guildId, userId, username || null, userRoles);
        } catch (err) {
            logger.error({ err, guildId, userId }, 'Failed to ensure raider exists');
            return Errors.internal(reply, 'Failed to process key pop logging');
        }

        try {
            // For now, we'll use a generic 'key' as the key_type
            // In the future, this could be enhanced to track specific key types (Shield Rune, etc.)
            const keyType = 'key';

            // Get the point value for popping keys for this dungeon
            const pointsPerKey = await getKeyPopPointsForDungeon(guildId, dungeonKey);

            // Get current key count to prevent negative values
            const currentResult = await query<{ count: number }>(
                `SELECT count FROM key_pop
                 WHERE guild_id = $1::bigint AND user_id = $2::bigint AND dungeon_key = $3 AND key_type = $4`,
                [guildId, userId, dungeonKey, keyType]
            );

            const currentCount = currentResult.rowCount && currentResult.rowCount > 0 
                ? currentResult.rows[0].count 
                : 0;

            // Calculate the new count, ensuring it doesn't go below 0
            const rawNewCount = currentCount + amount;
            const adjustedAmount = rawNewCount < 0 ? -currentCount : amount; // Adjust to bring to 0 if would be negative
            const newCount = Math.max(0, rawNewCount);

            // Upsert key_pop count with the adjusted amount
            const result = await query<{ count: number }>(
                `INSERT INTO key_pop (guild_id, user_id, dungeon_key, key_type, count, last_popped_at)
                 VALUES ($1::bigint, $2::bigint, $3, $4, $5, now())
                 ON CONFLICT (guild_id, user_id, dungeon_key, key_type)
                 DO UPDATE SET 
                    count = $5,
                    last_popped_at = now()
                 RETURNING count`,
                [guildId, userId, dungeonKey, keyType, newCount]
            );

            const newTotal = result.rows[0]?.count ?? 0;

            // Award or remove points for the keys (if points are configured)
            let totalPointsAwarded = 0;
            if (pointsPerKey > 0 && adjustedAmount !== 0) {
                // Get current point total to prevent negative values
                const currentPointsResult = await query<{ total_points: string }>(
                    `SELECT COALESCE(SUM(points), 0) as total_points
                     FROM quota_event
                     WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                    [guildId, userId]
                );

                const currentPoints = currentPointsResult.rowCount && currentPointsResult.rowCount > 0 
                    ? Number(currentPointsResult.rows[0].total_points)
                    : 0;

                const totalPointsToAdd = pointsPerKey * adjustedAmount;
                const newPointsTotal = currentPoints + totalPointsToAdd;

                // If would result in negative, adjust
                const finalPointsToAdd = newPointsTotal < 0 
                    ? -currentPoints 
                    : totalPointsToAdd;

                if (finalPointsToAdd !== 0) {
                    // Log a single quota event for all keys at once (can be positive or negative)
                    const event = await query<{ id: number; points: number }>(
                        `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                         VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                         RETURNING id, points`,
                        [guildId, userId, `key_pop:${Date.now()}:${userId}:${adjustedAmount}`, dungeonKey, finalPointsToAdd]
                    );

                    if (event.rowCount && event.rowCount > 0) {
                        totalPointsAwarded = event.rows[0].points;
                    }
                }
            }

            logger.info({ guildId, userId, dungeonKey, amount: Math.abs(adjustedAmount), newTotal, pointsAwarded: totalPointsAwarded }, 'Manually logged key pops');

            return reply.code(200).send({
                logged: Math.abs(adjustedAmount),
                new_total: newTotal,
                points_awarded: totalPointsAwarded,
                user_id: userId,
            });
        } catch (err) {
            logger.error({ err, guildId, userId, dungeonKey }, 'Failed to manually log key pops');
            return Errors.internal(reply, 'Failed to log key pops');
        }
    });

    /**
     * GET /quota/stats/:guild_id/:user_id
     * Get quota statistics for a user in a guild.
     * Returns total points (raiders), total quota points (organizers/verifiers), run counts, and per-dungeon breakdown.
     * 
     * Returns: { total_points, total_quota_points, total_runs_organized, total_verifications, dungeons: [{ dungeon_key, completed, organized }] }
     */
    app.get('/quota/stats/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });

        const parsed = Params.safeParse(req.params);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { guild_id, user_id } = parsed.data;

        try {
            const stats = await getUserQuotaStats(guild_id, user_id);
            return reply.code(200).send(stats);
        } catch (err) {
            logger.error({ err, guild_id, user_id }, 'Failed to get stats for user');
            return Errors.internal(reply, 'Failed to retrieve quota statistics');
        }
    });

    /**
     * GET /quota/config/:guild_id/:role_id
     * Get quota configuration for a specific role
     */
    app.get('/quota/config/:guild_id/:role_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });

        const parsed = Params.safeParse(req.params);
        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid parameters');
        }

        const { guild_id, role_id } = parsed.data;

        try {
            const config = await getQuotaRoleConfig(guild_id, role_id);
            const overrides = config ? await getDungeonOverrides(guild_id, role_id) : {};

            return reply.send({
                config: config || null,
                dungeon_overrides: overrides,
            });
        } catch (err) {
            logger.error({ err, guild_id, role_id }, 'Failed to get config');
            return Errors.internal(reply, 'Failed to retrieve quota configuration');
        }
    });

    /**
     * GET /quota/configs/:guild_id
     * Get all quota configurations for a guild
     */
    app.get('/quota/configs/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });

        const parsed = Params.safeParse(req.params);
        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid guild_id');
        }

        const { guild_id } = parsed.data;

        try {
            const configs = await getAllQuotaRoleConfigs(guild_id);
            
            // Get overrides for each config
            const configsWithOverrides = await Promise.all(
                configs.map(async (config) => ({
                    ...config,
                    dungeon_overrides: await getDungeonOverrides(guild_id, config.discord_role_id),
                }))
            );

            return reply.send({ configs: configsWithOverrides });
        } catch (err) {
            logger.error({ err, guild_id }, 'Failed to get configs for guild');
            return Errors.internal(reply, 'Failed to retrieve quota configurations');
        }
    });

    /**
     * PUT /quota/config/:guild_id/:role_id
     * Update quota configuration for a specific role
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, required_points?, reset_at?, moderation_points?, base_exalt_points?, base_non_exalt_points? }
     */
    app.put('/quota/config/:guild_id/:role_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            required_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Required points must have at most 2 decimal places' }
            ),
            reset_at: z.string().optional(), // ISO timestamp YYYY-MM-DDTHH:MM:SSZ
            created_at: z.string().optional(), // ISO timestamp - for resetting quota periods
            panel_message_id: zSnowflake.nullable().optional(),
            moderation_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Moderation points must have at most 2 decimal places' }
            ),
            base_exalt_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Base exalt points must have at most 2 decimal places' }
            ),
            base_non_exalt_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Base non-exalt points must have at most 2 decimal places' }
            ),
            // Individual moderation command points
            verify_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Verify points must have at most 2 decimal places' }
            ),
            warn_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Warn points must have at most 2 decimal places' }
            ),
            suspend_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Suspend points must have at most 2 decimal places' }
            ),
            modmail_reply_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Modmail reply points must have at most 2 decimal places' }
            ),
            editname_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Editname points must have at most 2 decimal places' }
            ),
            addnote_points: z.number().min(0).optional().refine(
                (val) => val === undefined || Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Addnote points must have at most 2 decimal places' }
            ),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, role_id } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, ...config } = b.data;

        // Authorization: must have admin permission or administrator role
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            const updated = await upsertQuotaRoleConfig(guild_id, role_id, config);
            const overrides = await getDungeonOverrides(guild_id, role_id);

            return reply.send({
                config: updated,
                dungeon_overrides: overrides,
            });
        } catch (err) {
            logger.error({ err, guild_id, role_id }, 'Failed to update config');
            return Errors.internal(reply, 'Failed to update quota configuration');
        }
    });

    /**
     * PUT /quota/config/:guild_id/:role_id/dungeon/:dungeon_key
     * Set dungeon point override
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, points }
     */
    app.put('/quota/config/:guild_id/:role_id/dungeon/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            points: z.number().refine(
                (val) => {
                    // Allow negative values (for deletion) without decimal check
                    if (val < 0) return true;
                    // For non-negative values, check max 2 decimal places
                    return Number.isFinite(val) && Math.round(val * 100) === val * 100;
                },
                { message: 'Points must have at most 2 decimal places (use negative to remove override)' }
            ),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, role_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, points } = b.data;

        // Authorization
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            // If points <= 0, delete the override instead of setting it
            if (points <= 0) {
                await deleteDungeonOverride(guild_id, role_id, dungeon_key);
                const overrides = await getDungeonOverrides(guild_id, role_id);
                return reply.send({ dungeon_overrides: overrides });
            }

            // Ensure quota_role_config exists before setting dungeon override
            let config = await getQuotaRoleConfig(guild_id, role_id);
            if (!config) {
                // Create default config with reset 7 days from now
                const resetDate = new Date();
                resetDate.setDate(resetDate.getDate() + 7);
                config = await upsertQuotaRoleConfig(guild_id, role_id, {
                    required_points: 0,
                    reset_at: resetDate.toISOString(),
                });
            }

            await setDungeonOverride(guild_id, role_id, dungeon_key, points);
            const overrides = await getDungeonOverrides(guild_id, role_id);

            return reply.send({ dungeon_overrides: overrides });
        } catch (err) {
            logger.error({ err, guild_id, role_id, dungeon_key }, 'Failed to set dungeon override');
            return Errors.internal(reply, 'Failed to update dungeon override');
        }
    });

    /**
     * DELETE /quota/config/:guild_id/:role_id/dungeon/:dungeon_key
     * Delete dungeon point override (revert to default)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission? }
     */
    app.delete('/quota/config/:guild_id/:role_id/dungeon/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, role_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            await deleteDungeonOverride(guild_id, role_id, dungeon_key);
            const overrides = await getDungeonOverrides(guild_id, role_id);

            return reply.send({ dungeon_overrides: overrides });
        } catch (err) {
            logger.error({ err, guild_id, role_id, dungeon_key }, 'Failed to delete dungeon override');
            return Errors.internal(reply, 'Failed to delete dungeon override');
        }
    });

    /**
     * DELETE /quota/config/:guild_id/:role_id
     * Delete entire quota configuration for a role (including all overrides and events)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission? }
     */
    app.delete('/quota/config/:guild_id/:role_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, role_id } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            const deleted = await deleteQuotaRoleConfig(guild_id, role_id);
            
            if (!deleted) {
                return reply.code(404).send({
                    error: {
                        code: 'CONFIG_NOT_FOUND',
                        message: 'No quota configuration found for this role',
                    },
                });
            }

            return reply.send({ 
                success: true,
                message: 'Quota configuration deleted successfully'
            });
        } catch (err) {
            logger.error({ err, guild_id, role_id }, 'Failed to delete quota config');
            return Errors.internal(reply, 'Failed to delete quota configuration');
        }
    });

    /**
     * POST /quota/leaderboard/:guild_id/:role_id
     * Get quota leaderboard for a specific role
     * Body: { member_user_ids: string[] }
     */
    app.post('/quota/leaderboard/:guild_id/:role_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });

        const Body = z.object({
            member_user_ids: z.array(zSnowflake),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, role_id } = p.data;
        const { member_user_ids } = b.data;

        try {
            const config = await getQuotaRoleConfig(guild_id, role_id);
            if (!config) {
                return reply.code(404).send({
                    error: {
                        code: 'CONFIG_NOT_FOUND',
                        message: 'No quota configuration found for this role',
                    },
                });
            }

            const periodStart = getQuotaPeriodStart(config);
            const periodEnd = getQuotaPeriodEnd(config);
            
            logger.info({ 
                guild_id, 
                role_id, 
                created_at: config.created_at, 
                reset_at: config.reset_at,
                period_start: periodStart.toISOString(),
                period_end: periodEnd.toISOString(),
                member_count: member_user_ids.length
            }, 'Processing quota leaderboard request');
            
            const leaderboard = await getQuotaLeaderboard(guild_id, role_id, member_user_ids, periodStart, periodEnd);
            
            logger.info({ guild_id, role_id, leaderboard_count: leaderboard.length }, 'Returning quota leaderboard entries');

            return reply.send({
                config,
                period_start: periodStart.toISOString(),
                period_end: periodEnd.toISOString(),
                leaderboard,
            });
        } catch (err) {
            logger.error({ err, guild_id, role_id }, 'Failed to get leaderboard');
            return Errors.internal(reply, 'Failed to retrieve leaderboard');
        }
    });

    /**
     * GET /quota/raider-points/:guild_id
     * Get raider points configuration for all dungeons in a guild
     * Returns: { dungeon_points: { [dungeonKey]: points } }
     */
    app.get('/quota/raider-points/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });

        const parsed = Params.safeParse(req.params);
        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid guild_id');
        }

        const { guild_id } = parsed.data;

        try {
            const dungeonPoints = await getRaiderPointsConfig(guild_id);
            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id }, 'Failed to get raider points config');
            return Errors.internal(reply, 'Failed to retrieve raider points configuration');
        }
    });

    /**
     * PUT /quota/raider-points/:guild_id/:dungeon_key
     * Set raider points for a specific dungeon
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, points }
     */
    app.put('/quota/raider-points/:guild_id/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            points: z.number().min(0).refine(
                (val) => Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Points must have at most 2 decimal places' }
            ),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, points } = b.data;

        // Authorization: must have admin permission or administrator role
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            await setRaiderPointsForDungeon(guild_id, dungeon_key, points);
            const dungeonPoints = await getRaiderPointsConfig(guild_id);

            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id, dungeon_key, points }, 'Failed to set raider points');
            return Errors.internal(reply, 'Failed to update raider points configuration');
        }
    });

    /**
     * DELETE /quota/raider-points/:guild_id/:dungeon_key
     * Delete raider points for a specific dungeon (revert to default 0)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission? }
     */
    app.delete('/quota/raider-points/:guild_id/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            await deleteRaiderPointsForDungeon(guild_id, dungeon_key);
            const dungeonPoints = await getRaiderPointsConfig(guild_id);

            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id, dungeon_key }, 'Failed to delete raider points');
            return Errors.internal(reply, 'Failed to delete raider points configuration');
        }
    });

    /**
     * GET /quota/key-pop-points/:guild_id
     * Get key pop points configuration for all dungeons in a guild
     * Returns: { dungeon_points: { [dungeonKey]: points } }
     */
    app.get('/quota/key-pop-points/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });

        const parsed = Params.safeParse(req.params);
        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid guild_id');
        }

        const { guild_id } = parsed.data;

        try {
            const dungeonPoints = await getKeyPopPointsConfig(guild_id);
            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id }, 'Failed to get key pop points config');
            return Errors.internal(reply, 'Failed to retrieve key pop points configuration');
        }
    });

    /**
     * PUT /quota/key-pop-points/:guild_id/:dungeon_key
     * Set key pop points for a specific dungeon
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, points }
     */
    app.put('/quota/key-pop-points/:guild_id/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            points: z.number().min(0).refine(
                (val) => Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Points must have at most 2 decimal places' }
            ),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, points } = b.data;

        // Authorization: must have admin permission or administrator role
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            await setKeyPopPointsForDungeon(guild_id, dungeon_key, points);
            const dungeonPoints = await getKeyPopPointsConfig(guild_id);

            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id, dungeon_key, points }, 'Failed to set key pop points');
            return Errors.internal(reply, 'Failed to update key pop points configuration');
        }
    });

    /**
     * DELETE /quota/key-pop-points/:guild_id/:dungeon_key
     * Delete key pop points for a specific dungeon (revert to default 0)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission? }
     */
    app.delete('/quota/key-pop-points/:guild_id/:dungeon_key', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            dungeon_key: z.string(),
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, dungeon_key } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        try {
            await deleteKeyPopPointsForDungeon(guild_id, dungeon_key);
            const dungeonPoints = await getKeyPopPointsConfig(guild_id);

            return reply.send({ dungeon_points: dungeonPoints });
        } catch (err) {
            logger.error({ err, guild_id, dungeon_key }, 'Failed to delete key pop points');
            return Errors.internal(reply, 'Failed to delete key pop points configuration');
        }
    });

    /**
     * POST /quota/adjust-quota-points/:guild_id/:user_id
     * Manually adjust quota points for a user (supports negative values)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, amount, quota_role_id }
     * quota_role_id is REQUIRED to specify which quota panel these points belong to
     */
    app.post('/quota/adjust-quota-points/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            amount: z.number().refine(
                (val) => Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Amount must have at most 2 decimal places' }
            ),
            quota_role_id: zSnowflake, // REQUIRED: Which quota role these points belong to
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, user_id } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, amount, quota_role_id } = b.data;

        // Authorization: must have admin permission or administrator role
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        // Ensure guild and member exist
        try {
            await ensureGuildExists(guild_id);
            await ensureMemberExists(user_id);
        } catch (err) {
            logger.error({ err, guild_id, user_id }, 'Failed to upsert guild/member');
            return Errors.internal(reply, 'Failed to prepare database records');
        }

        try {
            // Get current total to prevent negative values
            const currentStats = await query<{ total_quota_points: string }>(
                `SELECT COALESCE(SUM(quota_points), 0) as total_quota_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const currentTotal = currentStats.rowCount && currentStats.rowCount > 0 
                ? Number(currentStats.rows[0].total_quota_points)
                : 0;

            // Calculate new total and adjust if it would be negative
            const newTotal = currentTotal + amount;
            const adjustedAmount = newTotal < 0 ? -currentTotal : amount;

            // Insert a quota event with the adjusted amount
            const result = await query<{ id: number; quota_points: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, quota_points, points, quota_role_id)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, 0, $5::bigint)
                 RETURNING id, quota_points`,
                [guild_id, user_id, `manual_adjust:${Date.now()}:${user_id}`, adjustedAmount, quota_role_id]
            );

            if (!result.rowCount || result.rowCount === 0) {
                return Errors.internal(reply, 'Failed to adjust quota points');
            }

            // Get updated total for the user
            const updatedStats = await query<{ total_quota_points: string }>(
                `SELECT COALESCE(SUM(quota_points), 0) as total_quota_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const totalQuotaPoints = updatedStats.rowCount && updatedStats.rowCount > 0 
                ? Number(updatedStats.rows[0].total_quota_points)
                : 0;

            return reply.send({
                success: true,
                amount_adjusted: result.rows[0].quota_points,
                new_total: totalQuotaPoints,
                quota_role_id,
            });
        } catch (err) {
            logger.error({ err, guild_id, user_id, amount, quota_role_id }, 'Failed to adjust quota points');
            return Errors.internal(reply, 'Failed to adjust quota points');
        }
    });

    /**
     * POST /quota/adjust-points/:guild_id/:user_id
     * Manually adjust regular (raider) points for a user (supports negative values)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, amount }
     */
    app.post('/quota/adjust-points/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin_permission: z.boolean().optional(),
            amount: z.number().refine(
                (val) => Number.isFinite(val) && Math.round(val * 100) === val * 100,
                { message: 'Amount must have at most 2 decimal places' }
            ),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, user_id } = p.data;
        const { actor_user_id, actor_roles, actor_has_admin_permission, amount } = b.data;

        // Authorization: must have admin permission or administrator role
        let authorized = false;
        if (actor_has_admin_permission) {
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
        }

        if (!authorized) {
            return Errors.notAuthorized(reply);
        }

        // Ensure guild and member exist
        try {
            await ensureGuildExists(guild_id);
            await ensureMemberExists(user_id);
        } catch (err) {
            logger.error({ err, guild_id, user_id }, 'Failed to upsert guild/member for points adjustment');
            return Errors.internal(reply, 'Failed to prepare database records');
        }

        try {
            // Get current total to prevent negative values
            const currentStats = await query<{ total_points: string }>(
                `SELECT COALESCE(SUM(points), 0) as total_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const currentTotal = currentStats.rowCount && currentStats.rowCount > 0 
                ? Number(currentStats.rows[0].total_points)
                : 0;

            // Calculate new total and adjust if it would be negative
            const newTotal = currentTotal + amount;
            const adjustedAmount = newTotal < 0 ? -currentTotal : amount;

            // Insert a quota event with the adjusted amount
            const result = await query<{ id: number; points: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, points, quota_points)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, 0)
                 RETURNING id, points`,
                [guild_id, user_id, `manual_adjust_points:${Date.now()}:${user_id}`, adjustedAmount]
            );

            if (!result.rowCount || result.rowCount === 0) {
                return Errors.internal(reply, 'Failed to adjust points');
            }

            // Get updated total for the user
            const updatedStats = await query<{ total_points: string }>(
                `SELECT COALESCE(SUM(points), 0) as total_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const totalPoints = updatedStats.rowCount && updatedStats.rowCount > 0 
                ? Number(updatedStats.rows[0].total_points)
                : 0;

            return reply.send({
                success: true,
                amount_adjusted: result.rows[0].points,
                new_total: totalPoints,
            });
        } catch (err) {
            logger.error({ err, guild_id, user_id, amount }, 'Failed to adjust points');
            return Errors.internal(reply, 'Failed to adjust points');
        }
    });

    /**
     * GET /quota/leaderboard/:guild_id
     * Get leaderboard for a category (runs organized, keys popped, dungeon completions, points, or quota points)
     * Query params: 
     *   - category (required): runs_organized, keys_popped, dungeon_completions, points, or quota_points
     *   - dungeon_key (optional): specific dungeon or 'all' (defaults to 'all')
     *   - since (optional): ISO date string for start date (inclusive)
     *   - until (optional): ISO date string for end date (inclusive)
     * 
     * Returns: { leaderboard: Array<{ user_id: string; count: number }> }
     */
    app.get('/quota/leaderboard/:guild_id', async (req, reply) => {
        const { guild_id } = req.params as { guild_id: string };
        const { category, dungeon_key, since, until } = req.query as { 
            category?: string; 
            dungeon_key?: string; 
            since?: string;
            until?: string;
        };

        // Validate category
        const validCategories = ['runs_organized', 'keys_popped', 'dungeon_completions', 'points', 'quota_points'];
        if (!category || !validCategories.includes(category)) {
            return Errors.validation(reply, `Invalid or missing category. Must be one of: ${validCategories.join(', ')}`);
        }

        // Parse dates if provided
        let sinceDate: Date | undefined;
        let untilDate: Date | undefined;

        if (since) {
            sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) {
                return Errors.validation(reply, 'Invalid "since" date format. Use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ)');
            }
        }

        if (until) {
            untilDate = new Date(until);
            if (isNaN(untilDate.getTime())) {
                return Errors.validation(reply, 'Invalid "until" date format. Use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ)');
            }
        }

        try {
            const leaderboard = await getLeaderboard(
                guild_id,
                category as 'runs_organized' | 'keys_popped' | 'dungeon_completions' | 'points' | 'quota_points',
                dungeon_key || 'all',
                sinceDate,
                untilDate
            );

            return reply.send({
                guild_id,
                category,
                dungeon_key: dungeon_key || 'all',
                since: since || null,
                until: until || null,
                leaderboard,
            });
        } catch (err) {
            logger.error({ err, guild_id, category, dungeon_key }, 'Failed to get leaderboard');
            return Errors.internal(reply, 'Failed to retrieve leaderboard');
        }
    });

    /**
     * POST /quota/award-moderation-points/:guild_id/:user_id
     * Award moderation points to a user for moderation activities
     * This is called automatically when staff perform moderation actions
     * 
     * Body: { actor_user_id, actor_roles?, actor_role_positions?, command_type? }
     * command_type: 'verify' | 'warn' | 'suspend' | 'modmail_reply' | 'editname' | 'addnote'
     * actor_role_positions: Record<roleId, position> - Discord role positions for failsafe
     * Returns: { points_awarded: number, quota_role_id?: string }
     */
    app.post('/quota/award-moderation-points/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });

        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            actor_role_positions: z.record(z.string(), z.number()).optional(),
            command_type: z.enum(['verify', 'warn', 'suspend', 'modmail_reply', 'editname', 'addnote']).optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { guild_id, user_id } = p.data;
        const { actor_user_id, actor_roles, actor_role_positions, command_type } = b.data;

        // Default to 'verify' for backward compatibility
        const cmdType = command_type || 'verify';

        // Authorization: actor must have security role or higher
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err: any) {
            logger.warn({ actor_user_id, guild_id }, 'User denied - insufficient permissions');
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: err.message || 'You need the Security role or higher to award moderation points',
                },
            });
        }

        // Ensure both actor and target user exist in the member table
        try {
            await ensureGuildExists(guild_id);
            await ensureMemberExists(actor_user_id);
            await ensureMemberExists(user_id);
        } catch (err) {
            logger.error({ err, guild_id, actor_user_id, user_id }, 'Failed to ensure members exist');
            return Errors.internal(reply, 'Failed to process moderation points');
        }

        try {
            // Get all quota role configs for this guild to find command-specific point settings
            const configs = await getAllQuotaRoleConfigs(guild_id);
            
            // Filter to only configs where the user has the role AND the specific command has points > 0
            const relevantConfigs = configs.filter(config => {
                const hasRole = actor_roles?.includes(config.discord_role_id);
                if (!hasRole) return false;

                // Check the appropriate point field based on command_type
                let hasPoints = false;
                switch (cmdType) {
                    case 'verify':
                        hasPoints = config.verify_points > 0;
                        break;
                    case 'warn':
                        hasPoints = config.warn_points > 0;
                        break;
                    case 'suspend':
                        hasPoints = config.suspend_points > 0;
                        break;
                    case 'modmail_reply':
                        hasPoints = config.modmail_reply_points > 0;
                        break;
                    case 'editname':
                        hasPoints = config.editname_points > 0;
                        break;
                    case 'addnote':
                        hasPoints = config.addnote_points > 0;
                        break;
                }

                return hasPoints;
            });

            // If no roles apply, log with 0 points
            if (relevantConfigs.length === 0) {
                await logQuotaEvent(
                    guild_id,
                    user_id,
                    'verify_member',
                    `${cmdType}:${Date.now()}:${user_id}`,
                    undefined,
                    0,
                    undefined
                );
                logger.info({ user_id, guild_id, cmdType }, 'Logged action with 0 points - no quota config');
                return reply.send({
                    points_awarded: 0,
                    message: `No points configured for ${cmdType} command in your roles`,
                });
            }

            // Determine the winning role (highest Discord position)
            let winningConfig = relevantConfigs[0];
            if (relevantConfigs.length > 1) {
                logger.warn({ 
                    guild_id, 
                    actor_user_id, 
                    cmdType, 
                    roleCount: relevantConfigs.length,
                    roleIds: relevantConfigs.map(c => c.discord_role_id)
                }, 'Multiple quota roles could apply for moderation action - using highest role by position');
                
                if (actor_role_positions) {
                    // Sort by Discord role position (higher position = higher authority)
                    relevantConfigs.sort((a, b) => 
                        (actor_role_positions[b.discord_role_id] ?? 0) - (actor_role_positions[a.discord_role_id] ?? 0)
                    );
                    winningConfig = relevantConfigs[0];
                }
            }

            // Get points for winning role
            let pointsToAward = 0;
            switch (cmdType) {
                case 'verify':
                    pointsToAward = winningConfig.verify_points;
                    break;
                case 'warn':
                    pointsToAward = winningConfig.warn_points;
                    break;
                case 'suspend':
                    pointsToAward = winningConfig.suspend_points;
                    break;
                case 'modmail_reply':
                    pointsToAward = winningConfig.modmail_reply_points;
                    break;
                case 'editname':
                    pointsToAward = winningConfig.editname_points;
                    break;
                case 'addnote':
                    pointsToAward = winningConfig.addnote_points;
                    break;
            }

            // Award points from winning role only
            const event = await logQuotaEvent(
                guild_id,
                user_id,
                'verify_member',
                `${cmdType}:${Date.now()}:${user_id}`, // Unique subject_id per action
                undefined, // No dungeon key for moderation actions
                pointsToAward,
                winningConfig.discord_role_id // quota_role_id
            );

            const pointsAwarded = event ? Number(event.quota_points) : 0;

            logger.info({ 
                user_id, 
                guild_id, 
                pointsAwarded, 
                quotaRoleId: winningConfig.discord_role_id,
                cmdType
            }, 'Awarded moderation points');

            return reply.send({
                points_awarded: pointsAwarded,
                quota_role_id: winningConfig.discord_role_id,
            });
        } catch (err) {
            logger.error({ err, guild_id, user_id, cmdType }, 'Failed to award moderation points');
            return Errors.internal(reply, 'Failed to award moderation points');
        }
    });

    /**
     * POST /quota/recalculate/:guild_id/:role_id
     * Recalculate quota points for all run_completed events in the current quota period.
     * Fetches all organized runs and recalculates their points based on current configuration.
     * 
     * This is useful when:
     * - Point values change and you want to retroactively apply them
     * - Manual logs were created with incorrect point values
     * - You want to ensure consistency between config and stored points
     * 
     * Authorization: actorId must have admin permission or be managing guild roles
     */
    app.post('/quota/recalculate/:guild_id/:role_id', async (req, reply) => {
        const ParamsSchema = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });

        const BodySchema = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            actorHasAdminPermission: z.boolean().optional(),
        });

        const paramsResult = ParamsSchema.safeParse(req.params);
        const bodyResult = BodySchema.safeParse(req.body);

        if (!paramsResult.success) {
            const msg = paramsResult.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        if (!bodyResult.success) {
            const msg = bodyResult.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { guild_id, role_id } = paramsResult.data;
        const { actorId, actorRoles } = bodyResult.data;

        // Authorization: actor must have admin permission
        const canManage = await canManageGuildRoles(guild_id, actorId, actorRoles);
        if (!canManage) {
            logger.warn({ actorId, guild_id }, 'User denied recalculate - no admin permission');
            return reply.code(403).send({
                error: {
                    code: 'FORBIDDEN',
                    message: 'Administrator permission required',
                },
            });
        }

        try {
            const result = await recalculateQuotaPoints(guild_id, role_id);
            
            logger.info({ guild_id, role_id, recalculated: result.recalculated, total_points: result.total_points }, 'Recalculated quota points');

            return reply.send({
                recalculated: result.recalculated,
                total_points: result.total_points,
                message: `Successfully recalculated ${result.recalculated} events`,
            });
        } catch (err) {
            logger.error({ err, guild_id, role_id }, 'Failed to recalculate quota points');
            return Errors.internal(reply, 'Failed to recalculate quota points');
        }
    });
}


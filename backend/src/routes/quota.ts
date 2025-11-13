// backend/src/routes/quota.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';
import { hasInternalRole, canManageGuildRoles } from '../lib/authorization.js';
import { ensureGuildExists, ensureMemberExists } from '../lib/database-helpers.js';
import { 
    logQuotaEvent, 
    isRunAlreadyLogged, 
    getUserQuotaStats,
    getQuotaRoleConfig,
    getAllQuotaRoleConfigs,
    upsertQuotaRoleConfig,
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
} from '../lib/quota.js';

/**
 * Body schema for manually logging run quota.
 */
const LogRunBody = z.object({
    actorId: zSnowflake,
    actorRoles: z.array(zSnowflake).optional(),
    guildId: zSnowflake,
    runId: z.number().int().positive().optional(), // Optional if dungeonKey is provided
    dungeonKey: z.string().optional(), // Optional dungeon key - will find most recent run
    amount: z.number().int().default(1), // Can be negative to remove quota
});

/**
 * Body schema for manually logging key pops.
 */
const LogKeyBody = z.object({
    actorId: zSnowflake,
    actorRoles: z.array(zSnowflake).optional(),
    guildId: zSnowflake,
    userId: zSnowflake, // The user who popped the key
    dungeonKey: z.string(), // The dungeon the key is for
    amount: z.number().int().default(1), // Can be negative to remove key pops
});

export default async function quotaRoutes(app: FastifyInstance) {
    /**
     * POST /quota/log-run
     * Manually log run completion quota for an organizer.
     * Authorization: actorId must have organizer role or higher.
     * No idempotency: Can be called multiple times for the same run.
     * Supports negative amounts to remove quota points.
     * 
     * Body: { actorId, actorRoles?, guildId, runId?, dungeonKey?, amount? }
     * Returns: { logged: number, already_logged: false, total_points: number, organizer_id: string }
     */
    app.post('/quota/log-run', async (req, reply) => {
        const parsed = LogRunBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        let { actorId, actorRoles, guildId, runId, dungeonKey, amount } = parsed.data;

        // Validate that either runId or dungeonKey is provided
        if (!runId && !dungeonKey) {
            return Errors.validation(reply, 'Either runId or dungeonKey must be provided');
        }

        // If dungeonKey is provided but not runId, find the most recent run
        if (dungeonKey && !runId) {
            const recentRunRes = await query<{ id: number }>(
                `SELECT id FROM run 
                 WHERE guild_id = $1::bigint 
                   AND organizer_id = $2::bigint 
                   AND dungeon_key = $3
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [guildId, actorId, dungeonKey]
            );

            if (recentRunRes.rowCount === 0) {
                return reply.code(404).send({
                    error: {
                        code: 'RUN_NOT_FOUND',
                        message: `No ${dungeonKey} runs found for organizer ${actorId}`,
                    },
                });
            }

            runId = recentRunRes.rows[0].id;
        }

        // Authorization: actor must have organizer role or higher
        const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
        if (!hasOrganizerRole) {
            console.log(`[Quota] User ${actorId} in guild ${guildId} denied - no organizer role`);
            return reply.code(403).send({
                error: {
                    code: 'NOT_ORGANIZER',
                    message: 'You must have the Organizer role to log runs',
                },
            });
        }

        // Verify run exists and get organizer and dungeon_key
        const runRes = await query<{ organizer_id: string; guild_id: string; status: string; dungeon_key: string }>(
            `SELECT organizer_id, guild_id, status, dungeon_key FROM run WHERE id = $1::bigint`,
            [runId]
        );

        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }

        const run = runRes.rows[0];

        // Verify run is in the correct guild
        if (run.guild_id !== guildId) {
            return reply.code(400).send({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: `Run ${runId} does not belong to guild ${guildId}`,
                },
            });
        }

        // Log quota events for the organizer
        const organizerId = run.organizer_id;
        const runDungeonKey = run.dungeon_key;
        let totalPoints = 0;
        let loggedCount = 0;

        try {
            // Get the correct point value for this dungeon based on guild config
            const pointsPerRun = await getPointsForDungeon(guildId, runDungeonKey, actorRoles);
            
            // Log events based on amount (can be positive or negative)
            const absoluteAmount = Math.abs(amount);
            
            for (let i = 0; i < absoluteAmount; i++) {
                const event = await logQuotaEvent(
                    guildId,
                    organizerId,
                    'run_completed',
                    undefined, // No subject_id - allow unlimited logging
                    runDungeonKey,
                    amount > 0 ? pointsPerRun : -pointsPerRun // Apply calculated points (positive or negative)
                );

                if (event) {
                    totalPoints += event.points;
                    loggedCount += 1;
                }
            }

            console.log(`[Quota] Manually logged ${loggedCount} run(s) for organizer ${organizerId} in guild ${guildId} (dungeon: ${runDungeonKey}, points per run: ${pointsPerRun}, total points: ${totalPoints})`);

            return reply.code(200).send({
                logged: loggedCount,
                already_logged: false,
                total_points: totalPoints,
                organizer_id: organizerId,
            });
        } catch (err) {
            console.error(`[Quota] Failed to manually log run:`, err);
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

        const { actorId, actorRoles, guildId, userId, dungeonKey, amount } = parsed.data;

        // Authorization: actor must have organizer role or higher
        const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
        if (!hasOrganizerRole) {
            console.log(`[Quota] User ${actorId} in guild ${guildId} denied - no organizer role`);
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

        try {
            // For now, we'll use a generic 'key' as the key_type
            // In the future, this could be enhanced to track specific key types (Shield Rune, etc.)
            const keyType = 'key';

            // Get the point value for popping keys for this dungeon
            const pointsPerKey = await getKeyPopPointsForDungeon(guildId, dungeonKey);

            // Upsert key_pop count
            const result = await query<{ count: number }>(
                `INSERT INTO key_pop (guild_id, user_id, dungeon_key, key_type, count, last_popped_at)
                 VALUES ($1::bigint, $2::bigint, $3, $4, $5, now())
                 ON CONFLICT (guild_id, user_id, dungeon_key, key_type)
                 DO UPDATE SET 
                    count = GREATEST(0, key_pop.count + $5),
                    last_popped_at = now()
                 RETURNING count`,
                [guildId, userId, dungeonKey, keyType, amount]
            );

            const newTotal = result.rows[0]?.count ?? 0;

            // Award points to the user if configured (only for positive amounts)
            let totalPointsAwarded = 0;
            if (pointsPerKey > 0 && amount > 0) {
                const totalPoints = pointsPerKey * amount;
                
                // Log quota event for each key popped
                for (let i = 0; i < amount; i++) {
                    const event = await query<{ id: number; points: number }>(
                        `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
                         VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
                         RETURNING id, points`,
                        [guildId, userId, `key_pop:${Date.now()}:${userId}:${i}`, dungeonKey, pointsPerKey]
                    );

                    if (event.rowCount && event.rowCount > 0) {
                        totalPointsAwarded += event.rows[0].points;
                    }
                }
            }

            console.log(`[Quota] Manually logged ${amount} key pop(s) for user ${userId} in guild ${guildId} (dungeon: ${dungeonKey}, new total: ${newTotal}, points awarded: ${totalPointsAwarded})`);

            return reply.code(200).send({
                logged: Math.abs(amount),
                new_total: newTotal,
                points_awarded: totalPointsAwarded,
                user_id: userId,
            });
        } catch (err) {
            console.error(`[Quota] Failed to manually log key pops:`, err);
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
            console.error(`[Quota] Failed to get stats for user ${user_id} in guild ${guild_id}:`, err);
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
            console.error(`[Quota] Failed to get config:`, err);
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
            console.error(`[Quota] Failed to get configs for guild ${guild_id}:`, err);
            return Errors.internal(reply, 'Failed to retrieve quota configurations');
        }
    });

    /**
     * PUT /quota/config/:guild_id/:role_id
     * Update quota configuration for a specific role
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, required_points?, reset_at? }
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
            required_points: z.number().int().min(0).optional(),
            reset_at: z.string().optional(), // ISO timestamp YYYY-MM-DDTHH:MM:SSZ
            created_at: z.string().optional(), // ISO timestamp - for resetting quota periods
            panel_message_id: zSnowflake.nullable().optional(),
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
            console.error(`[Quota] Failed to update config:`, err);
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
            points: z.number().int().min(0),
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
            console.error(`[Quota] Failed to set dungeon override:`, err);
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
            console.error(`[Quota] Failed to delete dungeon override:`, err);
            return Errors.internal(reply, 'Failed to delete dungeon override');
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
            
            console.log(`[Quota Leaderboard] Config created_at: ${config.created_at}, reset_at: ${config.reset_at}`);
            console.log(`[Quota Leaderboard] Period: ${periodStart.toISOString()} to ${periodEnd.toISOString()}`);
            
            const leaderboard = await getQuotaLeaderboard(guild_id, role_id, member_user_ids, periodStart, periodEnd);
            
            console.log(`[Quota Leaderboard] Found ${leaderboard.length} entries for ${member_user_ids.length} members`);

            return reply.send({
                config,
                period_start: periodStart.toISOString(),
                period_end: periodEnd.toISOString(),
                leaderboard,
            });
        } catch (err) {
            console.error(`[Quota] Failed to get leaderboard:`, err);
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
            console.error(`[Quota] Failed to get raider points config:`, err);
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
            points: z.number().int().min(0),
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
            console.error(`[Quota] Failed to set raider points:`, err);
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
            console.error(`[Quota] Failed to delete raider points:`, err);
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
            console.error(`[Quota] Failed to get key pop points config:`, err);
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
            points: z.number().int().min(0),
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
            console.error(`[Quota] Failed to set key pop points:`, err);
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
            console.error(`[Quota] Failed to delete key pop points:`, err);
            return Errors.internal(reply, 'Failed to delete key pop points configuration');
        }
    });

    /**
     * POST /quota/adjust-quota-points/:guild_id/:user_id
     * Manually adjust quota points for a user (supports negative values)
     * Body: { actor_user_id, actor_roles?, actor_has_admin_permission?, amount }
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
            amount: z.number().int(), // Can be negative
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
            console.error(`[Quota] Failed to upsert guild/member:`, err);
            return Errors.internal(reply, 'Failed to prepare database records');
        }

        try {
            // Insert a quota event with the specified amount
            const result = await query<{ id: number; quota_points: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, quota_points, points)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, 0)
                 RETURNING id, quota_points`,
                [guild_id, user_id, `manual_adjust:${Date.now()}:${user_id}`, amount]
            );

            if (!result.rowCount || result.rowCount === 0) {
                return Errors.internal(reply, 'Failed to adjust quota points');
            }

            // Get updated total for the user
            const stats = await query<{ total_quota_points: string }>(
                `SELECT COALESCE(SUM(quota_points), 0) as total_quota_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const totalQuotaPoints = stats.rowCount && stats.rowCount > 0 
                ? Number(stats.rows[0].total_quota_points)
                : 0;

            return reply.send({
                success: true,
                amount_adjusted: result.rows[0].quota_points,
                new_total: totalQuotaPoints,
            });
        } catch (err) {
            console.error(`[Quota] Failed to adjust quota points:`, err);
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
            amount: z.number().int(), // Can be negative
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
            console.error(`[Quota] Failed to upsert guild/member:`, err);
            return Errors.internal(reply, 'Failed to prepare database records');
        }

        try {
            // Insert a quota event with the specified amount
            const result = await query<{ id: number; points: number }>(
                `INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, points, quota_points)
                 VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, 0)
                 RETURNING id, points`,
                [guild_id, user_id, `manual_adjust_points:${Date.now()}:${user_id}`, amount]
            );

            if (!result.rowCount || result.rowCount === 0) {
                return Errors.internal(reply, 'Failed to adjust points');
            }

            // Get updated total for the user
            const stats = await query<{ total_points: string }>(
                `SELECT COALESCE(SUM(points), 0) as total_points
                 FROM quota_event
                 WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
                [guild_id, user_id]
            );

            const totalPoints = stats.rowCount && stats.rowCount > 0 
                ? Number(stats.rows[0].total_points)
                : 0;

            return reply.send({
                success: true,
                amount_adjusted: result.rows[0].points,
                new_total: totalPoints,
            });
        } catch (err) {
            console.error(`[Quota] Failed to adjust points:`, err);
            return Errors.internal(reply, 'Failed to adjust points');
        }
    });
}

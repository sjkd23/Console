// backend/src/routes/punishments.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';
import { logAudit } from '../lib/audit.js';
import { hasModerator } from '../lib/permissions.js';

/**
 * Schema for creating a punishment
 */
const CreatePunishmentBody = z.object({
    actor_user_id: zSnowflake,
    guild_id: zSnowflake,
    user_id: zSnowflake,
    type: z.enum(['warn', 'suspend']),
    reason: z.string().min(1).max(500),
    duration_minutes: z.number().int().positive().optional(), // Only for suspensions
    actor_roles: z.array(zSnowflake).optional(),
});

/**
 * Schema for removing a punishment
 */
const RemovePunishmentBody = z.object({
    actor_user_id: zSnowflake,
    removal_reason: z.string().min(1).max(500),
    actor_roles: z.array(zSnowflake).optional(),
});

/**
 * Helper to deactivate expired suspensions
 */
async function deactivateExpiredSuspensions() {
    await query(`SELECT deactivate_expired_suspensions()`);
}

export default async function punishmentsRoutes(app: FastifyInstance) {
    /**
     * POST /punishments
     * Create a new punishment (warn or suspend)
     * Returns the created punishment record
     */
    app.post('/punishments', async (req, reply) => {
        const parsed = CreatePunishmentBody.safeParse(req.body);

        if (!parsed.success) {
            console.error('[Punishments] Validation failed for POST /punishments:', {
                issues: parsed.error.issues,
                body: req.body,
            });
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { actor_user_id, guild_id, user_id, type, reason, duration_minutes, actor_roles } = parsed.data;

        // Authorization check
        const authorized = await hasModerator(guild_id, actor_roles);
        if (!authorized) {
            console.log(`[Punishments] User ${actor_user_id} in guild ${guild_id} denied - not moderator`);
            return Errors.notAuthorized(reply);
        }

        // Validate duration for suspensions
        if (type === 'suspend' && !duration_minutes) {
            return Errors.validation(reply, 'Suspensions require a duration_minutes value');
        }

        // Calculate expiration for suspensions
        const expiresAt = type === 'suspend' && duration_minutes
            ? new Date(Date.now() + duration_minutes * 60 * 1000).toISOString()
            : null;

        try {
            // Generate a cryptographically secure random 24-character hex ID
            const punishmentId = randomBytes(12).toString('hex'); // 12 bytes = 24 hex characters

            // Create punishment
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                type: string;
                reason: string;
                expires_at: string | null;
                active: boolean;
                created_at: string;
            }>(
                `INSERT INTO punishment (id, guild_id, user_id, moderator_id, type, reason, expires_at, active, created_at)
                 VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, $6, $7::timestamptz, TRUE, NOW())
                 RETURNING id, guild_id, user_id, moderator_id, type, reason, expires_at, active, created_at`,
                [punishmentId, guild_id, user_id, actor_user_id, type, reason, expiresAt]
            );

            const punishment = result.rows[0];

            // Log audit event
            await logAudit(guild_id, actor_user_id, `punishment.${type}`, user_id, {
                punishment_id: punishment.id,
                reason,
                expires_at: expiresAt,
            });

            return reply.status(201).send({
                id: punishment.id,
                guild_id: punishment.guild_id,
                user_id: punishment.user_id,
                moderator_id: punishment.moderator_id,
                type: punishment.type,
                reason: punishment.reason,
                expires_at: punishment.expires_at,
                active: punishment.active,
                created_at: punishment.created_at,
            });
        } catch (err) {
            console.error('[Punishments] Failed to create punishment:', err);
            return Errors.internal(reply, 'Failed to create punishment');
        }
    });

    /**
     * GET /punishments/:id
     * Get a specific punishment by ID
     */
    app.get('/punishments/:id', async (req, reply) => {
        // Accept any string ID to support legacy numeric IDs during migration
        const Params = z.object({ id: z.string().min(1).max(50) });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid punishment ID');
        }

        const { id } = parsed.data;

        // Deactivate expired suspensions first
        await deactivateExpiredSuspensions();

        try {
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                type: string;
                reason: string;
                expires_at: string | null;
                active: boolean;
                created_at: string;
                removed_at: string | null;
                removed_by: string | null;
                removal_reason: string | null;
            }>(
                `SELECT id, guild_id, user_id, moderator_id, type, reason, expires_at, active, created_at,
                        removed_at, removed_by, removal_reason
                 FROM punishment
                 WHERE id = $1`,
                [id]
            );

            if (result.rows.length === 0) {
                return Errors.punishmentNotFound(reply);
            }

            return reply.send(result.rows[0]);
        } catch (err) {
            console.error('[Punishments] Failed to get punishment:', err);
            return Errors.internal(reply, 'Failed to retrieve punishment');
        }
    });

    /**
     * GET /punishments/user/:guild_id/:user_id
     * Get all punishments for a user in a guild
     * Query params: active (boolean, optional) - filter by active status
     */
    app.get('/punishments/user/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });
        const Query = z.object({
            active: z.enum(['true', 'false']).optional(),
        });

        const p = Params.safeParse(req.params);
        const q = Query.safeParse(req.query);

        if (!p.success || !q.success) {
            return Errors.validation(reply, 'Invalid parameters');
        }

        const { guild_id, user_id } = p.data;
        const { active } = q.data;

        // Deactivate expired suspensions first
        await deactivateExpiredSuspensions();

        try {
            let sql = `
                SELECT id, guild_id, user_id, moderator_id, type, reason, expires_at, active, created_at,
                       removed_at, removed_by, removal_reason
                FROM punishment
                WHERE guild_id = $1::bigint AND user_id = $2::bigint
            `;
            const params: any[] = [guild_id, user_id];

            if (active !== undefined) {
                sql += ` AND active = $3`;
                params.push(active === 'true');
            }

            sql += ` ORDER BY created_at DESC`;

            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                type: string;
                reason: string;
                expires_at: string | null;
                active: boolean;
                created_at: string;
                removed_at: string | null;
                removed_by: string | null;
                removal_reason: string | null;
            }>(sql, params);

            return reply.send({
                punishments: result.rows,
            });
        } catch (err) {
            console.error('[Punishments] Failed to get user punishments:', err);
            return Errors.internal(reply, 'Failed to retrieve punishments');
        }
    });

    /**
     * GET /punishments/expired
     * Get all expired suspensions that need role removal
     * Returns guild_id, user_id, and punishment id for each
     */
    app.get('/punishments/expired', async (req, reply) => {
        // First deactivate any expired suspensions
        await deactivateExpiredSuspensions();

        try {
            // Get all suspensions that:
            // 1. Are inactive (active=FALSE) 
            // 2. Expired naturally (expires_at <= NOW())
            // 3. Were NOT manually removed (removed_by IS NULL)
            // 4. Haven't been processed yet (we'll mark them after processing)
            const result = await query<{
                guild_id: string;
                user_id: string;
                id: string;
                moderator_id: string;
                reason: string;
                expires_at: string;
            }>(
                `SELECT guild_id, user_id, id, moderator_id, reason, expires_at
                 FROM punishment
                 WHERE type = 'suspend'
                   AND active = FALSE
                   AND expires_at IS NOT NULL
                   AND expires_at <= NOW()
                   AND removed_by IS NULL
                   AND removed_at IS NULL
                 ORDER BY expires_at ASC`,
                []
            );

            return reply.send({
                expired: result.rows,
            });
        } catch (err) {
            console.error('[Punishments] Failed to get expired suspensions:', err);
            return Errors.internal(reply, 'Failed to retrieve expired suspensions');
        }
    });

    /**
     * POST /punishments/:id/expire
     * Mark a suspension as expired (processed by bot)
     * This is called by the bot after successfully removing the suspended role
     * Body: { processed_by: Snowflake }
     */
    app.post('/punishments/:id/expire', async (req, reply) => {
        const Params = z.object({ id: z.string().min(1).max(50) });
        const Body = z.object({
            processed_by: zSnowflake, // Bot user ID
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request');
        }

        const { id } = p.data;
        const { processed_by } = b.data;

        try {
            // Get the punishment first
            const checkResult = await query<{
                guild_id: string;
                user_id: string;
                type: string;
                active: boolean;
                expires_at: string | null;
            }>(
                `SELECT guild_id, user_id, type, active, expires_at FROM punishment WHERE id = $1`,
                [id]
            );

            if (checkResult.rows.length === 0) {
                return Errors.punishmentNotFound(reply);
            }

            const punishment = checkResult.rows[0];

            // Mark as processed (set removed_at and removed_by to indicate it was handled)
            // Use NULL for removed_by since this is a system action
            await query(
                `UPDATE punishment
                 SET removed_at = NOW(), removed_by = NULL, removal_reason = 'Suspension expired automatically'
                 WHERE id = $1`,
                [id]
            );

            // Log audit event for expiration with NULL actor (system action)
            await logAudit(punishment.guild_id, null, 'punishment.expired', punishment.user_id, {
                punishment_id: id,
                type: punishment.type,
                expires_at: punishment.expires_at,
            });

            console.log(`[Punishments] Marked suspension ${id} as expired for user ${punishment.user_id} in guild ${punishment.guild_id}`);

            return reply.send({ ok: true });
        } catch (err) {
            console.error('[Punishments] Failed to mark suspension as expired:', err);
            return Errors.internal(reply, 'Failed to mark suspension as expired');
        }
    });

    /**
     * DELETE /punishments/:id
     * Remove/deactivate a punishment
     * Body: { actor_user_id, removal_reason }
     */
    app.delete('/punishments/:id', async (req, reply) => {
        // Accept any string ID to support legacy numeric IDs during migration
        const Params = z.object({ id: z.string().min(1).max(50) });
        const p = Params.safeParse(req.params);
        const b = RemovePunishmentBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => `${i.path.join('.')}: ${i.message}`)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { id } = p.data;
        const { actor_user_id, removal_reason, actor_roles } = b.data;

        try {
            // Get the punishment first
            const checkResult = await query<{
                guild_id: string;
                user_id: string;
                type: string;
                active: boolean;
            }>(
                `SELECT guild_id, user_id, type, active FROM punishment WHERE id = $1`,
                [id]
            );

            if (checkResult.rows.length === 0) {
                return Errors.punishmentNotFound(reply);
            }

            const punishment = checkResult.rows[0];

            if (!punishment.active) {
                return Errors.validation(reply, 'Punishment is already inactive');
            }

            // Authorization check
            const authorized = await hasModerator(punishment.guild_id, actor_roles);
            if (!authorized) {
                console.log(`[Punishments] User ${actor_user_id} denied removal - not moderator`);
                return Errors.notAuthorized(reply);
            }

            // Deactivate the punishment
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                type: string;
                reason: string;
                expires_at: string | null;
                active: boolean;
                created_at: string;
                removed_at: string;
                removed_by: string;
                removal_reason: string;
            }>(
                `UPDATE punishment
                 SET active = FALSE, removed_at = NOW(), removed_by = $2::bigint, removal_reason = $3
                 WHERE id = $1
                 RETURNING id, guild_id, user_id, moderator_id, type, reason, expires_at, active, created_at,
                           removed_at, removed_by, removal_reason`,
                [id, actor_user_id, removal_reason]
            );

            const updated = result.rows[0];

            // Log audit event
            await logAudit(updated.guild_id, actor_user_id, 'punishment.removed', updated.user_id, {
                punishment_id: id,
                type: updated.type,
                removal_reason,
            });

            return reply.send(updated);
        } catch (err) {
            console.error('[Punishments] Failed to remove punishment:', err);
            return Errors.internal(reply, 'Failed to remove punishment');
        }
    });
}

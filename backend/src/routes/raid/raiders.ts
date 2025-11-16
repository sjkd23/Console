// backend/src/routes/raiders.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { hasInternalRole, hasRequiredRoleOrHigher, requireSecurity } from '../../lib/auth/authorization.js';
import { logAudit } from '../../lib/logging/audit.js';
import { ensureGuildExists, ensureMemberExists } from '../../lib/database/database-helpers.js';

/**
 * Body schema for verifying a raider.
 * IGN validation: 1-16 chars, letters, numbers, spaces, - or _
 */
const VerifyRaiderBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(), // Discord role IDs of the actor
    guild_id: zSnowflake,
    user_id: zSnowflake,
    ign: z
        .string()
        .trim()
        .min(1, 'IGN cannot be empty')
        .max(16, 'IGN must be 16 characters or less')
        .regex(/^[A-Za-z0-9 _-]+$/, 'IGN can only contain letters, numbers, spaces, - or _')
        .transform(s => s.replace(/\s+/g, ' ')), // Normalize consecutive spaces
});

/**
 * Body schema for updating a raider's IGN.
 * Same validation as verify.
 */
const UpdateIgnBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(),
    guild_id: zSnowflake,
    ign: z
        .string()
        .trim()
        .min(1, 'IGN cannot be empty')
        .max(16, 'IGN must be 16 characters or less')
        .regex(/^[A-Za-z0-9 _-]+$/, 'IGN can only contain letters, numbers, spaces, - or _')
        .transform(s => s.replace(/\s+/g, ' ')),
});

export default async function raidersRoutes(app: FastifyInstance) {
    /**
     * GET /raiders/:guild_id/:user_id
     * Get a raider's information.
     * Returns 404 if raider not found.
     */
    app.get('/raiders/:guild_id/:user_id', async (req, reply) => {
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

        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            alt_ign: string | null;
            status: string;
            verified_at: string | null;
        }>(
            `SELECT guild_id, user_id, ign, alt_ign, status, verified_at 
             FROM raider 
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'RAIDER_NOT_FOUND',
                    message: 'Raider not found',
                },
            });
        }

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            alt_ign: raider.alt_ign,
            status: raider.status,
            verified_at: raider.verified_at,
        });
    });

    /**
     * POST /raiders/verify
     * Manually verify a Discord guild member by associating their ROTMG IGN.
     * Sets status='approved', verified_at=NOW(), and stores the IGN.
     * Authorization: actor_user_id must have Security role (checked by bot).
     * Logs audit event: raider.verify
     */
    app.post('/raiders/verify', async (req, reply) => {
        const parsed = VerifyRaiderBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { actor_user_id, actor_roles, guild_id, user_id, ign } = parsed.data;

        console.log(`[Verify] Actor ${actor_user_id} in guild ${guild_id} attempting to verify ${user_id}`);
        console.log(`[Verify] Actor has ${actor_roles?.length || 0} roles: ${actor_roles?.join(', ') || 'none'}`);

        // Authorization: 
        // - Allow self-verification (actor_user_id === user_id)
        // - Otherwise, actor must have the 'security' role or higher
        const isSelfVerification = actor_user_id === user_id;
        
        if (!isSelfVerification) {
            try {
                await requireSecurity(guild_id, actor_user_id, actor_roles);
            } catch (err: any) {
                return reply.code(403).send({
                    error: {
                        code: 'NOT_SECURITY',
                        message: err.message || 'You need the Security role or higher to verify other members',
                    },
                });
            }
        }

        // Upsert guild
        await ensureGuildExists(guild_id);

        // Upsert member (target) and actor
        await ensureMemberExists(user_id);
        await ensureMemberExists(actor_user_id);

        // Check if this IGN is already in use by a different user in this guild
        const existingIgn = await query<{ user_id: string; ign: string }>(
            `SELECT user_id, ign FROM raider 
             WHERE guild_id = $1::bigint 
             AND LOWER(ign) = LOWER($2) 
             AND user_id != $3::bigint`,
            [guild_id, ign, user_id]
        );

        if (existingIgn.rowCount && existingIgn.rowCount > 0) {
            const conflictUserId = existingIgn.rows[0].user_id;
            console.log(`[Verify] IGN "${ign}" is already used by user ${conflictUserId} in guild ${guild_id}`);
            return reply.code(409).send({
                error: {
                    code: 'IGN_ALREADY_IN_USE',
                    message: `The IGN "${ign}" is already in use by another member in this server. Each IGN can only be linked to one Discord account.`,
                    conflictUserId,
                },
            });
        }

        // Upsert raider: set ign, status='approved', verified_at=NOW()
        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            status: string;
            verified_at: string;
        }>(
            `INSERT INTO raider (guild_id, user_id, ign, status, verified_at)
             VALUES ($1::bigint, $2::bigint, $3, 'approved', NOW())
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET
                ign = EXCLUDED.ign,
                status = 'approved',
                verified_at = NOW()
             RETURNING guild_id, user_id, ign, status, verified_at`,
            [guild_id, user_id, ign]
        );

        // Log audit event
        await logAudit(guild_id, actor_user_id, 'raider.verify', user_id, { ign });

        // Note: Quota points for verification are now handled by the bot calling
        // POST /quota/award-moderation-points after verification succeeds.
        // This allows for proper role-based moderation_points configuration.

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            status: raider.status,
            verified_at: raider.verified_at,
        });
    });

    /**
     * PATCH /raiders/:user_id/ign
     * Update a verified raider's IGN.
     * Authorization: actor_user_id must have Security role.
     * Returns updated raider info.
     * Logs audit event: raider.update_ign
     */
    app.patch('/raiders/:user_id/ign', async (req, reply) => {
        const Params = z.object({ user_id: zSnowflake });
        const p = Params.safeParse(req.params);
        const b = UpdateIgnBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { user_id } = p.data;
        const { actor_user_id, actor_roles, guild_id, ign } = b.data;

        console.log(`[Update IGN] Actor ${actor_user_id} in guild ${guild_id} updating ${user_id} to IGN "${ign}"`);

        // Authorization: actor must have the 'security' role or higher
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err: any) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: err.message || 'You need the Security role or higher to update raider IGNs',
                },
            });
        }

        // Ensure actor exists in member table before audit logging
        await ensureMemberExists(actor_user_id);

        // Check if raider exists and is verified
        const existingRaider = await query<{ ign: string; alt_ign: string | null; status: string }>(
            `SELECT ign, alt_ign, status FROM raider 
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!existingRaider.rowCount || existingRaider.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'RAIDER_NOT_FOUND',
                    message: 'This user is not verified in this server',
                },
            });
        }

        const oldIgn = existingRaider.rows[0].ign;

        // Check if new IGN is already in use by a different user
        const ignConflict = await query<{ user_id: string }>(
            `SELECT user_id FROM raider 
             WHERE guild_id = $1::bigint 
             AND LOWER(ign) = LOWER($2) 
             AND user_id != $3::bigint`,
            [guild_id, ign, user_id]
        );

        if (ignConflict.rowCount && ignConflict.rowCount > 0) {
            const conflictUserId = ignConflict.rows[0].user_id;
            return reply.code(409).send({
                error: {
                    code: 'IGN_ALREADY_IN_USE',
                    message: `The IGN "${ign}" is already in use by another member in this server`,
                    conflictUserId,
                },
            });
        }

        // Update the IGN
        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            alt_ign: string | null;
            status: string;
            verified_at: string;
        }>(
            `UPDATE raider 
             SET ign = $3
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
             RETURNING guild_id, user_id, ign, alt_ign, status, verified_at`,
            [guild_id, user_id, ign]
        );

        // Log audit event
        await logAudit(guild_id, actor_user_id, 'raider.update_ign', user_id, {
            old_ign: oldIgn,
            new_ign: ign,
        });

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            alt_ign: raider.alt_ign,
            status: raider.status,
            verified_at: raider.verified_at,
            old_ign: oldIgn,
        });
    });

    /**
     * PATCH /raiders/:user_id/status
     * Update a raider's status (e.g., unverify by setting to 'pending').
     * Authorization: actor_user_id must have Security role.
     * Returns updated raider info.
     * Logs audit event: raider.update_status
     */
    app.patch('/raiders/:user_id/status', async (req, reply) => {
        const Params = z.object({ user_id: zSnowflake });
        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            guild_id: zSnowflake,
            status: z.enum(['pending', 'approved', 'rejected', 'banned']),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { user_id } = p.data;
        const { actor_user_id, actor_roles, guild_id, status } = b.data;

        console.log(`[Update Status] Actor ${actor_user_id} in guild ${guild_id} updating ${user_id} to status "${status}"`);

        // Authorization: actor must have the 'security' role or higher
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err: any) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: err.message || 'You need the Security role or higher to update raider status',
                },
            });
        }

        // Ensure actor exists in member table before audit logging
        await ensureMemberExists(actor_user_id);

        // Check if raider exists
        const existingRaider = await query<{ ign: string; status: string }>(
            `SELECT ign, status FROM raider 
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!existingRaider.rowCount || existingRaider.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'RAIDER_NOT_FOUND',
                    message: 'This user is not in the raider system',
                },
            });
        }

        const oldStatus = existingRaider.rows[0].status;

        // Update the status (and clear verified_at if not approved)
        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            status: string;
            verified_at: string | null;
        }>(
            `UPDATE raider 
             SET status = $3, verified_at = CASE WHEN $3 = 'approved' THEN verified_at ELSE NULL END
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
             RETURNING guild_id, user_id, ign, status, verified_at`,
            [guild_id, user_id, status]
        );

        // Log audit event
        await logAudit(guild_id, actor_user_id, 'raider.update_status', user_id, {
            old_status: oldStatus,
            new_status: status,
        });

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            status: raider.status,
            verified_at: raider.verified_at,
            old_status: oldStatus,
        });
    });

    /**
     * PATCH /raiders/:user_id/alt
     * Add or update an alt IGN for a verified raider.
     * Authorization: actor_user_id must have Security role.
     * Returns updated raider info.
     * Logs audit event: raider.add_alt
     */
    app.patch('/raiders/:user_id/alt', async (req, reply) => {
        const Params = z.object({ user_id: zSnowflake });
        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            guild_id: zSnowflake,
            alt_ign: z
                .string()
                .trim()
                .min(1, 'Alt IGN cannot be empty')
                .max(16, 'Alt IGN must be 16 characters or less')
                .regex(/^[A-Za-z0-9 _-]+$/, 'Alt IGN can only contain letters, numbers, spaces, - or _')
                .transform(s => s.replace(/\s+/g, ' ')),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { user_id } = p.data;
        const { actor_user_id, actor_roles, guild_id, alt_ign } = b.data;

        console.log(`[Add Alt] Actor ${actor_user_id} in guild ${guild_id} adding alt "${alt_ign}" for ${user_id}`);

        // Authorization: actor must have the 'security' role or higher
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err: any) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: err.message || 'You need the Security role or higher to add alt IGNs',
                },
            });
        }

        // Ensure actor exists in member table before audit logging
        await ensureMemberExists(actor_user_id);

        // Check if raider exists and is verified
        const existingRaider = await query<{ ign: string; status: string; alt_ign: string | null }>(
            `SELECT ign, status, alt_ign FROM raider 
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!existingRaider.rowCount || existingRaider.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'RAIDER_NOT_FOUND',
                    message: 'This user is not verified in this server',
                },
            });
        }

        if (existingRaider.rows[0].status !== 'approved') {
            return reply.code(400).send({
                error: {
                    code: 'NOT_VERIFIED',
                    message: 'User must be verified before adding an alt IGN',
                },
            });
        }

        const oldAltIgn = existingRaider.rows[0].alt_ign;
        const mainIgn = existingRaider.rows[0].ign;

        // Check if alt IGN matches main IGN
        if (alt_ign.toLowerCase() === mainIgn.toLowerCase()) {
            return reply.code(400).send({
                error: {
                    code: 'DUPLICATE_IGN',
                    message: 'Alt IGN cannot be the same as the main IGN',
                },
            });
        }

        // Check if this alt IGN is already in use by another user (as main or alt)
        const ignConflict = await query<{ user_id: string; ign: string; alt_ign: string | null }>(
            `SELECT user_id, ign, alt_ign FROM raider 
             WHERE guild_id = $1::bigint 
             AND user_id != $2::bigint
             AND (LOWER(ign) = LOWER($3) OR LOWER(alt_ign) = LOWER($3))`,
            [guild_id, user_id, alt_ign]
        );

        if (ignConflict.rowCount && ignConflict.rowCount > 0) {
            const conflictUserId = ignConflict.rows[0].user_id;
            const isMainIgn = ignConflict.rows[0].ign.toLowerCase() === alt_ign.toLowerCase();
            return reply.code(409).send({
                error: {
                    code: 'IGN_ALREADY_IN_USE',
                    message: `The IGN "${alt_ign}" is already in use by another member in this server ${isMainIgn ? 'as their main IGN' : 'as their alt IGN'}`,
                    conflictUserId,
                },
            });
        }

        // Update the alt IGN
        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            alt_ign: string | null;
            status: string;
            verified_at: string;
        }>(
            `UPDATE raider 
             SET alt_ign = $3
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
             RETURNING guild_id, user_id, ign, alt_ign, status, verified_at`,
            [guild_id, user_id, alt_ign]
        );

        // Log audit event
        await logAudit(guild_id, actor_user_id, 'raider.add_alt', user_id, {
            old_alt_ign: oldAltIgn,
            new_alt_ign: alt_ign,
        });

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            alt_ign: raider.alt_ign,
            status: raider.status,
            verified_at: raider.verified_at,
            old_alt_ign: oldAltIgn,
        });
    });

    /**
     * DELETE /raiders/:user_id/alt
     * Remove an alt IGN from a verified raider.
     * Authorization: actor_user_id must have Security role.
     * Returns updated raider info.
     * Logs audit event: raider.remove_alt
     */
    app.delete('/raiders/:user_id/alt', async (req, reply) => {
        const Params = z.object({ user_id: zSnowflake });
        const Body = z.object({
            actor_user_id: zSnowflake,
            actor_roles: z.array(zSnowflake).optional(),
            guild_id: zSnowflake,
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { user_id } = p.data;
        const { actor_user_id, actor_roles, guild_id } = b.data;

        console.log(`[Remove Alt] Actor ${actor_user_id} in guild ${guild_id} removing alt for ${user_id}`);

        // Authorization: actor must have the 'security' role or higher
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err: any) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: err.message || 'You need the Security role or higher to remove alt IGNs',
                },
            });
        }

        // Ensure actor exists in member table before audit logging
        await ensureMemberExists(actor_user_id);

        // Check if raider exists
        const existingRaider = await query<{ ign: string; alt_ign: string | null; status: string }>(
            `SELECT ign, alt_ign, status FROM raider 
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!existingRaider.rowCount || existingRaider.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'RAIDER_NOT_FOUND',
                    message: 'This user is not in the raider system',
                },
            });
        }

        const oldAltIgn = existingRaider.rows[0].alt_ign;

        if (!oldAltIgn) {
            return reply.code(400).send({
                error: {
                    code: 'NO_ALT_IGN',
                    message: 'This user does not have an alt IGN to remove',
                },
            });
        }

        // Remove the alt IGN
        const res = await query<{
            guild_id: string;
            user_id: string;
            ign: string;
            alt_ign: string | null;
            status: string;
            verified_at: string | null;
        }>(
            `UPDATE raider 
             SET alt_ign = NULL
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
             RETURNING guild_id, user_id, ign, alt_ign, status, verified_at`,
            [guild_id, user_id]
        );

        // Log audit event
        await logAudit(guild_id, actor_user_id, 'raider.remove_alt', user_id, {
            old_alt_ign: oldAltIgn,
        });

        const raider = res.rows[0];
        return reply.code(200).send({
            guild_id: raider.guild_id,
            user_id: raider.user_id,
            ign: raider.ign,
            alt_ign: raider.alt_ign,
            status: raider.status,
            verified_at: raider.verified_at,
            old_alt_ign: oldAltIgn,
        });
    });
}

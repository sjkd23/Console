// backend/src/routes/raiders.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';
import { hasInternalRole } from '../lib/authorization.js';
import { logQuotaEvent } from '../lib/quota.js';
import { logAudit } from '../lib/audit.js';
import { ensureGuildExists, ensureMemberExists } from '../lib/database-helpers.js';

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
            status: string;
            verified_at: string | null;
        }>(
            `SELECT guild_id, user_id, ign, status, verified_at 
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

        // Authorization: actor must have the 'security' role
        const hasSecurity = await hasInternalRole(guild_id, actor_user_id, 'security', actor_roles);
        if (!hasSecurity) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: 'You must have the Security role to verify raiders',
                },
            });
        }

        // Upsert guild
        await ensureGuildExists(guild_id);

        // Upsert member
        await ensureMemberExists(user_id);

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

        // Log quota event for security member
        try {
            await logQuotaEvent(
                guild_id,
                actor_user_id,
                'verify_member',
                `verify:${user_id}`,
                undefined, // No dungeon for verifications
                1 // Default: 1 point per verification
            );
        } catch (err) {
            // Log error but don't fail the request
            console.error(`[Raiders] Failed to log quota event for verification of user ${user_id}:`, err);
        }

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

        // Authorization: actor must have the 'security' role
        const hasSecurity = await hasInternalRole(guild_id, actor_user_id, 'security', actor_roles);
        if (!hasSecurity) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: 'You must have the Security role to update raider IGNs',
                },
            });
        }

        // Check if raider exists and is verified
        const existingRaider = await query<{ ign: string; status: string }>(
            `SELECT ign, status FROM raider 
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
            status: string;
            verified_at: string;
        }>(
            `UPDATE raider 
             SET ign = $3
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
             RETURNING guild_id, user_id, ign, status, verified_at`,
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

        // Authorization: actor must have the 'security' role
        const hasSecurity = await hasInternalRole(guild_id, actor_user_id, 'security', actor_roles);
        if (!hasSecurity) {
            return reply.code(403).send({
                error: {
                    code: 'NOT_SECURITY',
                    message: 'You must have the Security role to update raider status',
                },
            });
        }

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
}

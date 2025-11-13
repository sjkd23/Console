// backend/src/routes/verification.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';

const SessionStatus = z.enum(['pending_ign', 'pending_realmeye', 'verified', 'cancelled', 'expired']);

const CreateSessionBody = z.object({
    guild_id: zSnowflake,
    user_id: zSnowflake,
});

const UpdateSessionBody = z.object({
    rotmg_ign: z.string().optional(),
    verification_code: z.string().optional(),
    status: SessionStatus.optional(),
});

export default async function verificationRoutes(app: FastifyInstance) {
    /**
     * GET /verification/session/user/:user_id
     * Get the most recent active verification session for a user (across all guilds)
     * Used for DM-based interactions where guildId is not available
     */
    app.get('/verification/session/user/:user_id', async (req, reply) => {
        const Params = z.object({
            user_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { user_id } = parsed.data;

        // Get most recent active session (not expired/cancelled/verified)
        const res = await query(
            `SELECT guild_id, user_id, rotmg_ign, verification_code, status, 
                    created_at, updated_at, expires_at
             FROM verification_session
             WHERE user_id = $1::bigint 
               AND status IN ('pending_ign', 'pending_realmeye')
               AND expires_at > NOW()
             ORDER BY created_at DESC
             LIMIT 1`,
            [user_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'No active verification session found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * GET /verification/session/:guild_id/:user_id
     * Get verification session for a user in a guild
     */
    app.get('/verification/session/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, user_id } = parsed.data;

        const res = await query(
            `SELECT guild_id, user_id, rotmg_ign, verification_code, status, 
                    created_at, updated_at, expires_at
             FROM verification_session
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'Verification session not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * POST /verification/session
     * Create a new verification session
     */
    app.post('/verification/session', async (req, reply) => {
        const parsed = CreateSessionBody.safeParse(req.body);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, user_id } = parsed.data;

        // Upsert: if session exists, reset it
        const res = await query(
            `INSERT INTO verification_session (guild_id, user_id, status, created_at, updated_at, expires_at)
             VALUES ($1::bigint, $2::bigint, 'pending_ign', NOW(), NOW(), NOW() + INTERVAL '1 hour')
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET
                rotmg_ign = NULL,
                verification_code = NULL,
                status = 'pending_ign',
                created_at = NOW(),
                updated_at = NOW(),
                expires_at = NOW() + INTERVAL '1 hour'
             RETURNING guild_id, user_id, rotmg_ign, verification_code, status, 
                       created_at, updated_at, expires_at`,
            [guild_id, user_id]
        );

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * PATCH /verification/session/:guild_id/:user_id
     * Update a verification session
     */
    app.patch('/verification/session/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });
        const p = Params.safeParse(req.params);
        const b = UpdateSessionBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { guild_id, user_id } = p.data;
        const updates = b.data;

        // Build dynamic update query
        const setClauses: string[] = ['updated_at = NOW()'];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.rotmg_ign !== undefined) {
            setClauses.push(`rotmg_ign = $${paramIndex++}`);
            values.push(updates.rotmg_ign);
        }

        if (updates.verification_code !== undefined) {
            setClauses.push(`verification_code = $${paramIndex++}`);
            values.push(updates.verification_code);
        }

        if (updates.status !== undefined) {
            setClauses.push(`status = $${paramIndex++}`);
            values.push(updates.status);
        }

        values.push(guild_id, user_id);

        const res = await query(
            `UPDATE verification_session
             SET ${setClauses.join(', ')}
             WHERE guild_id = $${paramIndex++}::bigint AND user_id = $${paramIndex++}::bigint
             RETURNING guild_id, user_id, rotmg_ign, verification_code, status,
                       created_at, updated_at, expires_at`,
            values
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'Verification session not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * DELETE /verification/session/:guild_id/:user_id
     * Delete a verification session
     */
    app.delete('/verification/session/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, user_id } = parsed.data;

        await query(
            `DELETE FROM verification_session
             WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
            [guild_id, user_id]
        );

        return reply.code(204).send();
    });

    /**
     * POST /verification/cleanup-expired
     * Cleanup expired verification sessions (called periodically by bot or cron)
     */
    app.post('/verification/cleanup-expired', async (req, reply) => {
        const res = await query(
            `UPDATE verification_session
             SET status = 'expired'
             WHERE expires_at < NOW() AND status NOT IN ('verified', 'cancelled', 'expired')
             RETURNING guild_id, user_id`
        );

        return reply.code(200).send({
            cleaned: res.rowCount || 0,
            sessions: res.rows,
        });
    });
}

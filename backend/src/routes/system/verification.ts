// backend/src/routes/verification.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';

const SessionStatus = z.enum(['pending_ign', 'pending_realmeye', 'pending_screenshot', 'pending_review', 'verified', 'cancelled', 'denied', 'expired']);

const CreateSessionBody = z.object({
    guild_id: zSnowflake,
    user_id: zSnowflake,
});

const UpdateSessionBody = z.object({
    rotmg_ign: z.string().optional(),
    verification_code: z.string().optional(),
    status: SessionStatus.optional(),
    verification_method: z.enum(['realmeye', 'manual']).optional(),
    screenshot_url: z.string().optional(),
    ticket_message_id: zSnowflake.optional(),
    reviewed_by_user_id: zSnowflake.optional(),
    denial_reason: z.string().optional(),
});

const GuildVerificationConfigBody = z.object({
    manual_verify_instructions: z.string().optional(),
    panel_custom_message: z.string().optional(),
    manual_verify_instructions_image: z.string().optional(),
    panel_custom_message_image: z.string().optional(),
    realmeye_instructions_image: z.string().optional(),
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

        // Get most recent active session (not expired/cancelled/verified/denied)
        // Note: pending_review sessions are exempt from expiration check as they wait for staff
        const res = await query(
            `SELECT guild_id, user_id, rotmg_ign, verification_code, status, 
                    verification_method, screenshot_url, ticket_message_id, 
                    reviewed_by_user_id, denial_reason,
                    created_at, updated_at, expires_at
             FROM verification_session
             WHERE user_id = $1::bigint 
               AND status IN ('pending_ign', 'pending_realmeye', 'pending_screenshot', 'pending_review')
               AND (status = 'pending_review' OR expires_at > NOW())
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
                    verification_method, screenshot_url, ticket_message_id, 
                    reviewed_by_user_id, denial_reason,
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
            
            // Extend expiration for pending_review to 7 days since it needs to wait for staff
            if (updates.status === 'pending_review') {
                setClauses.push(`expires_at = NOW() + INTERVAL '7 days'`);
            }
        }

        if (updates.verification_method !== undefined) {
            setClauses.push(`verification_method = $${paramIndex++}`);
            values.push(updates.verification_method);
        }

        if (updates.screenshot_url !== undefined) {
            setClauses.push(`screenshot_url = $${paramIndex++}`);
            values.push(updates.screenshot_url);
        }

        if (updates.ticket_message_id !== undefined) {
            setClauses.push(`ticket_message_id = $${paramIndex++}::bigint`);
            values.push(updates.ticket_message_id);
        }

        if (updates.reviewed_by_user_id !== undefined) {
            setClauses.push(`reviewed_by_user_id = $${paramIndex++}::bigint`);
            values.push(updates.reviewed_by_user_id);
            // Auto-set reviewed_at when reviewer is set
            setClauses.push(`reviewed_at = NOW()`);
        }

        if (updates.denial_reason !== undefined) {
            setClauses.push(`denial_reason = $${paramIndex++}`);
            values.push(updates.denial_reason);
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
     * Note: pending_review sessions are not expired as they wait for staff action
     */
    app.post('/verification/cleanup-expired', async (req, reply) => {
        const res = await query(
            `UPDATE verification_session
             SET status = 'expired'
             WHERE expires_at < NOW() 
               AND status NOT IN ('verified', 'cancelled', 'expired', 'denied', 'pending_review')
             RETURNING guild_id, user_id`
        );

        return reply.code(200).send({
            cleaned: res.rowCount || 0,
            sessions: res.rows,
        });
    });

    /**
     * GET /verification/config/:guild_id
     * Get guild verification configuration
     */
    app.get('/verification/config/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id } = parsed.data;

        const res = await query(
            `SELECT guild_id, manual_verify_instructions, panel_custom_message, 
                    manual_verify_instructions_image, panel_custom_message_image, 
                    realmeye_instructions_image, updated_at
             FROM guild_verification_config
             WHERE guild_id = $1::bigint`,
            [guild_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            // Return default config if none exists
            return reply.code(200).send({
                guild_id,
                manual_verify_instructions: null,
                panel_custom_message: null,
                manual_verify_instructions_image: null,
                panel_custom_message_image: null,
                realmeye_instructions_image: null,
                updated_at: null,
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * PUT /verification/config/:guild_id
     * Update guild verification configuration
     */
    app.put('/verification/config/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });
        const p = Params.safeParse(req.params);
        const b = GuildVerificationConfigBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { guild_id } = p.data;
        const updates = b.data;

        // Build upsert query
        const res = await query(
            `INSERT INTO guild_verification_config (
                guild_id, 
                manual_verify_instructions, 
                panel_custom_message,
                manual_verify_instructions_image,
                panel_custom_message_image,
                realmeye_instructions_image,
                updated_at
             )
             VALUES (
                $1::bigint, 
                $2, 
                $3,
                $4,
                $5,
                $6,
                NOW()
             )
             ON CONFLICT (guild_id)
             DO UPDATE SET
                manual_verify_instructions = COALESCE($2, guild_verification_config.manual_verify_instructions),
                panel_custom_message = COALESCE($3, guild_verification_config.panel_custom_message),
                manual_verify_instructions_image = COALESCE($4, guild_verification_config.manual_verify_instructions_image),
                panel_custom_message_image = COALESCE($5, guild_verification_config.panel_custom_message_image),
                realmeye_instructions_image = COALESCE($6, guild_verification_config.realmeye_instructions_image),
                updated_at = NOW()
             RETURNING guild_id, manual_verify_instructions, panel_custom_message, 
                       manual_verify_instructions_image, panel_custom_message_image, 
                       realmeye_instructions_image, updated_at`,
            [
                guild_id,
                updates.manual_verify_instructions ?? null,
                updates.panel_custom_message ?? null,
                updates.manual_verify_instructions_image ?? null,
                updates.panel_custom_message_image ?? null,
                updates.realmeye_instructions_image ?? null,
            ]
        );

        return reply.code(200).send(res.rows[0]);
    });
}

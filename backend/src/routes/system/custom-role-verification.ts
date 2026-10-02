// backend/src/routes/system/custom-role-verification.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';

const SessionStatus = z.enum(['pending_screenshot', 'pending_review', 'approved', 'denied', 'cancelled', 'expired']);

const CreateRoleVerificationBody = z.object({
    guild_id: zSnowflake,
    role_id: zSnowflake,
    role_channel_id: zSnowflake,
    verification_channel_id: zSnowflake,
    instructions: z.string().min(1).max(2000),
    role_description: z.string().max(500).optional(),
    example_image_url: z.string().optional(),
    created_by_user_id: zSnowflake,
});

const UpdateRoleVerificationBody = z.object({
    role_channel_id: zSnowflake.optional(),
    verification_channel_id: zSnowflake.optional(),
    instructions: z.string().min(1).max(2000).optional(),
    role_description: z.string().max(500).optional(),
    example_image_url: z.string().optional(),
    panel_message_id: zSnowflake.optional(),
});

const CreateSessionBody = z.object({
    guild_id: zSnowflake,
    user_id: zSnowflake,
    role_verification_id: z.number().int().positive(),
});

const UpdateSessionBody = z.object({
    screenshot_url: z.string().optional(),
    ticket_message_id: zSnowflake.optional(),
    status: SessionStatus.optional(),
    reviewed_by_user_id: zSnowflake.optional(),
    denial_reason: z.string().optional(),
});

export default async function customRoleVerificationRoutes(app: FastifyInstance) {
    /**
     * POST /custom-role-verification
     * Create a new custom role verification configuration
     */
    app.post('/custom-role-verification', async (req, reply) => {
        const parsed = CreateRoleVerificationBody.safeParse(req.body);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, created_by_user_id } = parsed.data;

        try {
            const res = await query(
                `INSERT INTO custom_role_verification 
                    (guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, created_by_user_id, created_at)
                 VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5, $6, $7, $8::bigint, NOW())
                 ON CONFLICT (guild_id, role_id) 
                 DO UPDATE SET
                    role_channel_id = $3::bigint,
                    verification_channel_id = $4::bigint,
                    instructions = $5,
                    role_description = $6,
                    example_image_url = $7,
                    panel_message_id = NULL
                 RETURNING id, guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, panel_message_id, created_at, created_by_user_id`,
                [guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description || null, example_image_url || null, created_by_user_id],
                { redactParams: true }
            );

            return reply.code(200).send(res.rows[0]);
        } catch (err) {
            console.error('[CustomRoleVerification] Error creating config:', err);
            return Errors.internal(reply, 'Failed to create role verification configuration');
        }
    });

    /**
     * GET /custom-role-verification/:guild_id/:role_id
     * Get a specific role verification config by guild and role
     */
    app.get('/custom-role-verification/:guild_id/:role_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            role_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, role_id } = parsed.data;

        const res = await query(
            `SELECT id, guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, panel_message_id, created_at, created_by_user_id
             FROM custom_role_verification
             WHERE guild_id = $1::bigint AND role_id = $2::bigint`,
            [guild_id, role_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'CONFIG_NOT_FOUND',
                    message: 'Role verification configuration not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * GET /custom-role-verification/:guild_id
     * Get all role verification configs for a guild
     */
    app.get('/custom-role-verification/:guild_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id } = parsed.data;

        const res = await query(
            `SELECT id, guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, panel_message_id, created_at, created_by_user_id
             FROM custom_role_verification
             WHERE guild_id = $1::bigint
             ORDER BY created_at DESC`,
            [guild_id]
        );

        return reply.code(200).send(res.rows);
    });

    /**
     * PATCH /custom-role-verification/:id
     * Update a role verification config
     */
    app.patch('/custom-role-verification/:id', async (req, reply) => {
        const Params = z.object({
            id: z.coerce.number().int().positive(),
        });
        const p = Params.safeParse(req.params);
        const b = UpdateRoleVerificationBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { id } = p.data;
        const updates = b.data;

        // Build dynamic update query
        const setClauses: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.role_channel_id !== undefined) {
            setClauses.push(`role_channel_id = $${paramIndex++}::bigint`);
            values.push(updates.role_channel_id);
        }

        if (updates.verification_channel_id !== undefined) {
            setClauses.push(`verification_channel_id = $${paramIndex++}::bigint`);
            values.push(updates.verification_channel_id);
        }

        if (updates.instructions !== undefined) {
            setClauses.push(`instructions = $${paramIndex++}`);
            values.push(updates.instructions);
        }

        if (updates.role_description !== undefined) {
            setClauses.push(`role_description = $${paramIndex++}`);
            values.push(updates.role_description);
        }

        if (updates.example_image_url !== undefined) {
            setClauses.push(`example_image_url = $${paramIndex++}`);
            values.push(updates.example_image_url);
        }

        if (updates.panel_message_id !== undefined) {
            setClauses.push(`panel_message_id = $${paramIndex++}::bigint`);
            values.push(updates.panel_message_id);
        }

        if (setClauses.length === 0) {
            return Errors.validation(reply, 'No updates provided');
        }

        values.push(id);

        const res = await query(
            `UPDATE custom_role_verification
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex++}
             RETURNING id, guild_id, role_id, role_channel_id, verification_channel_id, instructions, role_description, example_image_url, panel_message_id, created_at, created_by_user_id`,
            values,
            { redactParams: true }
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'CONFIG_NOT_FOUND',
                    message: 'Role verification configuration not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * DELETE /custom-role-verification/:id
     * Delete a role verification config (cascades to sessions)
     */
    app.delete('/custom-role-verification/:id', async (req, reply) => {
        const Params = z.object({
            id: z.coerce.number().int().positive(),
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { id } = parsed.data;

        await query(
            `DELETE FROM custom_role_verification WHERE id = $1`,
            [id]
        );

        return reply.code(204).send();
    });

    // ===== SESSION ROUTES =====

    /**
     * GET /custom-role-verification/session/user/:user_id
     * Get the most recent active session for a user (across all guilds)
     * Used for DM-based interactions
     */
    app.get('/custom-role-verification/session/user/:user_id', async (req, reply) => {
        const Params = z.object({
            user_id: zSnowflake,
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { user_id } = parsed.data;

        // Get most recent active session (not expired/cancelled/approved/denied)
        // pending_review sessions are exempt from expiration as they wait for staff
        const res = await query(
            `SELECT s.id, s.guild_id, s.user_id, s.role_verification_id, s.screenshot_url, 
                    s.ticket_message_id, s.status, s.reviewed_by_user_id, s.reviewed_at, 
                    s.denial_reason, s.created_at, s.updated_at, s.expires_at,
                    c.role_id, c.role_channel_id, c.verification_channel_id, c.instructions, c.role_description, c.example_image_url
             FROM custom_role_verification_session s
             JOIN custom_role_verification c ON s.role_verification_id = c.id
             WHERE s.user_id = $1::bigint 
               AND s.status IN ('pending_screenshot', 'pending_review')
               AND (s.status = 'pending_review' OR s.expires_at > NOW())
             ORDER BY s.created_at DESC
             LIMIT 1`,
            [user_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'No active role verification session found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * GET /custom-role-verification/session/:session_id
     * Get a session by ID
     */
    app.get('/custom-role-verification/session/:session_id', async (req, reply) => {
        const Params = z.object({
            session_id: z.coerce.number().int().positive(),
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { session_id } = parsed.data;

        const res = await query(
            `SELECT s.id, s.guild_id, s.user_id, s.role_verification_id, s.screenshot_url, 
                    s.ticket_message_id, s.status, s.reviewed_by_user_id, s.reviewed_at, 
                    s.denial_reason, s.created_at, s.updated_at, s.expires_at,
                    c.role_id, c.role_channel_id, c.verification_channel_id, c.instructions, c.role_description, c.example_image_url
             FROM custom_role_verification_session s
             JOIN custom_role_verification c ON s.role_verification_id = c.id
             WHERE s.id = $1`,
            [session_id]
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'Role verification session not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * POST /custom-role-verification/session
     * Create a new role verification session
     */
    app.post('/custom-role-verification/session', async (req, reply) => {
        const parsed = CreateSessionBody.safeParse(req.body);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { guild_id, user_id, role_verification_id } = parsed.data;

        try {
            // Upsert: if session exists, reset it
            const res = await query(
                `INSERT INTO custom_role_verification_session 
                    (guild_id, user_id, role_verification_id, status, created_at, updated_at, expires_at)
                 VALUES ($1::bigint, $2::bigint, $3, 'pending_screenshot', NOW(), NOW(), NOW() + INTERVAL '1 hour')
                 ON CONFLICT (guild_id, user_id, role_verification_id)
                 DO UPDATE SET
                    screenshot_url = NULL,
                    ticket_message_id = NULL,
                    status = 'pending_screenshot',
                    reviewed_by_user_id = NULL,
                    reviewed_at = NULL,
                    denial_reason = NULL,
                    created_at = NOW(),
                    updated_at = NOW(),
                    expires_at = NOW() + INTERVAL '1 hour'
                 RETURNING id, guild_id, user_id, role_verification_id, status, created_at, updated_at, expires_at`,
                [guild_id, user_id, role_verification_id]
            );

            return reply.code(200).send(res.rows[0]);
        } catch (err) {
            console.error('[CustomRoleVerificationSession] Error creating session:', err);
            return Errors.internal(reply, 'Failed to create role verification session');
        }
    });

    /**
     * PATCH /custom-role-verification/session/:session_id
     * Update a role verification session
     */
    app.patch('/custom-role-verification/session/:session_id', async (req, reply) => {
        const Params = z.object({
            session_id: z.coerce.number().int().positive(),
        });
        const p = Params.safeParse(req.params);
        const b = UpdateSessionBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { session_id } = p.data;
        const updates = b.data;

        // Build dynamic update query
        const setClauses: string[] = ['updated_at = NOW()'];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.screenshot_url !== undefined) {
            setClauses.push(`screenshot_url = $${paramIndex++}`);
            values.push(updates.screenshot_url);
        }

        if (updates.ticket_message_id !== undefined) {
            setClauses.push(`ticket_message_id = $${paramIndex++}::bigint`);
            values.push(updates.ticket_message_id);
        }

        if (updates.status !== undefined) {
            setClauses.push(`status = $${paramIndex++}`);
            values.push(updates.status);
            
            // Extend expiration for pending_review to 7 days
            if (updates.status === 'pending_review') {
                setClauses.push(`expires_at = NOW() + INTERVAL '7 days'`);
            }
        }

        if (updates.reviewed_by_user_id !== undefined) {
            setClauses.push(`reviewed_by_user_id = $${paramIndex++}::bigint`);
            values.push(updates.reviewed_by_user_id);
            setClauses.push(`reviewed_at = NOW()`);
        }

        if (updates.denial_reason !== undefined) {
            setClauses.push(`denial_reason = $${paramIndex++}`);
            values.push(updates.denial_reason);
        }

        values.push(session_id);

        const res = await query(
            `UPDATE custom_role_verification_session
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex++}
             RETURNING id, guild_id, user_id, role_verification_id, screenshot_url, ticket_message_id, 
                       status, reviewed_by_user_id, reviewed_at, denial_reason, created_at, updated_at, expires_at`,
            values,
            { redactParams: true }
        );

        if (!res.rowCount || res.rowCount === 0) {
            return reply.code(404).send({
                error: {
                    code: 'SESSION_NOT_FOUND',
                    message: 'Role verification session not found',
                },
            });
        }

        return reply.code(200).send(res.rows[0]);
    });

    /**
     * DELETE /custom-role-verification/session/:session_id
     * Delete a role verification session
     */
    app.delete('/custom-role-verification/session/:session_id', async (req, reply) => {
        const Params = z.object({
            session_id: z.coerce.number().int().positive(),
        });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, parsed.error.issues.map(i => i.message).join('; '));
        }

        const { session_id } = parsed.data;

        await query(
            `DELETE FROM custom_role_verification_session WHERE id = $1`,
            [session_id]
        );

        return reply.code(204).send();
    });

    /**
     * POST /custom-role-verification/cleanup-expired
     * Cleanup expired sessions (called periodically by bot or cron)
     */
    app.post('/custom-role-verification/cleanup-expired', async (req, reply) => {
        const res = await query(
            `UPDATE custom_role_verification_session
             SET status = 'expired'
             WHERE expires_at < NOW() 
               AND status NOT IN ('approved', 'denied', 'cancelled', 'expired', 'pending_review')
             RETURNING id, guild_id, user_id`
        );

        return reply.code(200).send({
            cleaned: res.rowCount || 0,
            sessions: res.rows,
        });
    });
}

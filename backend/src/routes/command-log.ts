// backend/src/routes/command-log.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { Errors } from '../lib/errors.js';

/**
 * Body schema for logging a command execution.
 */
const LogCommandBody = z.object({
    guild_id: z.string().nullable().optional(),
    channel_id: z.string().nullable().optional(),
    user_id: z.string(),
    command_name: z.string(),
    subcommand: z.string().nullable().optional(),
    options: z.record(z.any()).nullable().optional(), // JSONB-compatible object
    success: z.boolean().default(true),
    error_code: z.string().nullable().optional(),
    latency_ms: z.number().int().positive().nullable().optional(),
});

export default async function commandLogRoutes(app: FastifyInstance) {
    /**
     * POST /command-log
     * Log a slash command execution.
     * Internal endpoint for bot use only (requires API key).
     * 
     * Body: { guild_id?, channel_id?, user_id, command_name, subcommand?, options?, success?, error_code?, latency_ms? }
     * Returns: { ok: true, id: string }
     */
    app.post('/command-log', async (req, reply) => {
        const parsed = LogCommandBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const {
            guild_id,
            channel_id,
            user_id,
            command_name,
            subcommand,
            options,
            success,
            error_code,
            latency_ms,
        } = parsed.data;

        try {
            const result = await query<{ id: string }>(
                `INSERT INTO command_log (
                    guild_id,
                    channel_id,
                    user_id,
                    command_name,
                    subcommand,
                    options,
                    success,
                    error_code,
                    latency_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id`,
                [
                    guild_id ?? null,
                    channel_id ?? null,
                    user_id,
                    command_name,
                    subcommand ?? null,
                    options ? JSON.stringify(options) : null,
                    success,
                    error_code ?? null,
                    latency_ms ?? null,
                ]
            );

            const logId = result.rows[0]?.id;

            if (!logId) {
                console.error('[CommandLog] Failed to insert command log');
                return Errors.internal(reply, 'Failed to log command');
            }

            // Log for debugging
            const errorInfo = error_code ? ` (error: ${error_code})` : '';
            console.log(
                `[CommandLog] Logged command: ${command_name}${subcommand ? `/${subcommand}` : ''} ` +
                `by user ${user_id} in ${guild_id ? `guild ${guild_id}` : 'DM'}${errorInfo}`
            );

            return reply.code(200).send({ ok: true, id: logId });
        } catch (err) {
            console.error('[CommandLog] Failed to log command:', err);
            return Errors.internal(reply, 'Failed to log command');
        }
    });
}

// backend/src/routes/notes.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { logAudit } from '../../lib/logging/audit.js';
import { requireSecurity } from '../../lib/auth/authorization.js';
import { ensureMemberExists } from '../../lib/database/database-helpers.js';
import { createLogger } from '../../lib/logging/logger.js';

const logger = createLogger('Notes');

/**
 * Schema for creating a note
 */
const CreateNoteBody = z.object({
    actor_user_id: zSnowflake,
    guild_id: zSnowflake,
    user_id: zSnowflake,
    note_text: z.string().min(1).max(1000),
    actor_roles: z.array(zSnowflake).optional(),
});

export default async function notesRoutes(app: FastifyInstance) {
    /**
     * POST /notes
     * Create a new note for a user
     * Returns the created note record
     */
    app.post('/notes', async (req, reply) => {
        const parsed = CreateNoteBody.safeParse(req.body);

        if (!parsed.success) {
            logger.error({ issues: parsed.error.issues, body: req.body }, 'Validation failed for POST /notes');
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { actor_user_id, guild_id, user_id, note_text, actor_roles } = parsed.data;

        // Authorization check
        try {
            await requireSecurity(guild_id, actor_user_id, actor_roles);
        } catch (err) {
            logger.warn({ actorUserId: actor_user_id, guildId: guild_id }, 'User denied - not security');
            throw err;
        }

        try {
            // Ensure actor and target exist in member table before creating note
            // This prevents foreign key constraint violations in audit logging
            await ensureMemberExists(actor_user_id);
            await ensureMemberExists(user_id);

            // Generate a cryptographically secure random 24-character hex ID
            const noteId = randomBytes(12).toString('hex'); // 12 bytes = 24 hex characters

            // Create note
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                note_text: string;
                created_at: string;
            }>(
                `INSERT INTO note (id, guild_id, user_id, moderator_id, note_text, created_at)
                 VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, NOW())
                 RETURNING id, guild_id, user_id, moderator_id, note_text, created_at`,
                [noteId, guild_id, user_id, actor_user_id, note_text]
            );

            const note = result.rows[0];

            // Log audit event
            await logAudit(guild_id, actor_user_id, 'note.created', user_id, {
                note_id: note.id,
                note_text,
            });

            return reply.status(201).send({
                id: note.id,
                guild_id: note.guild_id,
                user_id: note.user_id,
                moderator_id: note.moderator_id,
                note_text: note.note_text,
                created_at: note.created_at,
            });
        } catch (err) {
            logger.error({ err, guildId: guild_id, userId: user_id }, 'Failed to create note');
            return Errors.internal(reply, 'Failed to create note');
        }
    });

    /**
     * GET /notes/:id
     * Get a specific note by ID
     */
    app.get('/notes/:id', async (req, reply) => {
        const Params = z.object({ id: z.string().min(1).max(50) });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid note ID');
        }

        const { id } = parsed.data;

        try {
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                note_text: string;
                created_at: string;
            }>(
                `SELECT id, guild_id, user_id, moderator_id, note_text, created_at
                 FROM note
                 WHERE id = $1`,
                [id]
            );

            if (result.rows.length === 0) {
                return reply.status(404).send({
                    error: {
                        code: 'NOTE_NOT_FOUND',
                        message: 'Note not found',
                    },
                });
            }

            return reply.send(result.rows[0]);
        } catch (err) {
            logger.error({ err, noteId: id }, 'Failed to get note');
            return Errors.internal(reply, 'Failed to retrieve note');
        }
    });

    /**
     * GET /notes/user/:guild_id/:user_id
     * Get all notes for a user in a guild
     */
    app.get('/notes/user/:guild_id/:user_id', async (req, reply) => {
        const Params = z.object({
            guild_id: zSnowflake,
            user_id: zSnowflake,
        });

        const p = Params.safeParse(req.params);

        if (!p.success) {
            return Errors.validation(reply, 'Invalid parameters');
        }

        const { guild_id, user_id } = p.data;

        try {
            const result = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                note_text: string;
                created_at: string;
            }>(
                `SELECT id, guild_id, user_id, moderator_id, note_text, created_at
                 FROM note
                 WHERE guild_id = $1::bigint AND user_id = $2::bigint
                 ORDER BY created_at DESC`,
                [guild_id, user_id]
            );

            return reply.send({
                notes: result.rows,
            });
        } catch (err) {
            logger.error({ err, guildId: guild_id, userId: user_id }, 'Failed to get user notes');
            return Errors.internal(reply, 'Failed to retrieve user notes');
        }
    });

    /**
     * DELETE /notes/:id
     * Remove a note
     * Body: { actor_user_id, removal_reason, actor_roles, actor_has_admin }
     */
    app.delete('/notes/:id', async (req, reply) => {
        const Params = z.object({ id: z.string().min(1).max(50) });
        const Body = z.object({
            actor_user_id: zSnowflake,
            removal_reason: z.string().min(1).max(500),
            actor_roles: z.array(zSnowflake).optional(),
            actor_has_admin: z.boolean().optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => `${i.path.join('.')}: ${i.message}`)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { id } = p.data;
        const { actor_user_id, removal_reason, actor_roles, actor_has_admin } = b.data;

        try {
            // Get the note first
            const checkResult = await query<{
                id: string;
                guild_id: string;
                user_id: string;
                moderator_id: string;
                note_text: string;
                created_at: string;
            }>(
                `SELECT id, guild_id, user_id, moderator_id, note_text, created_at
                 FROM note
                 WHERE id = $1`,
                [id]
            );

            if (checkResult.rows.length === 0) {
                return reply.status(404).send({
                    error: {
                        code: 'NOTE_NOT_FOUND',
                        message: 'Note not found',
                    },
                });
            }

            const note = checkResult.rows[0];

            // Authorization check
            try {
                await requireSecurity(note.guild_id, actor_user_id, actor_roles);
            } catch (err) {
                logger.warn({ actorUserId: actor_user_id, noteId: id }, 'User denied note removal - not security');
                throw err;
            }

            // Ensure actor exists in member table before deleting note
            await ensureMemberExists(actor_user_id);

            // Delete the note
            await query(
                `DELETE FROM note WHERE id = $1`,
                [id]
            );

            // Log audit event for note removal
            await logAudit(note.guild_id, actor_user_id, 'note.removed', note.user_id, {
                note_id: id,
                note_text: note.note_text,
                removal_reason,
            });

            return reply.send({
                id: note.id,
                guild_id: note.guild_id,
                user_id: note.user_id,
                moderator_id: note.moderator_id,
                note_text: note.note_text,
                created_at: note.created_at,
                removed_by: actor_user_id,
                removal_reason,
            });
        } catch (err) {
            logger.error({ err, noteId: id }, 'Failed to remove note');
            return Errors.internal(reply, 'Failed to remove note');
        }
    });
}

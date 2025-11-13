// backend/src/routes/notes.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';
import { logAudit } from '../lib/audit.js';
import { hasSecurity } from '../lib/permissions.js';

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
            console.error('[Notes] Validation failed for POST /notes:', {
                issues: parsed.error.issues,
                body: req.body,
            });
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { actor_user_id, guild_id, user_id, note_text, actor_roles } = parsed.data;

        // Authorization check
        const authorized = await hasSecurity(guild_id, actor_roles);
        if (!authorized) {
            console.log(`[Notes] User ${actor_user_id} in guild ${guild_id} denied - not moderator/security`);
            return Errors.notAuthorized(reply);
        }

        try {
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
            console.error('[Notes] Failed to create note:', err);
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
            console.error('[Notes] Failed to get note:', err);
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
            console.error('[Notes] Failed to get user notes:', err);
            return Errors.internal(reply, 'Failed to retrieve notes');
        }
    });
}

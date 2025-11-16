// backend/src/routes/moderation/modmail.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { requireOfficer } from '../../lib/auth/authorization.js';
import { ensureGuildExists, ensureMemberExists } from '../../lib/database/database-helpers.js';
import { logAudit } from '../../lib/logging/audit.js';

/**
 * Schema for creating a modmail ticket
 */
const CreateModmailTicketBody = z.object({
    ticket_id: z.string().regex(/^MM-[A-Z0-9]{6}$/),
    guild_id: zSnowflake,
    user_id: zSnowflake,
    content: z.string().max(2000),
    attachments: z.array(z.string().url()).default([]),
    thread_id: zSnowflake.optional(),
    message_id: zSnowflake.optional(),
});

/**
 * Schema for closing a modmail ticket
 */
const CloseModmailTicketBody = z.object({
    closed_by: zSnowflake,
});

/**
 * Schema for adding a message to a modmail ticket
 */
const AddModmailMessageBody = z.object({
    author_id: zSnowflake,
    content: z.string().max(2000),
    attachments: z.array(z.string().url()).default([]),
    is_staff_reply: z.boolean(),
});

/**
 * Schema for blacklisting a user from modmail
 */
const BlacklistModmailBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(),
    guild_id: zSnowflake,
    user_id: zSnowflake,
    reason: z.string().min(1).max(500),
});

/**
 * Schema for unblacklisting a user from modmail
 */
const UnblacklistModmailBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(),
    guild_id: zSnowflake,
    user_id: zSnowflake,
    reason: z.string().min(1).max(500),
});

export default async function modmailRoutes(app: FastifyInstance) {
    /**
     * POST /modmail/tickets
     * Create a new modmail ticket
     */
    app.post('/modmail/tickets', async (req, reply) => {
        const parsed = CreateModmailTicketBody.safeParse(req.body);

        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { ticket_id, guild_id, user_id, content, attachments, thread_id, message_id } = parsed.data;

        try {
            // Check if user already has an open ticket in this guild
            const existingTickets = await query<{ ticket_id: string }>(
                `SELECT ticket_id FROM modmail_ticket 
                 WHERE guild_id = $1::bigint AND user_id = $2::bigint AND status = 'open'`,
                [guild_id, user_id]
            );

            if (existingTickets.rows.length > 0) {
                return reply.code(400).send({
                    error: {
                        code: 'EXISTING_TICKET',
                        message: 'You already have an open modmail ticket in this server. Please wait for staff to respond or close your existing ticket before creating a new one.',
                        existing_ticket_id: existingTickets.rows[0].ticket_id,
                    }
                });
            }

            // Create ticket
            const ticketResult = await query<{
                ticket_id: string;
                guild_id: string;
                user_id: string;
                status: string;
                thread_id: string | null;
                message_id: string | null;
                created_at: string;
            }>(
                `INSERT INTO modmail_ticket (ticket_id, guild_id, user_id, status, thread_id, message_id, created_at)
                 VALUES ($1, $2::bigint, $3::bigint, 'open', $4::bigint, $5::bigint, NOW())
                 RETURNING ticket_id, guild_id, user_id, status, thread_id, message_id, created_at`,
                [ticket_id, guild_id, user_id, thread_id || null, message_id || null]
            );

            if (ticketResult.rows.length === 0) {
                return Errors.internal(reply, 'Failed to create modmail ticket');
            }

            const ticket = ticketResult.rows[0];

            // Add the initial message
            await query(
                `INSERT INTO modmail_message (ticket_id, author_id, content, attachments, sent_at, is_staff_reply)
                 VALUES ($1, $2::bigint, $3, $4::jsonb, NOW(), false)`,
                [ticket_id, user_id, content, JSON.stringify(attachments)]
            );

            return reply.code(201).send(ticket);
        } catch (err) {
            console.error('[Modmail] Error creating ticket:', err);
            if ((err as any).code === '23505') {
                return Errors.validation(reply, 'A ticket with this ID already exists');
            }
            return Errors.internal(reply, 'Failed to create modmail ticket');
        }
    });

    /**
     * GET /modmail/tickets/:ticket_id
     * Get a modmail ticket by ID
     */
    app.get<{ Params: { ticket_id: string } }>('/modmail/tickets/:ticket_id', async (req, reply) => {
        const { ticket_id } = req.params;

        try {
            const result = await query<{
                ticket_id: string;
                guild_id: string;
                user_id: string;
                status: string;
                thread_id: string | null;
                message_id: string | null;
                created_at: string;
                closed_at: string | null;
                closed_by: string | null;
            }>(
                `SELECT ticket_id, guild_id, user_id, status, thread_id, message_id, created_at, closed_at, closed_by
                 FROM modmail_ticket
                 WHERE ticket_id = $1`,
                [ticket_id]
            );

            if (result.rows.length === 0) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Modmail ticket not found'
                    }
                });
            }

            return reply.send(result.rows[0]);
        } catch (err) {
            console.error('[Modmail] Error fetching ticket:', err);
            return Errors.internal(reply, 'Failed to fetch modmail ticket');
        }
    });

    /**
     * PATCH /modmail/tickets/:ticket_id/close
     * Close a modmail ticket
     */
    app.patch<{ Params: { ticket_id: string } }>('/modmail/tickets/:ticket_id/close', async (req, reply) => {
        const { ticket_id } = req.params;
        const parsed = CloseModmailTicketBody.safeParse(req.body);

        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { closed_by } = parsed.data;

        try {
            const result = await query<{
                ticket_id: string;
                status: string;
                closed_at: string;
                closed_by: string;
            }>(
                `UPDATE modmail_ticket
                 SET status = 'closed', closed_at = NOW(), closed_by = $2::bigint
                 WHERE ticket_id = $1 AND status = 'open'
                 RETURNING ticket_id, status, closed_at, closed_by`,
                [ticket_id, closed_by]
            );

            if (result.rows.length === 0) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Modmail ticket not found or already closed'
                    }
                });
            }

            return reply.send(result.rows[0]);
        } catch (err) {
            console.error('[Modmail] Error closing ticket:', err);
            return Errors.internal(reply, 'Failed to close modmail ticket');
        }
    });

    /**
     * POST /modmail/tickets/:ticket_id/messages
     * Add a message to a modmail ticket
     */
    app.post<{ Params: { ticket_id: string } }>('/modmail/tickets/:ticket_id/messages', async (req, reply) => {
        const { ticket_id } = req.params;
        const parsed = AddModmailMessageBody.safeParse(req.body);

        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { author_id, content, attachments, is_staff_reply } = parsed.data;

        try {
            // Verify ticket exists and is open
            const ticketCheck = await query(
                `SELECT ticket_id FROM modmail_ticket WHERE ticket_id = $1 AND status = 'open'`,
                [ticket_id]
            );

            if (ticketCheck.rows.length === 0) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Modmail ticket not found or already closed'
                    }
                });
            }

            // Add message
            const result = await query<{
                message_id: number;
                ticket_id: string;
                author_id: string;
                content: string;
                attachments: string[];
                sent_at: string;
                is_staff_reply: boolean;
            }>(
                `INSERT INTO modmail_message (ticket_id, author_id, content, attachments, sent_at, is_staff_reply)
                 VALUES ($1, $2::bigint, $3, $4::jsonb, NOW(), $5)
                 RETURNING message_id, ticket_id, author_id, content, attachments, sent_at, is_staff_reply`,
                [ticket_id, author_id, content, JSON.stringify(attachments), is_staff_reply]
            );

            if (result.rows.length === 0) {
                return Errors.internal(reply, 'Failed to add message to modmail ticket');
            }

            return reply.code(201).send(result.rows[0]);
        } catch (err) {
            console.error('[Modmail] Error adding message:', err);
            return Errors.internal(reply, 'Failed to add message to modmail ticket');
        }
    });

    /**
     * GET /modmail/tickets/:ticket_id/messages
     * Get all messages for a modmail ticket
     */
    app.get<{ Params: { ticket_id: string } }>('/modmail/tickets/:ticket_id/messages', async (req, reply) => {
        const { ticket_id } = req.params;

        try {
            const result = await query<{
                message_id: number;
                ticket_id: string;
                author_id: string;
                content: string;
                attachments: string[];
                sent_at: string;
                is_staff_reply: boolean;
            }>(
                `SELECT message_id, ticket_id, author_id, content, attachments, sent_at, is_staff_reply
                 FROM modmail_message
                 WHERE ticket_id = $1
                 ORDER BY sent_at ASC`,
                [ticket_id]
            );

            return reply.send({ messages: result.rows });
        } catch (err) {
            console.error('[Modmail] Error fetching messages:', err);
            return Errors.internal(reply, 'Failed to fetch modmail messages');
        }
    });

    /**
     * GET /modmail/tickets/guild/:guild_id
     * Get all modmail tickets for a guild
     */
    app.get<{ 
        Params: { guild_id: string };
        Querystring: { status?: 'open' | 'closed' };
    }>('/modmail/tickets/guild/:guild_id', async (req, reply) => {
        const { guild_id } = req.params;
        const { status } = req.query;

        try {
            let queryText = `
                SELECT ticket_id, guild_id, user_id, status, thread_id, message_id, created_at, closed_at, closed_by
                FROM modmail_ticket
                WHERE guild_id = $1
            `;
            const params: any[] = [guild_id];

            if (status) {
                queryText += ` AND status = $2`;
                params.push(status);
            }

            queryText += ` ORDER BY created_at DESC`;

            const result = await query<{
                ticket_id: string;
                guild_id: string;
                user_id: string;
                status: string;
                thread_id: string | null;
                message_id: string | null;
                created_at: string;
                closed_at: string | null;
                closed_by: string | null;
            }>(queryText, params);

            return reply.send({ tickets: result.rows });
        } catch (err) {
            console.error('[Modmail] Error fetching guild tickets:', err);
            return Errors.internal(reply, 'Failed to fetch modmail tickets');
        }
    });

    /**
     * GET /modmail/blacklist/:guild_id/:user_id
     * Check if a user is blacklisted from modmail in a specific guild
     */
    app.get<{ Params: { guild_id: string; user_id: string } }>('/modmail/blacklist/:guild_id/:user_id', async (req, reply) => {
        const { guild_id, user_id } = req.params;

        try {
            const result = await query<{
                modmail_blacklisted: boolean;
                modmail_blacklist_reason: string | null;
                modmail_blacklisted_by: string | null;
                modmail_blacklisted_at: string | null;
            }>(
                `SELECT modmail_blacklisted, modmail_blacklist_reason, modmail_blacklisted_by, modmail_blacklisted_at
                 FROM raider
                 WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
                [guild_id, user_id]
            );

            if (result.rows.length === 0) {
                // User not in raider table, so not blacklisted
                return reply.send({
                    blacklisted: false,
                    reason: null,
                    blacklisted_by: null,
                    blacklisted_at: null,
                });
            }

            const row = result.rows[0];
            return reply.send({
                blacklisted: row.modmail_blacklisted,
                reason: row.modmail_blacklist_reason,
                blacklisted_by: row.modmail_blacklisted_by,
                blacklisted_at: row.modmail_blacklisted_at,
            });
        } catch (err) {
            console.error('[Modmail] Error checking blacklist:', err);
            return Errors.internal(reply, 'Failed to check modmail blacklist');
        }
    });

    /**
     * POST /modmail/blacklist
     * Blacklist a user from using modmail (Officer+ only)
     */
    app.post('/modmail/blacklist', async (req, reply) => {
        const parsed = BlacklistModmailBody.safeParse(req.body);

        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { actor_user_id, actor_roles, guild_id, user_id, reason } = parsed.data;

        // Authorization: actor must have officer role or higher (officer, head_organizer, moderator, administrator)
        try {
            await requireOfficer(guild_id, actor_user_id, actor_roles);
        } catch (err) {
            console.log(`[Modmail] User ${actor_user_id} denied blacklist - not officer`);
            throw err;
        }

        try {
            // Ensure guild and members exist
            await ensureGuildExists(guild_id);
            await ensureMemberExists(user_id);
            await ensureMemberExists(actor_user_id);

            // Upsert raider record with blacklist info
            const result = await query<{
                guild_id: string;
                user_id: string;
                modmail_blacklisted: boolean;
                modmail_blacklist_reason: string;
                modmail_blacklisted_by: string;
                modmail_blacklisted_at: string;
            }>(
                `INSERT INTO raider (guild_id, user_id, modmail_blacklisted, modmail_blacklist_reason, modmail_blacklisted_by, modmail_blacklisted_at)
                 VALUES ($1::bigint, $2::bigint, true, $3, $4::bigint, NOW())
                 ON CONFLICT (guild_id, user_id) 
                 DO UPDATE SET 
                    modmail_blacklisted = true,
                    modmail_blacklist_reason = $3,
                    modmail_blacklisted_by = $4::bigint,
                    modmail_blacklisted_at = NOW()
                 RETURNING guild_id, user_id, modmail_blacklisted, modmail_blacklist_reason, modmail_blacklisted_by, modmail_blacklisted_at`,
                [guild_id, user_id, reason, actor_user_id]
            );

            // Log audit event
            await logAudit(guild_id, actor_user_id, 'modmail.blacklist', `user:${user_id}`, { reason });

            return reply.code(200).send({
                success: true,
                blacklist: result.rows[0],
            });
        } catch (err) {
            console.error('[Modmail] Error blacklisting user:', err);
            return Errors.internal(reply, 'Failed to blacklist user from modmail');
        }
    });

    /**
     * POST /modmail/unblacklist
     * Remove modmail blacklist from a user (Officer+ only)
     */
    app.post('/modmail/unblacklist', async (req, reply) => {
        const parsed = UnblacklistModmailBody.safeParse(req.body);

        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { actor_user_id, actor_roles, guild_id, user_id, reason } = parsed.data;

        // Authorization: actor must have officer role or higher (officer, head_organizer, moderator, administrator)
        try {
            await requireOfficer(guild_id, actor_user_id, actor_roles);
        } catch (err) {
            console.log(`[Modmail] User ${actor_user_id} denied unblacklist - not officer`);
            throw err;
        }

        try {
            // Update raider record to remove blacklist
            const result = await query<{
                guild_id: string;
                user_id: string;
                modmail_blacklisted: boolean;
            }>(
                `UPDATE raider
                 SET modmail_blacklisted = false,
                     modmail_blacklist_reason = NULL,
                     modmail_blacklisted_by = NULL,
                     modmail_blacklisted_at = NULL
                 WHERE guild_id = $1::bigint AND user_id = $2::bigint
                 RETURNING guild_id, user_id, modmail_blacklisted`,
                [guild_id, user_id]
            );

            if (result.rows.length === 0) {
                return reply.code(404).send({
                    error: {
                        code: 'NOT_FOUND',
                        message: 'User not found in raider records',
                    },
                });
            }

            // Log audit event
            await logAudit(guild_id, actor_user_id, 'modmail.unblacklist', `user:${user_id}`, { reason });

            return reply.code(200).send({
                success: true,
                message: 'User unblacklisted from modmail',
            });
        } catch (err) {
            console.error('[Modmail] Error unblacklisting user:', err);
            return Errors.internal(reply, 'Failed to unblacklist user from modmail');
        }
    });
}

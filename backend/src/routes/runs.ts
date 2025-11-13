// backend/src/routes/runs.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { zSnowflake, zReactionState } from '../lib/constants';
import { Errors } from '../lib/errors';
import { hasInternalRole } from '../lib/authorization.js';
import { logQuotaEvent, getPointsForDungeon, awardRaiderPoints } from '../lib/quota.js';
import { ensureGuildExists, ensureMemberExists } from '../lib/database-helpers.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('Runs');

/**
 * Body schema for creating a run.
 * Uses Snowflake guards for all Discord IDs.
 */
const CreateRun = z.object({
    guildId: zSnowflake,
    guildName: z.string().min(1),
    organizerId: zSnowflake,
    organizerUsername: z.string().min(1),
    organizerRoles: z.array(zSnowflake).optional(), // Discord role IDs of the organizer
    channelId: zSnowflake,
    dungeonKey: z.string().trim().min(1).max(64),
    dungeonLabel: z.string().trim().min(1).max(100),
    description: z.string().optional(),
    party: z.string().optional(),
    location: z.string().optional(),
    autoEndMinutes: z.number().int().positive().max(1440).default(120), // default 2 hours, max 24 hours
});

export default async function runsRoutes(app: FastifyInstance) {
    /**
     * POST /runs
     * Create a new run record (status=open) and upsert guild/member.
     */
    app.post('/runs', async (req, reply) => {
        const parsed = CreateRun.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }
        const {
            guildId,
            guildName,
            organizerId,
            organizerUsername,
            organizerRoles,
            channelId,
            dungeonKey,
            dungeonLabel,
            description,
            party,
            location,
            autoEndMinutes,
        } = parsed.data;

        // Authorization: Check if user has organizer role
        const hasOrganizerRole = await hasInternalRole(guildId, organizerId, 'organizer', organizerRoles);
        if (!hasOrganizerRole) {
            logger.warn({ 
                guildId, 
                organizerId, 
                userRoles: organizerRoles || [] 
            }, 'Run creation denied - no organizer role');
            return reply.code(403).send({
                error: {
                    code: 'NOT_ORGANIZER',
                    message: 'You must have the Organizer role to create runs. Ask a server admin to configure roles with /setroles.',
                },
            });
        }

        // Upsert guild & member snapshots
        await ensureGuildExists(guildId, guildName);
        await ensureMemberExists(organizerId, organizerUsername);

        // Insert run (status=open)
        const res = await query<{ id: number }>(
            `INSERT INTO run (guild_id, organizer_id, dungeon_key, dungeon_label, channel_id, status, description, party, location, auto_end_minutes)
        VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, 'open', $6, $7, $8, $9)
        RETURNING id`,
            [guildId, organizerId, dungeonKey, dungeonLabel, channelId, description, party, location, autoEndMinutes]
        );

        return reply.code(201).send({ runId: res.rows[0].id });
    });

    /**
   * POST /runs/:id/reactions
   * Body: { userId: Snowflake, state: 'join' }
   * Behavior:
   *  - 'join' -> upsert state
   * Blocks if run is ended/cancelled.
   * Returns { joinCount }.
   */
    app.post('/runs/:id/reactions', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            userId: zSnowflake,
            state: zReactionState, // 'join'
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { userId, state } = b.data;

        // Block edits for closed runs
        const statusRes = await query<{ status: string }>(
            `SELECT status FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const currentStatus = statusRes.rows[0].status;
        if (currentStatus === 'ended') {
            return Errors.runClosed(reply);
        }

        // Ensure member exists
        await ensureMemberExists(userId);

        // Upsert join state
        await query(
            `INSERT INTO reaction (run_id, user_id, state)
        VALUES ($1::bigint, $2::bigint, $3)
        ON CONFLICT (run_id, user_id)
        DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
            [runId, userId, state]
        );

        // Return count for quick UI updates
        const joinRes = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
         FROM reaction
        WHERE run_id = $1::bigint AND state = 'join'`,
            [runId]
        );

        return reply.send({
            joinCount: Number(joinRes.rows[0].count),
        });
    });

    /**
     * PATCH /runs/:id/reactions
     * Body: { userId: Snowflake, class: string }
     * Updates the user's class selection for a run.
     * Auto-joins the user if they haven't already.
     * Returns { joinCount, classCounts: Record<string, number> }.
     */
    app.patch('/runs/:id/reactions', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            userId: zSnowflake,
            class: z.string().trim().min(1).max(50),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { userId, class: selectedClass } = b.data;

        // Block edits for closed runs
        const statusRes = await query<{ status: string }>(
            `SELECT status FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const currentStatus = statusRes.rows[0].status;
        if (currentStatus === 'ended') {
            return Errors.runClosed(reply);
        }

        // Ensure member exists
        await ensureMemberExists(userId);

        // Upsert reaction with class (default to 'join' if new)
        await query(
            `INSERT INTO reaction (run_id, user_id, state, class)
        VALUES ($1::bigint, $2::bigint, 'join', $3)
        ON CONFLICT (run_id, user_id)
        DO UPDATE SET class = EXCLUDED.class, updated_at = now()`,
            [runId, userId, selectedClass]
        );

        // Get join count
        const joinRes = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
         FROM reaction
        WHERE run_id = $1::bigint AND state = 'join'`,
            [runId]
        );

        // Get class counts (only for joined users)
        const classRes = await query<{ class: string | null; count: string }>(
            `SELECT class, COUNT(*)::text AS count
         FROM reaction
        WHERE run_id = $1::bigint AND state = 'join' AND class IS NOT NULL
        GROUP BY class`,
            [runId]
        );

        const classCounts: Record<string, number> = {};
        for (const row of classRes.rows) {
            if (row.class) {
                classCounts[row.class] = Number(row.count);
            }
        }

        return reply.send({
            joinCount: Number(joinRes.rows[0].count),
            classCounts,
        });
    });

    /**
     * PATCH /runs/:id
     * Body: { actorId: Snowflake, actorRoles?: string[], status: 'live' | 'ended', isAutoEnd?: boolean }
     * Allowed transitions: open->live, live->ended (or any->ended for auto-end).
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     * For auto-end: isAutoEnd flag bypasses authorization and allows any->ended transition.
     */
    app.patch('/runs/:id', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            status: z.enum(['live', 'ended']),
            isAutoEnd: z.boolean().optional(), // Flag for automatic ending
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles, status, isAutoEnd } = b.data;

        // Read current status AND organizer_id AND guild_id AND dungeon_key
        const cur = await query<{ status: string; organizer_id: string; guild_id: string; dungeon_key: string }>(
            `SELECT status, organizer_id, guild_id, dungeon_key FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const from = cur.rows[0].status;
        const organizerId = cur.rows[0].organizer_id;
        const guildId = cur.rows[0].guild_id;
        const dungeonKey = cur.rows[0].dungeon_key;

        // Authorization: actor must be the organizer OR have organizer role (skip for auto-end)
        if (!isAutoEnd) {
            const isOrganizer = actorId === organizerId;
            const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
            
            if (!isOrganizer && !hasOrganizerRole) {
                return Errors.notOrganizer(reply);
            }
        }

        if (status === 'live') {
            // allow only open -> live
            if (from !== 'open') {
                return Errors.invalidStatusTransition(reply, from, status);
            }
            await query(
                `UPDATE run
            SET status='live',
                started_at = COALESCE(started_at, now())
          WHERE id = $1::bigint`,
                [runId]
            );
        } else {
            // status === 'ended'
            // For auto-end, allow any status -> ended
            // Otherwise, allow only live -> ended
            if (!isAutoEnd && from !== 'live') {
                return Errors.invalidStatusTransition(reply, from, status);
            }
            await query(
                `UPDATE run
            SET status='ended',
                ended_at = COALESCE(ended_at, now())
          WHERE id = $1::bigint`,
                [runId]
            );

            // Log quota event for organizer when run ends
            try {
                // Get the correct point value for this dungeon based on guild config
                const points = await getPointsForDungeon(guildId, dungeonKey, actorRoles);
                
                await logQuotaEvent(
                    guildId,
                    organizerId,
                    'run_completed',
                    `run:${runId}`,
                    dungeonKey, // Track dungeon for per-dungeon stats
                    points // Use calculated points based on dungeon overrides
                );
            } catch (err) {
                // Log error but don't fail the request
                logger.error({ err, runId, guildId, organizerId }, 'Failed to log quota event for run');
            }

            // Award points to raiders who joined the run
            try {
                await awardRaiderPoints(guildId, runId, dungeonKey);
            } catch (err) {
                // Log error but don't fail the request
                logger.error({ err, runId, guildId, dungeonKey }, 'Failed to award raider points for run');
            }
        }

        return reply.send({ ok: true, status });
    });

    /**
     * POST /runs/:id/message
     * Attach the public Discord message id to the run.
     */
    app.post('/runs/:id/message', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({ postMessageId: zSnowflake });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) return Errors.validation(reply);

        const runId = Number(p.data.id);
        await query(
            `UPDATE run SET post_message_id = $2::bigint WHERE id = $1::bigint`,
            [runId, b.data.postMessageId]
        );

        return reply.send({ ok: true });
    });

    /**
     * GET /runs/:id
     * Minimal getter to locate message + surface basic fields.
     */
    app.get('/runs/:id', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const p = Params.safeParse(req.params);
        if (!p.success) return Errors.validation(reply);

        const runId = Number(p.data.id);
        const res = await query<{
            id: number;
            channel_id: string | null;
            post_message_id: string | null;
            dungeon_key: string;
            dungeon_label: string;
            status: string;
            organizer_id: string;
            started_at: string | null;
            ended_at: string | null;
            key_window_ends_at: string | null;
            party: string | null;
            location: string | null;
            description: string | null;
        }>(
            `SELECT id, channel_id, post_message_id, dungeon_key, dungeon_label, status, organizer_id,
                    started_at, ended_at, key_window_ends_at, party, location, description
         FROM run
        WHERE id = $1::bigint`,
            [runId]
        );

        if (res.rowCount === 0) return Errors.runNotFound(reply, runId);

        const r = res.rows[0];
        return reply.send({
            id: r.id,
            channelId: r.channel_id,
            postMessageId: r.post_message_id,
            dungeonKey: r.dungeon_key,
            dungeonLabel: r.dungeon_label,
            status: r.status,
            organizerId: r.organizer_id,
            startedAt: r.started_at,
            endedAt: r.ended_at,
            keyWindowEndsAt: r.key_window_ends_at,
            party: r.party,
            location: r.location,
            description: r.description,
        });
    });

    /**
     * GET /runs/:id/classes
     * Get class counts for a run.
     */
    app.get('/runs/:id/classes', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const p = Params.safeParse(req.params);
        if (!p.success) return Errors.validation(reply);

        const runId = Number(p.data.id);

        // Get class counts (only for joined users)
        const classRes = await query<{ class: string | null; count: string }>(
            `SELECT class, COUNT(*)::text AS count
         FROM reaction
        WHERE run_id = $1::bigint AND state = 'join' AND class IS NOT NULL
        GROUP BY class`,
            [runId]
        );

        const classCounts: Record<string, number> = {};
        for (const row of classRes.rows) {
            if (row.class) {
                classCounts[row.class] = Number(row.count);
            }
        }

        return reply.send({ classCounts });
    });

    /**
     * GET /runs/expired
     * Get all runs that have exceeded their auto_end_minutes and should be auto-ended
     * Returns runs that are not 'ended' and have existed longer than auto_end_minutes
     */
    app.get('/runs/expired', async (req, reply) => {
        const res = await query<{
            id: number;
            guild_id: string;
            channel_id: string | null;
            post_message_id: string | null;
            dungeon_label: string;
            organizer_id: string;
            created_at: string;
            auto_end_minutes: number;
        }>(
            `SELECT id, guild_id, channel_id, post_message_id, dungeon_label, organizer_id, created_at, auto_end_minutes
             FROM run
             WHERE status != 'ended'
               AND created_at + (auto_end_minutes || ' minutes')::interval < NOW()
             ORDER BY created_at ASC`
        );

        return reply.send({ expired: res.rows });
    });

    /**
     * DELETE /runs/:id
     * Body: { actorId: Snowflake, actorRoles?: string[] }
     * Cancels the run (sets status to 'ended' with immediate effect).
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     */
    app.delete('/runs/:id', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles } = b.data;

        // Read current status AND organizer_id AND guild_id
        const cur = await query<{ status: string; organizer_id: string; guild_id: string }>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const currentStatus = cur.rows[0].status;
        const organizerId = cur.rows[0].organizer_id;
        const guildId = cur.rows[0].guild_id;

        // Authorization: actor must be the organizer OR have organizer role
        const isOrganizer = actorId === organizerId;
        const hasOrganizerRole = await hasInternalRole(guildId, actorId, 'organizer', actorRoles);
        
        if (!isOrganizer && !hasOrganizerRole) {
            return Errors.notOrganizer(reply);
        }

        // Don't allow canceling already ended runs
        if (currentStatus === 'ended') {
            return Errors.alreadyTerminal(reply);
        }

        // Set status to ended (cancel = immediate end)
        await query(
            `UPDATE run SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1::bigint`,
            [runId]
        );

        return reply.send({ ok: true, status: 'ended' });
    });

    /**
     * PATCH /runs/:id/key-window
     * Body: { actor_user_id: Snowflake, seconds?: number }
     * Sets key_window_ends_at to now() + seconds (default 30).
     * Requires status='live' and actor must be organizer.
     * Returns { key_window_ends_at: ISO string }.
     */
    app.patch('/runs/:id/key-window', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actor_user_id: zSnowflake,
            seconds: z.number().int().positive().max(300).default(30),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actor_user_id, seconds } = b.data;

        // Read current status AND organizer_id
        const cur = await query<{ status: string; organizer_id: string }>(
            `SELECT status, organizer_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const { status, organizer_id } = cur.rows[0];

        // Authorization: actor must be the organizer
        if (actor_user_id !== organizer_id) {
            return Errors.notOrganizer(reply);
        }

        // Must be live
        if (status !== 'live') {
            return reply.code(409).send({
                error: {
                    code: 'RUN_NOT_LIVE',
                    message: 'Can only pop keys during a live run',
                },
            });
        }

        // Set key_window_ends_at = now() + seconds
        const res = await query<{ key_window_ends_at: string }>(
            `UPDATE run
             SET key_window_ends_at = now() + ($2 || ' seconds')::interval
             WHERE id = $1::bigint
             RETURNING key_window_ends_at`,
            [runId, seconds]
        );

        return reply.send({ key_window_ends_at: res.rows[0].key_window_ends_at });
    });

    /**
     * PATCH /runs/:id/party
     * Body: { actorId: Snowflake, actorRoles?: string[], party: string }
     * Updates the party name for a run.
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     * Returns { ok: true, party: string }.
     */
    app.patch('/runs/:id/party', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            party: z.string().trim().max(100),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles, party } = b.data;

        // Read current status AND organizer_id AND guild_id
        const cur = await query<{ status: string; organizer_id: string; guild_id: string }>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const { status, organizer_id, guild_id } = cur.rows[0];

        // Authorization: actor must be the organizer OR have organizer role
        const isOrganizer = actorId === organizer_id;
        const hasOrganizerRole = await hasInternalRole(guild_id, actorId, 'organizer', actorRoles);
        
        if (!isOrganizer && !hasOrganizerRole) {
            return Errors.notOrganizer(reply);
        }

        // Don't allow updating ended runs
        if (status === 'ended') {
            return Errors.runClosed(reply);
        }

        // Update party
        await query(
            `UPDATE run SET party = $2 WHERE id = $1::bigint`,
            [runId, party || null]
        );

        return reply.send({ ok: true, party });
    });

    /**
     * PATCH /runs/:id/location
     * Body: { actorId: Snowflake, actorRoles?: string[], location: string }
     * Updates the location for a run.
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     * Returns { ok: true, location: string }.
     */
    app.patch('/runs/:id/location', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            location: z.string().trim().max(100),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles, location } = b.data;

        // Read current status AND organizer_id AND guild_id
        const cur = await query<{ status: string; organizer_id: string; guild_id: string }>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const { status, organizer_id, guild_id } = cur.rows[0];

        // Authorization: actor must be the organizer OR have organizer role
        const isOrganizer = actorId === organizer_id;
        const hasOrganizerRole = await hasInternalRole(guild_id, actorId, 'organizer', actorRoles);
        
        if (!isOrganizer && !hasOrganizerRole) {
            return Errors.notOrganizer(reply);
        }

        // Don't allow updating ended runs
        if (status === 'ended') {
            return Errors.runClosed(reply);
        }

        // Update location
        await query(
            `UPDATE run SET location = $2 WHERE id = $1::bigint`,
            [runId, location || null]
        );

        return reply.send({ ok: true, location });
    });

    /**
     * POST /runs/:id/key-reactions
     * Body: { userId: Snowflake, keyType: string }
     * Toggles a user's key reaction for a run.
     * If the user has already reacted with this key, it removes it.
     * If the user hasn't reacted with this key, it adds it.
     * Returns { keyCounts: Record<string, number> }.
     */
    app.post('/runs/:id/key-reactions', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            userId: zSnowflake,
            keyType: z.string().trim().min(1).max(50),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { userId, keyType } = b.data;

        // Block edits for closed runs
        const statusRes = await query<{ status: string }>(
            `SELECT status FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const currentStatus = statusRes.rows[0].status;
        if (currentStatus === 'ended') {
            return Errors.runClosed(reply);
        }

        // Ensure member exists
        await ensureMemberExists(userId);

        // Check if the user has already reacted with this key
        const existingRes = await query<{ key_type: string }>(
            `SELECT key_type FROM key_reaction
             WHERE run_id = $1::bigint AND user_id = $2::bigint AND key_type = $3`,
            [runId, userId, keyType]
        );

        let added = false; // Track whether we added or removed

        if (existingRes.rowCount && existingRes.rowCount > 0) {
            // Remove the key reaction (toggle off)
            await query(
                `DELETE FROM key_reaction
                 WHERE run_id = $1::bigint AND user_id = $2::bigint AND key_type = $3`,
                [runId, userId, keyType]
            );
            added = false;
        } else {
            // Add the key reaction (toggle on)
            await query(
                `INSERT INTO key_reaction (run_id, user_id, key_type)
                 VALUES ($1::bigint, $2::bigint, $3)`,
                [runId, userId, keyType]
            );
            added = true;
        }

        // Get updated key counts
        const keyRes = await query<{ key_type: string; count: string }>(
            `SELECT key_type, COUNT(*)::text AS count
             FROM key_reaction
             WHERE run_id = $1::bigint
             GROUP BY key_type`,
            [runId]
        );

        const keyCounts: Record<string, number> = {};
        for (const row of keyRes.rows) {
            keyCounts[row.key_type] = Number(row.count);
        }

        return reply.send({ keyCounts, added });
    });

    /**
     * GET /runs/:id/key-reactions
     * Get key counts for a run.
     * Returns { keyCounts: Record<string, number> }.
     */
    app.get('/runs/:id/key-reactions', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const p = Params.safeParse(req.params);
        if (!p.success) return Errors.validation(reply);

        const runId = Number(p.data.id);

        // Get key counts
        const keyRes = await query<{ key_type: string; count: string }>(
            `SELECT key_type, COUNT(*)::text AS count
             FROM key_reaction
             WHERE run_id = $1::bigint
             GROUP BY key_type`,
            [runId]
        );

        const keyCounts: Record<string, number> = {};
        for (const row of keyRes.rows) {
            keyCounts[row.key_type] = Number(row.count);
        }

        return reply.send({ keyCounts });
    });

    /**
     * GET /runs/:id/key-reaction-users
     * Get key reaction users grouped by key type for a run.
     * Returns { keyUsers: Record<string, string[]> } where each key type maps to an array of user IDs.
     */
    app.get('/runs/:id/key-reaction-users', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const p = Params.safeParse(req.params);
        if (!p.success) return Errors.validation(reply);

        const runId = Number(p.data.id);

        // Get all key reactions with user IDs
        const keyRes = await query<{ key_type: string; user_id: string }>(
            `SELECT key_type, user_id
             FROM key_reaction
             WHERE run_id = $1::bigint
             ORDER BY key_type, user_id`,
            [runId]
        );

        // Group users by key type
        const keyUsers: Record<string, string[]> = {};
        for (const row of keyRes.rows) {
            if (!keyUsers[row.key_type]) {
                keyUsers[row.key_type] = [];
            }
            keyUsers[row.key_type].push(row.user_id);
        }

        return reply.send({ keyUsers });
    });
}


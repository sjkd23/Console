// backend/src/routes/runs.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake, zReactionState } from '../../lib/constants/constants';
import { Errors } from '../../lib/errors/errors.js';
import { hasInternalRole } from '../../lib/auth/authorization.js';
import { logQuotaEvent, getPointsForDungeon, awardRaiderPoints, snapshotRaidersAtKeyPop, awardCompletionsToKeyPopSnapshot } from '../../lib/quota/quota.js';
import { ensureGuildExists, ensureMemberExists } from '../../lib/database/database-helpers.js';
import { createLogger } from '../../lib/logging/logger.js';
import { HIGH_TRAFFIC_LIMIT, MODERATE_TRAFFIC_LIMIT, createRateLimitConfig } from '../../lib/rate-limit/config.js';

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
    roleId: zSnowflake.optional(), // Optional Discord role ID for the run
});

export default async function runsRoutes(app: FastifyInstance) {
    /**
     * POST /runs
     * Create a new run record (status=open) and upsert guild/member.
     * 
     * MODERATE TRAFFIC: Run creation is less frequent than reactions.
     */
    app.post('/runs', {
        config: {
            rateLimit: createRateLimitConfig(MODERATE_TRAFFIC_LIMIT)
        }
    }, async (req, reply) => {
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
            roleId,
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
            `INSERT INTO run (guild_id, organizer_id, dungeon_key, dungeon_label, channel_id, status, description, party, location, auto_end_minutes, role_id)
        VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, 'open', $6, $7, $8, $9, $10::bigint)
        RETURNING id`,
            [guildId, organizerId, dungeonKey, dungeonLabel, channelId, description, party, location, autoEndMinutes, roleId]
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
     * 
     * HIGH TRAFFIC: Many users react during active raids.
     */
    app.post('/runs/:id/reactions', {
        config: {
            rateLimit: createRateLimitConfig(HIGH_TRAFFIC_LIMIT)
        }
    }, async (req, reply) => {
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
     * GET /runs/:id/reactions/:userId
     * Get a specific user's reaction state for a run.
     * Returns { state: 'join' | 'leave' | 'bench' | null, class: string | null }.
     */
    app.get('/runs/:id/reactions/:userId', async (req, reply) => {
        const Params = z.object({ 
            id: z.string().regex(/^\d+$/),
            userId: zSnowflake
        });

        const p = Params.safeParse(req.params);
        if (!p.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { userId } = p.data;

        const reactionRes = await query<{ state: string; class: string | null }>(
            `SELECT state, class FROM reaction WHERE run_id = $1::bigint AND user_id = $2::bigint`,
            [runId, userId]
        );

        if (reactionRes.rowCount === 0) {
            return reply.send({ state: null, class: null });
        }

        return reply.send(reactionRes.rows[0]);
    });    /**
     * PATCH /runs/:id/reactions
     * Body: { userId: Snowflake, class: string }
     * Updates the user's class selection for a run.
     * Auto-joins the user if they haven't already.
     * Returns { joinCount, classCounts: Record<string, number> }.
     * 
     * HIGH TRAFFIC: Many users select classes during active raids.
     */
    app.patch('/runs/:id/reactions', {
        config: {
            rateLimit: createRateLimitConfig(HIGH_TRAFFIC_LIMIT)
        }
    }, async (req, reply) => {
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
            
            // Get key_pop_count to determine if we need to award completions
            const keyPopRes = await query<{ key_pop_count: number }>(
                `SELECT key_pop_count FROM run WHERE id = $1::bigint`,
                [runId]
            );
            const keyPopCount = keyPopRes.rows[0]?.key_pop_count ?? 0;
            
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

            // Award completions to raiders from the last key pop snapshot (if any key pops occurred)
            if (keyPopCount > 0) {
                try {
                    const awardedCount = await awardCompletionsToKeyPopSnapshot(guildId, runId, keyPopCount, dungeonKey);
                    logger.info({ runId, keyPopCount, awardedCount }, 'Awarded completions to final key pop snapshot on run end');
                } catch (err) {
                    // Log error but don't fail the request
                    logger.error({ err, runId, guildId, dungeonKey }, 'Failed to award completions from final key pop snapshot');
                }
            } else {
                // No key pops occurred - fall back to old behavior (award to all joined raiders)
                // This maintains backward compatibility for runs that end without any key pops
                try {
                    await awardRaiderPoints(guildId, runId, dungeonKey);
                } catch (err) {
                    // Log error but don't fail the request
                    logger.error({ err, runId, guildId, dungeonKey }, 'Failed to award raider points for run');
                }
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
     * POST /runs/:id/ping-message
     * Update the ping message id for a run (for tracking the latest ping to delete it when sending a new one).
     */
    app.post('/runs/:id/ping-message', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({ pingMessageId: zSnowflake });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) return Errors.validation(reply);

        const runId = Number(p.data.id);
        await query(
            `UPDATE run SET ping_message_id = $2::bigint WHERE id = $1::bigint`,
            [runId, b.data.pingMessageId]
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
            role_id: string | null;
            ping_message_id: string | null;
            key_pop_count: number;
            chain_amount: number | null;
        }>(
            `SELECT id, channel_id, post_message_id, dungeon_key, dungeon_label, status, organizer_id,
                    started_at, ended_at, key_window_ends_at, party, location, description, role_id, ping_message_id,
                    key_pop_count, chain_amount
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
            roleId: r.role_id,
            pingMessageId: r.ping_message_id,
            keyPopCount: r.key_pop_count,
            chainAmount: r.chain_amount,
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
            role_id: string | null;
            ping_message_id: string | null;
        }>(
            `SELECT id, guild_id, channel_id, post_message_id, dungeon_label, organizer_id, created_at, auto_end_minutes, role_id, ping_message_id
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
     * Increments key_pop_count, snapshots current raiders, and awards completions to previous snapshot.
     * Returns { key_window_ends_at: ISO string, key_pop_count: number }.
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

        // Read current status, organizer_id, guild_id, dungeon_key, and key_pop_count
        const cur = await query<{ status: string; organizer_id: string; guild_id: string; dungeon_key: string; key_pop_count: number }>(
            `SELECT status, organizer_id, guild_id, dungeon_key, key_pop_count FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const { status, organizer_id, guild_id, dungeon_key, key_pop_count } = cur.rows[0];

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

        // Increment key_pop_count and set key_window_ends_at
        const newKeyPopCount = key_pop_count + 1;
        const res = await query<{ key_window_ends_at: string }>(
            `UPDATE run
             SET key_window_ends_at = now() + ($2 || ' seconds')::interval,
                 key_pop_count = $3
             WHERE id = $1::bigint
             RETURNING key_window_ends_at`,
            [runId, seconds, newKeyPopCount]
        );

        // If this is not the first key pop, award completions to the previous snapshot
        if (key_pop_count > 0) {
            try {
                await awardCompletionsToKeyPopSnapshot(guild_id, runId, key_pop_count, dungeon_key);
                logger.info({ runId, previousKeyPop: key_pop_count, newKeyPop: newKeyPopCount }, 'Awarded completions to previous key pop snapshot');
            } catch (err) {
                logger.error({ err, runId, keyPopNumber: key_pop_count }, 'Failed to award completions to previous key pop snapshot');
                // Don't fail the request - key pop should still work even if awarding fails
            }
        }

        // Snapshot current joined raiders for this new key pop
        try {
            const snapshotCount = await snapshotRaidersAtKeyPop(runId, newKeyPopCount);
            logger.info({ runId, keyPopNumber: newKeyPopCount, snapshotCount }, 'Created key pop snapshot');
        } catch (err) {
            logger.error({ err, runId, keyPopNumber: newKeyPopCount }, 'Failed to create key pop snapshot');
            // Don't fail the request - key pop should still work even if snapshot fails
        }

        return reply.send({ 
            key_window_ends_at: res.rows[0].key_window_ends_at,
            key_pop_count: newKeyPopCount
        });
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
     * PATCH /runs/:id/chain-amount
     * Body: { actorId: Snowflake, actorRoles?: string[], chainAmount: number }
     * Updates the chain amount for a run (e.g., 5 for a 5-chain).
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     * Returns { ok: true, chainAmount: number }.
     */
    app.patch('/runs/:id/chain-amount', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            chainAmount: z.number().int().positive().max(99),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles, chainAmount } = b.data;

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

        // Update chain amount
        await query(
            `UPDATE run SET chain_amount = $2 WHERE id = $1::bigint`,
            [runId, chainAmount]
        );

        return reply.send({ ok: true, chainAmount });
    });

    /**
     * POST /runs/:id/key-reactions
     * Body: { userId: Snowflake, keyType: string }
     * Toggles a user's key reaction for a run.
     * If the user has already reacted with this key, it removes it.
     * If the user hasn't reacted with this key, it adds it.
     * Returns { keyCounts: Record<string, number> }.
     * 
     * HIGH TRAFFIC: Users toggle key reactions during run setup.
     */
    app.post('/runs/:id/key-reactions', {
        config: {
            rateLimit: createRateLimitConfig(HIGH_TRAFFIC_LIMIT)
        }
    }, async (req, reply) => {
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


// backend/src/routes/runs.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake, zReactionState } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { hasInternalRole, authorizeRunActor, buildRunActorContext, RunRow } from '../../lib/auth/authorization.js';
import { snapshotRaidersAtKeyPop } from '../../lib/quota/quota.js';
import { ensureMemberExists } from '../../lib/database/database-helpers.js';
import { createLogger } from '../../lib/logging/logger.js';
import { createRunWithTransaction, endRunWithTransaction } from '../../lib/services/run-service.js';
import { QuotaService } from '../../lib/services/quota-service.js';
import { RAID_BEHAVIOR } from '../../config/raid-config.js';

const logger = createLogger('Runs');
const quotaService = new QuotaService();

/**
 * Enforce guild scoping: if the request has a guild context, ensure the run belongs to that guild.
 * Returns true if the check passes (or no guild context provided), false if denied.
 * If denied, it logs a warning and sends a 403 response.
 * 
 * TODO: Once all bot calls send x-guild-id, make callerGuildId required (deny if absent).
 */
function enforceGuildScope(
    req: FastifyRequest,
    reply: FastifyReply,
    run: { guild_id: string },
    runId: string | number
): boolean {
    const guildContext = (req as any).guildContext;
    const callerGuildId = guildContext?.guildId;

    if (callerGuildId && run.guild_id !== callerGuildId) {
        logger.warn({
            runId,
            runGuildId: run.guild_id,
            callerGuildId,
        }, 'Guild mismatch for run access');
        
        Errors.notAuthorized(reply, 'run does not belong to this guild');
        return false;
    }

    return true;
}

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
    autoEndMinutes: z.number().int().positive().max(RAID_BEHAVIOR.maxAutoEndMinutes).default(RAID_BEHAVIOR.defaultAutoEndMinutes),
    roleId: zSnowflake.optional(), // Optional Discord role ID for the run
});

export default async function runsRoutes(app: FastifyInstance) {
    /**
     * GET /runs/active-by-organizer/:organizerId
     * Get all active (open or live) runs for a specific organizer in the current guild.
     * Used to enforce "one run per organizer" rule.
     * Returns { activeRuns: Array<{ id, dungeonLabel, status, createdAt }> }
     */
    app.get('/runs/active-by-organizer/:organizerId', async (req, reply) => {
        const Params = z.object({ organizerId: zSnowflake });
        const p = Params.safeParse(req.params);
        if (!p.success) return Errors.validation(reply);

        const { organizerId } = p.data;

        // Get guild context (required for this endpoint)
        const guildContext = (req as any).guildContext;
        const callerGuildId = guildContext?.guildId;

        if (!callerGuildId) {
            return reply.code(400).send({
                error: {
                    code: 'MISSING_GUILD_CONTEXT',
                    message: 'This endpoint requires guild context (x-guild-id header)',
                },
            });
        }

        // Query for active runs (status = 'open' or 'live') for this organizer in this guild
        const res = await query<{
            id: number;
            dungeon_label: string;
            status: string;
            created_at: string;
            channel_id: string;
            post_message_id: string | null;
        }>(
            `SELECT id, dungeon_label, status, created_at, channel_id, post_message_id
             FROM run
             WHERE organizer_id = $1::bigint
               AND guild_id = $2::bigint
               AND status IN ('open', 'live')
             ORDER BY created_at DESC`,
            [organizerId, callerGuildId]
        );

        const activeRuns = res.rows.map(r => ({
            id: r.id,
            dungeonLabel: r.dungeon_label,
            status: r.status,
            createdAt: r.created_at,
            channelId: r.channel_id,
            postMessageId: r.post_message_id,
        }));

        return reply.send({ activeRuns });
    });

    /**
     * GET /runs/active
     * Get all active (open or live) runs for the current guild.
     * Used for cleanup tasks (e.g., orphaned role detection).
     * Returns { runs: Array<{ id, role_id }> }
     */
    app.get('/runs/active', async (req, reply) => {
        // Get guild context (required for this endpoint)
        const guildContext = (req as any).guildContext;
        const callerGuildId = guildContext?.guildId;

        if (!callerGuildId) {
            return reply.code(400).send({
                error: {
                    code: 'MISSING_GUILD_CONTEXT',
                    message: 'This endpoint requires guild context (x-guild-id header)',
                },
            });
        }

        // Query for all active runs (status = 'open' or 'live') in this guild
        const res = await query<{
            id: number;
            role_id: string | null;
        }>(
            `SELECT id, role_id
             FROM run
             WHERE guild_id = $1::bigint
               AND status IN ('open', 'live')
             ORDER BY created_at DESC`,
            [callerGuildId]
        );

        const runs = res.rows.map(r => ({
            id: r.id,
            role_id: r.role_id,
        }));

        return reply.send({ runs });
    });

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

        // Create run with transaction (ensures atomicity of guild/member/run creation)
        try {
            const result = await createRunWithTransaction({
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
            });

            return reply.code(201).send({ runId: result.runId });
        } catch (err) {
            logger.error({ err, guildId, organizerId, dungeonKey }, 'Failed to create run');
            return Errors.internal(reply, 'Failed to create run');
        }
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

        // Block edits for closed runs + load guild_id
        const statusRes = await query<{ status: string; guild_id: string }>(
            `SELECT status, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = statusRes.rows[0];
        const currentStatus = run.status;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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

        // Load run to check guild_id
        const runRes = await query<{ guild_id: string }>(
            `SELECT guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = runRes.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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

        // Block edits for closed runs + load guild_id
        const statusRes = await query<{ status: string; guild_id: string }>(
            `SELECT status, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = statusRes.rows[0];
        const currentStatus = run.status;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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

        // Read current status AND organizer_id AND guild_id AND dungeon_key AND party AND location AND screenshot_url
        const cur = await query<RunRow & { dungeon_key: string; party: string | null; location: string | null; screenshot_url: string | null }>(
            `SELECT status, organizer_id, guild_id, dungeon_key, party, location, screenshot_url FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];
        const from = run.status;
        const dungeonKey = run.dungeon_key;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        // Note: isAutoEnd flag comes from the bot's auto-end task (trusted via API key)
        // and is used only for system-initiated run endings (not user actions)
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                    allowAutoEndBypass: isAutoEnd, // ⚠️ Only true for auto-end system task
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        if (status === 'live') {
            // allow only open -> live
            if (from !== 'open') {
                return Errors.invalidStatusTransition(reply, from, status);
            }

            // VALIDATION: Check if party and location are set (required for all dungeons)
            if (!run.party || !run.location) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARTY_LOCATION',
                        message: 'Party and Location must be set before starting the run.',
                        missing: {
                            party: !run.party,
                            location: !run.location,
                        },
                    },
                });
            }

            // VALIDATION: Check if screenshot is submitted for Oryx 3
            if (dungeonKey === 'ORYX_3' && !run.screenshot_url) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_SCREENSHOT',
                        message: 'Screenshot must be submitted before starting Oryx 3 runs.',
                    },
                });
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
            
            // End run with transaction (ensures atomicity of status update + quota/points awards)
            try {
                await endRunWithTransaction({
                    runId,
                    guildId: run.guild_id,
                    organizerId: run.organizer_id,
                    dungeonKey,
                    keyPopCount,
                    actorRoles,
                });
            } catch (err) {
                logger.error({ err, runId, guildId: run.guild_id, organizerId: run.organizer_id }, 
                    'Failed to end run with transaction');
                return Errors.internal(reply, 'Failed to end run');
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
     * POST /runs/:id/screenshot
     * Store screenshot URL for a run (required for Oryx 3 before going live).
     * Body: { actorId: Snowflake, actorRoles?: string[], screenshotUrl: string }
     * Authorization: actorId must match run.organizer_id OR have organizer role.
     */
    app.post('/runs/:id/screenshot', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            actorId: zSnowflake,
            actorRoles: z.array(zSnowflake).optional(),
            screenshotUrl: z.string().url().min(1),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid screenshot URL or missing parameters');
        }
        const runId = Number(p.data.id);
        const { actorId, actorRoles, screenshotUrl } = b.data;

        // Read current run details for authorization
        const cur = await query<RunRow>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        // Store screenshot URL
        await query(
            `UPDATE run SET screenshot_url = $2 WHERE id = $1::bigint`,
            [runId, screenshotUrl]
        );

        logger.info({ runId, guildId: run.guild_id, actorId, screenshotUrl }, 
            'Screenshot URL stored for run');

        return reply.send({ ok: true });
    });

    /**
     * PATCH /runs/:id/o3-stage
     * Update O3 progression stage for a run.
     * Body: { o3Stage: 'closed' | 'miniboss' | 'third_room' }
     * Authorization: Must be the organizer or have organizer role.
     */
    app.patch('/runs/:id/o3-stage', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            o3Stage: z.enum(['closed', 'miniboss', 'third_room']),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid o3Stage or missing parameters');
        }
        const runId = Number(p.data.id);
        const { o3Stage } = b.data;

        // Read current run details for authorization and validation
        const cur = await query<{
            status: string;
            organizer_id: string;
            guild_id: string;
            dungeon_key: string;
        }>(
            `SELECT status, organizer_id, guild_id, dungeon_key FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Only allow O3 runs to have O3 stages
        if (run.dungeon_key !== 'ORYX_3') {
            return Errors.validation(reply, 'O3 progression is only available for Oryx 3 runs');
        }

        // Update O3 stage
        await query(
            `UPDATE run SET o3_stage = $2 WHERE id = $1::bigint`,
            [runId, o3Stage]
        );

        logger.info({ runId, guildId: run.guild_id, o3Stage }, 
            'O3 progression stage updated');

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
            guild_id: string;
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
            screenshot_url: string | null;
            o3_stage: string | null;
        }>(
            `SELECT id, guild_id, channel_id, post_message_id, dungeon_key, dungeon_label, status, organizer_id,
                    started_at, ended_at, key_window_ends_at, party, location, description, role_id, ping_message_id,
                    key_pop_count, chain_amount, screenshot_url, o3_stage
         FROM run
        WHERE id = $1::bigint`,
            [runId]
        );

        if (res.rowCount === 0) return Errors.runNotFound(reply, runId);

        const r = res.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, r, runId)) return;

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
            screenshotUrl: r.screenshot_url,
            o3Stage: r.o3_stage,
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

        // Load run to check guild_id
        const runRes = await query<{ guild_id: string }>(
            `SELECT guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = runRes.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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
        const cur = await query<RunRow>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];
        const currentStatus = run.status;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
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
            seconds: z.number().int().positive().max(RAID_BEHAVIOR.maxKeyWindowSeconds).default(RAID_BEHAVIOR.defaultKeyWindowSeconds),
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);
        if (!p.success || !b.success) {
            return Errors.validation(reply);
        }
        const runId = Number(p.data.id);
        const { actor_user_id, seconds } = b.data;

        // Read current status, organizer_id, guild_id, dungeon_key, and key_pop_count
        const cur = await query<RunRow & { dungeon_key: string; key_pop_count: number }>(
            `SELECT status, organizer_id, guild_id, dungeon_key, key_pop_count FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];
        const { dungeon_key, key_pop_count, organizer_id } = run;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: only organizer (no staff override for key popping)
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actor_user_id),
                {
                    allowOrganizer: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        // Must be live
        if (run.status !== 'live') {
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
                await quotaService.awardRaidersQuotaFromSnapshot({
                    guildId: run.guild_id,
                    dungeonKey: dungeon_key,
                    runId: runId,
                    keyPopNumber: key_pop_count,
                });
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

        // Award organizer quota for this key pop
        try {
            const organizerQuotaPoints = await quotaService.awardOrganizerQuota({
                guildId: run.guild_id,
                dungeonKey: dungeon_key,
                runId: runId,
                organizerDiscordId: organizer_id,
                keyPopNumber: newKeyPopCount,
            });
            logger.info({ runId, keyPopNumber: newKeyPopCount, organizerQuotaPoints }, 'Awarded organizer quota for key pop');
        } catch (err) {
            logger.error({ err, runId, keyPopNumber: newKeyPopCount }, 'Failed to award organizer quota for key pop');
            // Don't fail the request - key pop should still work even if quota award fails
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
        const cur = await query<RunRow>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        // Don't allow updating ended runs
        if (run.status === 'ended') {
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
        const cur = await query<RunRow>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        // Don't allow updating ended runs
        if (run.status === 'ended') {
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
        const cur = await query<RunRow>(
            `SELECT status, organizer_id, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (cur.rowCount === 0) return Errors.runNotFound(reply, runId);
        const run = cur.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Authorization: use centralized helper
        try {
            await authorizeRunActor(
                run,
                buildRunActorContext(actorId, actorRoles),
                {
                    allowOrganizer: true,
                    allowOrganizerRole: true,
                }
            );
        } catch (err: any) {
            if (err.code === 'NOT_ORGANIZER') {
                return Errors.notOrganizer(reply);
            }
            throw err;
        }

        // Don't allow updating ended runs
        if (run.status === 'ended') {
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
     * Returns { keyCounts: Record<string, number>, added: boolean }.
     * 
     * Implementation note: Uses atomic DELETE/INSERT to avoid race conditions.
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

        // Block edits for closed runs + load guild_id
        const statusRes = await query<{ status: string; guild_id: string }>(
            `SELECT status, guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (statusRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = statusRes.rows[0];
        const currentStatus = run.status;

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        if (currentStatus === 'ended') {
            return Errors.runClosed(reply);
        }

        // Ensure member exists
        await ensureMemberExists(userId);

        // Atomically toggle: Try DELETE first, then INSERT if nothing was deleted
        // This avoids race conditions from separate SELECT + DELETE/INSERT
        let added = false;

        try {
            // Step 1: Try to delete the existing key reaction
            const deleteRes = await query(
                `DELETE FROM key_reaction
                 WHERE run_id = $1::bigint AND user_id = $2::bigint AND key_type = $3
                 RETURNING key_type`,
                [runId, userId, keyType]
            );

            if (deleteRes.rowCount && deleteRes.rowCount > 0) {
                // Successfully deleted - user had the key, now removed
                added = false;
            } else {
                // Nothing deleted - user didn't have the key, add it now
                // Use INSERT with ON CONFLICT DO NOTHING for extra safety (handles concurrent inserts)
                await query(
                    `INSERT INTO key_reaction (run_id, user_id, key_type)
                     VALUES ($1::bigint, $2::bigint, $3)
                     ON CONFLICT (run_id, user_id, key_type) DO NOTHING`,
                    [runId, userId, keyType]
                );
                added = true;
            }
        } catch (err: any) {
            // Handle any unexpected constraint violations gracefully
            // (Should not happen with ON CONFLICT, but defensive programming)
            if (err.code === '23505') {
                // Unique violation - treat as idempotent add (key already exists)
                logger.warn({ runId, userId, keyType, err: err.message }, 
                    'Key reaction unique constraint violation - treating as duplicate');
                added = true;
            } else {
                throw err;
            }
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

        // Load run to check guild_id
        const runRes = await query<{ guild_id: string }>(
            `SELECT guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = runRes.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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
     * POST /runs/:id/keys/bulk
     * Bulk import key reactions (used when converting headcount to run).
     * Body: { keys: Array<{ userId: string, keyType: string }> }
     * Returns: { imported: number }
     */
    app.post('/runs/:id/keys/bulk', async (req, reply) => {
        const Params = z.object({ id: z.string().regex(/^\d+$/) });
        const Body = z.object({
            keys: z.array(z.object({
                userId: zSnowflake,
                keyType: z.string()
            }))
        });

        const p = Params.safeParse(req.params);
        const b = Body.safeParse(req.body);

        if (!p.success || !b.success) {
            return Errors.validation(reply, 'Invalid request parameters');
        }

        const runId = Number(p.data.id);
        const { keys } = b.data;

        // Load run to check guild_id and authorization
        const runRes = await query<{ guild_id: string; organizer_id: string; status: string }>(
            `SELECT guild_id, organizer_id, status FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = runRes.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

        // Only allow importing keys during "open" status (not after run has started)
        if (run.status !== 'open') {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_STATUS',
                    message: 'Keys can only be imported before the run starts'
                }
            });
        }

        // Ensure all user members exist
        for (const key of keys) {
            await ensureMemberExists(key.userId);
        }

        // Bulk insert key reactions (ignore duplicates)
        let imported = 0;
        for (const key of keys) {
            try {
                const insertRes = await query(
                    `INSERT INTO key_reaction (run_id, user_id, key_type)
                     VALUES ($1::bigint, $2::bigint, $3)
                     ON CONFLICT (run_id, user_id, key_type) DO NOTHING
                     RETURNING key_type`,
                    [runId, key.userId, key.keyType]
                );
                
                if (insertRes.rowCount && insertRes.rowCount > 0) {
                    imported++;
                }
            } catch (err) {
                logger.error({ runId, userId: key.userId, keyType: key.keyType, err }, 
                    'Failed to import key reaction');
                // Continue with other keys
            }
        }

        logger.info({ runId, imported, total: keys.length }, 
            'Bulk imported key reactions from headcount');

        return reply.send({ imported });
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

        // Load run to check guild_id
        const runRes = await query<{ guild_id: string }>(
            `SELECT guild_id FROM run WHERE id = $1::bigint`,
            [runId]
        );
        if (runRes.rowCount === 0) {
            return Errors.runNotFound(reply, runId);
        }
        const run = runRes.rows[0];

        // Enforce guild scoping
        if (!enforceGuildScope(req, reply, run, runId)) return;

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


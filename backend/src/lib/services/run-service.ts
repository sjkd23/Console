/**
 * RunService - Encapsulates run lifecycle operations with transactional guarantees
 * 
 * This service provides atomic operations for:
 * - Creating runs (with guild/member upserts)
 * - Ending runs (with quota/points awards)
 * 
 * All multi-step operations are wrapped in database transactions to ensure
 * data integrity and prevent partial state on failures.
 */

import { createLogger } from '../logging/logger.js';
import { withTransaction } from '../database/transaction.js';
import { QuotaService } from './quota-service.js';
import { snapshotRaidersAtKeyPop } from '../quota/quota.js';
import { recordDungeonActivity } from '../dungeon-activity/activity-service.js';
import {
    organizerKeyPopActivitySubjectId,
    organizerRunActivitySubjectId,
} from '../dungeon-activity/activity-subject.js';
import { z } from 'zod';
import {
    classifyRunSelection,
    RunKindSchema,
    quotaBaseCategoryForRun,
    usesAggregateActivity,
    type ClassifiedRunSelection,
    type RunKind,
} from '../runs/run-taxonomy.js';
import { normalizeRunId } from '../runs/run-id.js';
import { isMinuteOrganizerQuotaRun, resolveMinuteQuotaRole } from '../runs/minute-quota.js';
import type { PoolClient } from 'pg';

const logger = createLogger('RunService');

// Instantiate quota service for handling all quota/points awards
const quotaService = new QuotaService();

// ============================================================================
// TYPES
// ============================================================================

export interface CreateRunInput {
    guildId: string;
    guildName: string;
    organizerId: string;
    organizerUsername: string;
    organizerRoles?: string[];
    channelId: string;
    selectedDungeonKeys: string[];
    description?: string;
    party?: string;
    location?: string;
    autoEndMinutes: number;
    roleId?: string;
}

export interface CreateRunResult extends ClassifiedRunSelection {
    runId: number;
}

export interface EndRunInput {
    runId: number;
    guildId: string;
    /** Legacy caller fields retained for source compatibility; persisted run values are authoritative. */
    organizerId?: string;
    dungeonKey?: string;
    keyPopCount?: number;
    organizerRoles?: string[];
    organizerRolePositions?: Record<string, number>;
    isAutoEnd?: boolean;
}

export interface StartRunInput {
    runId: number;
    guildId: string;
    organizerRoles?: string[];
    organizerRolePositions?: Record<string, number>;
}

export class RunLifecycleError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly statusCode = 409,
        public readonly details?: { missing: { party: boolean; location: boolean } }
    ) {
        super(message);
        this.name = 'RunLifecycleError';
    }
}

const LifecycleRunSchema = z.object({
    status: z.enum(['open', 'live', 'ended']),
    finalization_kind: z.enum(['completed', 'cancelled']).nullable(),
});

/** Serialize End/Cancel with Start, then take database time in a later statement. */
async function lockRunForFinalization(client: PoolClient, runId: number, guildId: string) {
    const result = await client.query(
        `SELECT status, finalization_kind FROM run
         WHERE id = $1::bigint AND guild_id = $2::bigint FOR UPDATE`,
        [runId, guildId]
    );
    if (result.rowCount !== 1) throw new RunLifecycleError('RUN_NOT_FOUND', 'Run not found.', 404);
    return LifecycleRunSchema.parse(result.rows[0]);
}

/** Snapshot only at the first legitimate open -> live transition. */
export async function startRunWithTransaction(input: StartRunInput): Promise<void> {
    await withTransaction(async client => {
        const result = await client.query(
            `SELECT status, run_kind, activity_key, party, location, screenshot_url,
                    started_at, ended_at, organizer_minute_rate, organizer_minute_quota_role_id, finalization_kind
             FROM run WHERE id = $1::bigint AND guild_id = $2::bigint FOR UPDATE`,
            [input.runId, input.guildId]
        );
        if (result.rowCount !== 1) throw new RunLifecycleError('RUN_NOT_FOUND', 'Run not found.', 404);
        const run = LifecycleRunSchema.extend({
            run_kind: RunKindSchema,
            activity_key: z.string().min(1),
            party: z.string().nullable(),
            location: z.string().nullable(),
            screenshot_url: z.string().nullable(),
            started_at: z.union([z.date(), z.string()]).nullable(),
            ended_at: z.union([z.date(), z.string()]).nullable(),
            organizer_minute_rate: z.string().nullable(),
            organizer_minute_quota_role_id: z.string().nullable(),
        }).parse(result.rows[0]);
        if (run.status !== 'open' || run.started_at !== null || run.ended_at !== null
            || run.finalization_kind !== null || run.organizer_minute_rate !== null
            || run.organizer_minute_quota_role_id !== null) {
            throw new RunLifecycleError('INVALID_STATUS_TRANSITION', 'Only an unstarted open run can be started.');
        }
        if (!run.party || !run.location) {
            throw new RunLifecycleError('MISSING_PARTY_LOCATION', 'Party and Location must be set before starting the run.', 400,
                { missing: { party: !run.party, location: !run.location } });
        }
        if (run.run_kind === 'oryx_3' && !run.screenshot_url) {
            throw new RunLifecycleError('MISSING_SCREENSHOT', 'Screenshot must be submitted before starting Oryx 3 runs.', 400);
        }

        let rate: string | null = null;
        let quotaRoleId: string | null = null;
        if (isMinuteOrganizerQuotaRun(run)) {
            if (input.organizerRoles === undefined) {
                throw new RunLifecycleError('ORGANIZER_ROLE_CONTEXT_REQUIRED', 'Fresh original-organizer role context is required to start this run.', 400);
            }
            const resolved = await resolveMinuteQuotaRole(client, input.guildId, input.organizerRoles, input.organizerRolePositions);
            rate = resolved?.rate ?? '0.00';
            quotaRoleId = resolved?.roleId ?? null;
        }
        await client.query(
            `UPDATE run SET status = 'live', started_at = statement_timestamp(),
                            organizer_minute_rate = $3::numeric, organizer_minute_quota_role_id = $4::bigint
             WHERE id = $1::bigint AND guild_id = $2::bigint AND status = 'open'`,
            [input.runId, input.guildId, rate, quotaRoleId]
        );
    });
}

/** Cancellation deliberately performs no completion/accounting writes. */
export async function cancelRunWithTransaction(input: { runId: number; guildId: string }): Promise<void> {
    await withTransaction(async client => {
        const run = await lockRunForFinalization(client, input.runId, input.guildId);
        if (run.status === 'ended') return;
        await client.query(
            `UPDATE run SET status = 'ended', ended_at = COALESCE(ended_at, statement_timestamp()),
                            finalization_kind = 'cancelled'
             WHERE id = $1::bigint AND guild_id = $2::bigint AND status <> 'ended'`,
            [input.runId, input.guildId]
        );
    });
}

export interface EndRunResult {
    organizerQuotaPoints: number;
    raiderPointsAwarded: number;
}

export interface RecordKeyPopInput extends EndRunInput {
    expectedKeyPopCount: number;
    keyWindowSeconds: number;
}

export class Oryx3KeyPopError extends Error {
    constructor() {
        super('Oryx 3 does not use normal Dungeon Entered completion handling.');
        this.name = 'Oryx3KeyPopError';
    }
}

export interface RecordKeyPopResult {
    keyWindowEndsAt: string | Date;
    keyPopCount: number;
    organizerQuotaPoints: number;
    previousSnapshotRaidersAwarded: number;
    snapshotCount: number;
}

// ============================================================================
// RUN CREATION
// ============================================================================

/**
 * Create a new run with all related data in a single transaction.
 * 
 * This ensures atomicity - either the entire run is created (guild, member, run row)
 * or none of it is, preventing orphaned/partial data.
 * 
 * @param input - Run creation parameters
 * @returns The created run ID
 */
export async function createRunWithTransaction(input: CreateRunInput): Promise<CreateRunResult> {
    const classification = classifyRunSelection(input.selectedDungeonKeys);
    logger.debug({ guildId: input.guildId, organizerId: input.organizerId, runKind: classification.runKind },
        'Creating run with transaction');

    const runId = await withTransaction(async (client) => {
        // Step 1: Ensure guild exists (upsert)
        await client.query(
            `INSERT INTO guild (id, name) VALUES ($1::bigint, $2)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
            [input.guildId, input.guildName]
        );

        // Step 2: Ensure member exists (upsert)
        await client.query(
            `INSERT INTO member (id, username) VALUES ($1::bigint, $2)
             ON CONFLICT (id) DO UPDATE SET username = COALESCE(EXCLUDED.username, member.username)`,
            [input.organizerId, input.organizerUsername]
        );

        // Step 3: Insert run row
        const res = await client.query<{ id: string | number }>(
            `INSERT INTO run (
                guild_id, organizer_id, dungeon_key, dungeon_label, channel_id, 
                status, description, party, location, auto_end_minutes, role_id,
                run_kind, activity_key
            )
            VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, 'open', $6, $7, $8, $9, $10::bigint, $11, $12)
            RETURNING id`,
            [
                input.guildId,
                input.organizerId,
                classification.dungeonKey,
                classification.dungeonLabel,
                input.channelId,
                input.description || null,
                input.party || null,
                input.location || null,
                input.autoEndMinutes,
                input.roleId || null,
                classification.runKind,
                classification.activityKey,
            ]
        );

        const createdRunId = normalizeRunId(res.rows[0].id);
        for (const selection of classification.selectedDungeons) {
            await client.query(
                `INSERT INTO run_dungeon_selection (run_id, dungeon_key, dungeon_label, selection_order)
                 VALUES ($1::bigint, $2, $3, $4)`,
                [createdRunId, selection.dungeonKey, selection.dungeonLabel, selection.selectionOrder]
            );
        }

        return createdRunId;
    });

    logger.info({ runId, guildId: input.guildId, organizerId: input.organizerId, runKind: classification.runKind },
        'Run created successfully');

    return { runId, ...classification };
}

// ============================================================================
// KEY POPS
// ============================================================================

/** Record one normal key pop and all associated shadow/legacy writes atomically. */
export async function recordKeyPopWithTransaction(input: RecordKeyPopInput): Promise<RecordKeyPopResult | null> {
    return withTransaction(async (client) => {
        const updated = await client.query<{
            key_window_ends_at: string | Date;
            key_pop_count: number;
            occurred_at: string | Date;
            organizer_id: string;
            dungeon_key: string;
            activity_key: string;
            run_kind: RunKind;
        }>(
            `UPDATE run
             SET key_window_ends_at = now() + ($2 || ' seconds')::interval,
                 key_pop_count = key_pop_count + 1
             WHERE id = $1::bigint
               AND guild_id = $4::bigint
               AND status = 'live'
               AND key_pop_count = $3
             RETURNING key_window_ends_at, key_pop_count, now() AS occurred_at,
                       organizer_id, dungeon_key, activity_key, run_kind`,
            [input.runId, input.keyWindowSeconds, input.expectedKeyPopCount, input.guildId]
        );
        if (updated.rowCount !== 1) return null;

        const run = updated.rows[0];
        if (run.run_kind === 'oryx_3') throw new Oryx3KeyPopError();
        const baseCategory = quotaBaseCategoryForRun(run.run_kind) ?? undefined;

        const keyPopCount = run.key_pop_count;
        let previousSnapshotRaidersAwarded = 0;
        if (input.expectedKeyPopCount > 0) {
            previousSnapshotRaidersAwarded = await quotaService.awardRaidersQuotaFromSnapshot({
                guildId: input.guildId,
                dungeonKey: run.dungeon_key,
                activityKey: run.activity_key,
                baseCategory,
                runId: input.runId,
                keyPopNumber: input.expectedKeyPopCount,
            }, client);
        }

        const snapshotCount = await snapshotRaidersAtKeyPop(input.runId, keyPopCount, client);
        await recordDungeonActivity({
            guildId: input.guildId,
            userId: run.organizer_id,
            runId: input.runId,
            role: 'organizer',
            dungeonStatsKey: run.activity_key,
            subjectId: organizerKeyPopActivitySubjectId(input.runId, keyPopCount),
            source: 'key_pop',
            count: 1,
            occurredAt: z.coerce.date().parse(run.occurred_at),
        }, client);
        const organizerQuotaPoints = await quotaService.awardOrganizerQuota({
            guildId: input.guildId,
            dungeonKey: run.dungeon_key,
            activityKey: run.activity_key,
            // Realm organizer entries have no authoritative physical dungeon override.
            // Keep the raider baseCategory above unchanged.
            baseCategory: run.run_kind === 'realm_clearing' ? 'non_exalt' : baseCategory,
            runId: input.runId,
            organizerDiscordId: run.organizer_id,
            organizerRoles: input.organizerRoles,
            organizerRolePositions: input.organizerRolePositions,
            keyPopNumber: keyPopCount,
        }, client);

        return {
            keyWindowEndsAt: run.key_window_ends_at,
            keyPopCount,
            organizerQuotaPoints,
            previousSnapshotRaidersAwarded,
            snapshotCount,
        };
    });
}

// ============================================================================
// RUN ENDING
// ============================================================================

/**
 * End a run with all quota/points awards in a single transaction.
 * 
 * This ensures atomicity - either the run ends AND all points are awarded,
 * or the run stays in its current state (rollback on failure).
 * 
 * Transaction includes:
 * - Updating run status to 'ended'
 * - Logging an organizer quota event for Oryx 3
 * - Awarding raider points (from snapshot or all joined)
 * 
 * @param input - Run ending parameters
 * @returns Statistics about points awarded
 */
export async function endRunWithTransaction(input: EndRunInput): Promise<EndRunResult> {
    logger.debug({ runId: input.runId, guildId: input.guildId },
        'Ending run with transaction');

    const result = await withTransaction(async (client) => {
        const current = await lockRunForFinalization(client, input.runId, input.guildId);
        // Preserve first terminal outcome, including historical ended rows with unknown outcome.
        if (current.status === 'ended') return { organizerQuotaPoints: 0, raiderPointsAwarded: 0 };
        if (current.status !== 'live' && !input.isAutoEnd) {
            throw new RunLifecycleError('INVALID_STATUS_TRANSITION', 'Only a live run can be ended manually.');
        }
        // Step 1: Update run status to 'ended'
        const ended = await client.query<{
            ended_at: string | Date;
            organizer_id: string;
            dungeon_key: string;
            activity_key: string;
            run_kind: RunKind;
            key_pop_count: number;
        }>(
            `UPDATE run
             SET status = 'ended',
                 ended_at = COALESCE(ended_at, statement_timestamp()),
                 finalization_kind = 'completed'
             WHERE id = $1::bigint AND guild_id = $2::bigint AND status <> 'ended'
             RETURNING ended_at, organizer_id, dungeon_key, activity_key, run_kind, key_pop_count`,
            [input.runId, input.guildId]
        );
        if (ended.rowCount !== 1) throw new Error(`Run ${input.runId} was not found while ending`);
        const run = ended.rows[0];
        const baseCategory = quotaBaseCategoryForRun(run.run_kind) ?? undefined;

        // Step 2: Oryx 3 is the only dungeon whose organizer completion is
        // awarded at run end. Normal dungeons are awarded per key pop.
        let organizerQuotaPoints = 0;
        if (run.run_kind === 'oryx_3') {
            await recordDungeonActivity({
                guildId: input.guildId,
                userId: run.organizer_id,
                runId: input.runId,
                role: 'organizer',
                dungeonStatsKey: run.activity_key,
                subjectId: organizerRunActivitySubjectId(input.runId, run.activity_key),
                source: 'o3_end',
                count: 1,
                occurredAt: z.coerce.date().parse(ended.rows[0].ended_at),
            }, client);
            organizerQuotaPoints = await quotaService.awardOrganizerQuota({
                guildId: input.guildId,
                dungeonKey: run.dungeon_key,
                activityKey: run.activity_key,
                runId: input.runId,
                organizerDiscordId: run.organizer_id,
                organizerRoles: input.organizerRoles,
                organizerRolePositions: input.organizerRolePositions,
            }, client);
        }

        logger.debug({ runId: input.runId, organizerQuotaPoints, keyPopCount: run.key_pop_count },
            'Processed organizer quota award at run end');

        // Step 3: Award raider points using QuotaService
        let raiderPointsAwarded = 0;

        if (run.key_pop_count > 0) {
            // Award completions from the last key pop snapshot
            raiderPointsAwarded = await quotaService.awardRaidersQuotaFromSnapshot({
                guildId: input.guildId,
                dungeonKey: run.dungeon_key,
                activityKey: run.activity_key,
                baseCategory,
                runId: input.runId,
                keyPopNumber: run.key_pop_count,
            }, client);
            logger.debug({ runId: input.runId, keyPopCount: run.key_pop_count, raiderPointsAwarded },
                'Awarded completions from final key pop snapshot');
        } else if (!usesAggregateActivity(run.run_kind)) {
            // No Dungeon Entered events - preserve the legacy single-run participant fallback.
            raiderPointsAwarded = await quotaService.awardRaidersQuotaFromParticipants({
                guildId: input.guildId,
                dungeonKey: run.dungeon_key,
                activityKey: run.activity_key,
                runId: input.runId,
            }, client);
            logger.debug({ runId: input.runId, raiderPointsAwarded }, 
                'Awarded points to all joined raiders (no dungeon entries)');
        }

        return {
            organizerQuotaPoints,
            raiderPointsAwarded,
        };
    });

    logger.info({ 
        runId: input.runId, 
        guildId: input.guildId, 
        organizerQuotaPoints: result.organizerQuotaPoints,
        raiderPointsAwarded: result.raiderPointsAwarded,
        keyPopCount: 'persisted',
        note: 'Organizer quota processed at run end'
    }, 'Run ended successfully');

    return result;
}

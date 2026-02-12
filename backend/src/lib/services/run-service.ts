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

import { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { createLogger } from '../logging/logger.js';
import { QuotaService } from './quota-service.js';

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
    dungeonKey: string;
    dungeonLabel: string;
    description?: string;
    party?: string;
    location?: string;
    autoEndMinutes: number;
    roleId?: string;
}

export interface CreateRunResult {
    runId: number;
}

export interface EndRunInput {
    runId: number;
    guildId: string;
    organizerId: string;
    dungeonKey: string;
    keyPopCount: number;
    organizerRoles?: string[];
    organizerRolePositions?: Record<string, number>;
}

export interface EndRunResult {
    organizerQuotaPoints: number;
    raiderPointsAwarded: number;
}

// ============================================================================
// TRANSACTION HELPERS
// ============================================================================

/**
 * Execute a function within a transaction.
 * Handles BEGIN/COMMIT/ROLLBACK automatically.
 */
async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
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
    logger.debug({ guildId: input.guildId, organizerId: input.organizerId, dungeonKey: input.dungeonKey }, 
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
        const res = await client.query<{ id: number }>(
            `INSERT INTO run (
                guild_id, organizer_id, dungeon_key, dungeon_label, channel_id, 
                status, description, party, location, auto_end_minutes, role_id
            )
            VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, 'open', $6, $7, $8, $9, $10::bigint)
            RETURNING id`,
            [
                input.guildId,
                input.organizerId,
                input.dungeonKey,
                input.dungeonLabel,
                input.channelId,
                input.description || null,
                input.party || null,
                input.location || null,
                input.autoEndMinutes,
                input.roleId || null,
            ]
        );

        return res.rows[0].id;
    });

    logger.info({ runId, guildId: input.guildId, organizerId: input.organizerId, dungeonKey: input.dungeonKey }, 
        'Run created successfully');

    return { runId };
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
 * - Logging organizer quota event
 * - Awarding raider points (from snapshot or all joined)
 * 
 * @param input - Run ending parameters
 * @returns Statistics about points awarded
 */
export async function endRunWithTransaction(input: EndRunInput): Promise<EndRunResult> {
    logger.debug({ runId: input.runId, guildId: input.guildId, keyPopCount: input.keyPopCount }, 
        'Ending run with transaction');

    const result = await withTransaction(async (client) => {
        // Step 1: Update run status to 'ended'
        await client.query(
            `UPDATE run
             SET status = 'ended',
                 ended_at = COALESCE(ended_at, now())
             WHERE id = $1::bigint`,
            [input.runId]
        );

        // Step 2: Award organizer quota points at run end.
        // This shares the same run-completion write pipeline as manual /logrun.
        const organizerQuotaPoints = await quotaService.awardOrganizerQuota({
            guildId: input.guildId,
            dungeonKey: input.dungeonKey,
            runId: input.runId,
            organizerDiscordId: input.organizerId,
            organizerRoles: input.organizerRoles,
            organizerRolePositions: input.organizerRolePositions,
        }, client);

        logger.debug({ runId: input.runId, organizerQuotaPoints, keyPopCount: input.keyPopCount },
            'Processed organizer quota award at run end');

        // Step 3: Award raider points using QuotaService
        let raiderPointsAwarded = 0;

        if (input.keyPopCount > 0) {
            // Award completions from the last key pop snapshot
            raiderPointsAwarded = await quotaService.awardRaidersQuotaFromSnapshot({
                guildId: input.guildId,
                dungeonKey: input.dungeonKey,
                runId: input.runId,
                keyPopNumber: input.keyPopCount,
            }, client);
            logger.debug({ runId: input.runId, keyPopCount: input.keyPopCount, raiderPointsAwarded }, 
                'Awarded completions from final key pop snapshot');
        } else {
            // No key pops - fall back to awarding all joined raiders
            raiderPointsAwarded = await quotaService.awardRaidersQuotaFromParticipants({
                guildId: input.guildId,
                dungeonKey: input.dungeonKey,
                runId: input.runId,
            }, client);
            logger.debug({ runId: input.runId, raiderPointsAwarded }, 
                'Awarded points to all joined raiders (no key pops)');
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
        keyPopCount: input.keyPopCount,
        note: 'Organizer quota processed at run end'
    }, 'Run ended successfully');

    return result;
}

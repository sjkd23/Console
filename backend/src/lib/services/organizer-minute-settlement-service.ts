import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../database/transaction.js';
import {
    MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS,
    ORGANIZER_MINUTE_QUOTA_SQL,
    OrganizerMinuteQuotaSchema,
} from '../runs/minute-quota.js';

const SettlementRowSchema = z.object({
    run_id: z.coerce.number().int().positive().safe(),
    guild_id: z.string().regex(/^\d+$/),
    organizer_id: z.string().regex(/^\d+$/),
    run_kind: z.string().min(1),
    dungeon_label: z.string().min(1),
    quota_role_id: z.string().regex(/^\d+$/),
    rate: z.string(),
    max_minutes: z.coerce.number().int().positive().safe(),
    selected_minutes: z.coerce.number().int().positive().safe(),
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    revision: z.coerce.number().int().nonnegative().safe(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    resolved_at: z.coerce.date().nullable(),
    quota_event_id: z.coerce.number().int().positive().safe().nullable(),
    quota_points: z.string(),
    max_points: z.string(),
    quota_event_created_at: z.coerce.date().nullable(),
});

export type OrganizerMinuteSettlement = {
    runId: number;
    guildId: string;
    organizerId: string;
    runKind: string;
    runLabel: string;
    quotaRoleId: string;
    rate: number;
    maxMinutes: number;
    selectedMinutes: number;
    selectedPoints: number;
    maxPoints: number;
    status: 'pending' | 'confirmed' | 'cancelled';
    revision: number;
    createdAt: string;
    updatedAt: string;
    resolvedAt: string | null;
    quotaEventId: number | null;
    quotaEventCreatedAt: string | null;
};

export class OrganizerMinuteSettlementError extends Error {
    constructor(public readonly code: string, message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'OrganizerMinuteSettlementError';
    }
}

function mapSettlement(raw: unknown): OrganizerMinuteSettlement {
    const row = SettlementRowSchema.parse(raw);
    return {
        runId: row.run_id,
        guildId: row.guild_id,
        organizerId: row.organizer_id,
        runKind: row.run_kind,
        runLabel: row.dungeon_label,
        quotaRoleId: row.quota_role_id,
        rate: Number(row.rate),
        maxMinutes: row.max_minutes,
        selectedMinutes: row.selected_minutes,
        selectedPoints: Number(row.quota_points),
        maxPoints: Number(row.max_points),
        status: row.status,
        revision: row.revision,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        quotaEventId: row.quota_event_id,
        quotaEventCreatedAt: row.quota_event_created_at?.toISOString() ?? null,
    };
}

async function readSettlement(client: PoolClient, runId: number, guildId: string, lock = false) {
    const result = await client.query(
        `SELECT settlement.run_id::text, run.guild_id::text, run.organizer_id::text,
                run.run_kind, run.dungeon_label, settlement.quota_role_id::text,
                settlement.rate::text, settlement.max_minutes::text,
                settlement.selected_minutes::text, settlement.status,
                settlement.revision::text, settlement.created_at, settlement.updated_at,
                settlement.resolved_at, settlement.quota_event_id::text,
                (settlement.selected_minutes * settlement.rate)::text AS quota_points,
                (settlement.max_minutes * settlement.rate)::text AS max_points,
                event.created_at AS quota_event_created_at
         FROM organizer_minute_settlement settlement
         JOIN run ON run.id = settlement.run_id
         LEFT JOIN quota_event event ON event.id = settlement.quota_event_id
         WHERE settlement.run_id = $1::bigint AND run.guild_id = $2::bigint
         ${lock ? 'FOR UPDATE OF settlement' : ''}`,
        [runId, guildId]
    );
    return result.rowCount === 1 ? mapSettlement(result.rows[0]) : null;
}

/** Ensure one payable entitlement from the Phase E run basis. Caller owns the transaction. */
export async function ensureOrganizerMinuteSettlement(
    client: PoolClient,
    runId: number,
    guildId: string
): Promise<OrganizerMinuteSettlement | null> {
    const runResult = await client.query<{ organizer_minute_quota: unknown }>(
        `SELECT ${ORGANIZER_MINUTE_QUOTA_SQL} AS organizer_minute_quota
         FROM run
         WHERE id = $1::bigint AND guild_id = $3::bigint
         FOR UPDATE`,
        [runId, MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS, guildId]
    );
    if (runResult.rowCount !== 1) throw new OrganizerMinuteSettlementError('RUN_NOT_FOUND', 'Run not found.', 404);
    const basis = OrganizerMinuteQuotaSchema.parse(runResult.rows[0].organizer_minute_quota);
    if (!basis.eligible || basis.invalidReason !== null || basis.snapshottedRate === null
        || basis.snapshottedRate <= 0 || basis.quotaRoleId === null
        || basis.maxWholeMinutes === null || basis.maxWholeMinutes < 1) {
        return null;
    }
    await client.query(
        `INSERT INTO organizer_minute_settlement
             (run_id, quota_role_id, rate, max_minutes, selected_minutes)
         VALUES ($1::bigint, $2::bigint, $3::numeric, $4::bigint, $4::bigint)
         ON CONFLICT (run_id) DO NOTHING`,
        [runId, basis.quotaRoleId, basis.snapshottedRate, basis.maxWholeMinutes]
    );
    return readSettlement(client, runId, guildId);
}

async function bookSettlement(
    client: PoolClient,
    settlement: OrganizerMinuteSettlement,
    selectedMinutes: number
): Promise<OrganizerMinuteSettlement> {
    if (!Number.isSafeInteger(selectedMinutes) || selectedMinutes < 1 || selectedMinutes > settlement.maxMinutes) {
        throw new OrganizerMinuteSettlementError('INVALID_MINUTES', `Minutes must be an integer from 1 to ${settlement.maxMinutes}.`, 400);
    }
    // Coordinate with period finalization if the historical config still exists. This never reads its rate.
    await client.query(
        `SELECT 1 FROM quota_role_config
         WHERE guild_id = $1::bigint AND discord_role_id = $2::bigint FOR SHARE`,
        [settlement.guildId, settlement.quotaRoleId]
    );
    const booking = await client.query<{ booked_at: Date }>('SELECT statement_timestamp() AS booked_at');
    const subjectId = `run:${settlement.runId}:organizer_minutes`;
    const event = await client.query<{ id: string }>(
        `INSERT INTO quota_event
             (guild_id, actor_user_id, action_type, subject_id, dungeon_key,
              points, quota_points, quota_role_id, created_at)
         VALUES ($1::bigint, $2::bigint, 'organizer_minutes', $3, NULL,
                 0, $4::bigint * $5::numeric, $6::bigint, $7)
         ON CONFLICT (guild_id, subject_id)
             WHERE action_type = 'organizer_minutes' AND subject_id IS NOT NULL
         DO NOTHING
         RETURNING id::text`,
        [settlement.guildId, settlement.organizerId, subjectId, selectedMinutes,
            settlement.rate, settlement.quotaRoleId, booking.rows[0].booked_at]
    );
    if (event.rowCount !== 1) {
        throw new OrganizerMinuteSettlementError('MINUTE_EVENT_CONFLICT', 'Minute quota already has an inconsistent accounting event.', 409);
    }
    await client.query(
        `UPDATE organizer_minute_settlement
         SET selected_minutes = $2::bigint, status = 'confirmed', revision = revision + 1,
             quota_event_id = $3::bigint, resolved_at = $4, updated_at = $4
         WHERE run_id = $1::bigint`,
        [settlement.runId, selectedMinutes, event.rows[0].id, booking.rows[0].booked_at]
    );
    return (await readSettlement(client, settlement.runId, settlement.guildId))!;
}

export async function confirmOrganizerMinuteSettlement(input: {
    runId: number; guildId: string; actorId: string; expectedRevision: number;
}): Promise<OrganizerMinuteSettlement> {
    return withTransaction(async client => {
        const settlement = await readSettlement(client, input.runId, input.guildId, true);
        if (!settlement) throw new OrganizerMinuteSettlementError('SETTLEMENT_NOT_FOUND', 'Minute logging is unavailable for this run.', 404);
        if (settlement.organizerId !== input.actorId) throw new OrganizerMinuteSettlementError('NOT_ORIGINAL_ORGANIZER', 'Only the original organizer can use this prompt.', 403);
        if (settlement.status === 'confirmed') return settlement;
        if (settlement.status === 'cancelled') throw new OrganizerMinuteSettlementError('SETTLEMENT_CANCELLED', 'Minute logging was cancelled.', 409);
        if (settlement.revision !== input.expectedRevision) throw new OrganizerMinuteSettlementError('STALE_REVISION', 'Minute selection changed. Review the current amount.', 409);
        return bookSettlement(client, settlement, settlement.selectedMinutes);
    });
}

export async function modifyOrganizerMinuteSettlement(input: {
    runId: number; guildId: string; actorId: string; expectedRevision: number; selectedMinutes: number;
}): Promise<OrganizerMinuteSettlement> {
    return withTransaction(async client => {
        const settlement = await readSettlement(client, input.runId, input.guildId, true);
        if (!settlement) throw new OrganizerMinuteSettlementError('SETTLEMENT_NOT_FOUND', 'Minute logging is unavailable for this run.', 404);
        if (settlement.organizerId !== input.actorId) throw new OrganizerMinuteSettlementError('NOT_ORIGINAL_ORGANIZER', 'Only the original organizer can modify this run.', 403);
        if (settlement.status !== 'pending') throw new OrganizerMinuteSettlementError('SETTLEMENT_TERMINAL', 'Minute logging is already resolved.', 409);
        if (settlement.revision !== input.expectedRevision) throw new OrganizerMinuteSettlementError('STALE_REVISION', 'Minute selection changed. Review the current amount.', 409);
        if (!Number.isSafeInteger(input.selectedMinutes) || input.selectedMinutes < 1 || input.selectedMinutes > settlement.maxMinutes) {
            throw new OrganizerMinuteSettlementError('INVALID_MINUTES', `Minutes must be an integer from 1 to ${settlement.maxMinutes}.`, 400);
        }
        await client.query(
            `UPDATE organizer_minute_settlement
             SET selected_minutes = $2::bigint, revision = revision + 1, updated_at = statement_timestamp()
             WHERE run_id = $1::bigint`,
            [input.runId, input.selectedMinutes]
        );
        return (await readSettlement(client, input.runId, input.guildId))!;
    });
}

export async function cancelOrganizerMinuteSettlement(input: {
    runId: number; guildId: string; actorId: string;
}): Promise<OrganizerMinuteSettlement> {
    return withTransaction(async client => {
        const settlement = await readSettlement(client, input.runId, input.guildId, true);
        if (!settlement) throw new OrganizerMinuteSettlementError('SETTLEMENT_NOT_FOUND', 'Minute logging is unavailable for this run.', 404);
        if (settlement.organizerId !== input.actorId) throw new OrganizerMinuteSettlementError('NOT_ORIGINAL_ORGANIZER', 'Only the original organizer can cancel this run.', 403);
        if (settlement.status === 'cancelled') return settlement;
        if (settlement.status === 'confirmed') throw new OrganizerMinuteSettlementError('SETTLEMENT_CONFIRMED', 'Minute quota was already awarded.', 409);
        await client.query(
            `UPDATE organizer_minute_settlement
             SET status = 'cancelled', revision = revision + 1,
                 resolved_at = statement_timestamp(), updated_at = statement_timestamp()
             WHERE run_id = $1::bigint`,
            [input.runId]
        );
        return (await readSettlement(client, input.runId, input.guildId))!;
    });
}

export async function recoverOrganizerMinutes(input: {
    runId: number; guildId: string; actorId: string; selectedMinutes: number;
}): Promise<{ settlement: OrganizerMinuteSettlement; alreadyConfirmed: boolean }> {
    return withTransaction(async client => {
        let settlement = await ensureOrganizerMinuteSettlement(client, input.runId, input.guildId);
        if (!settlement) throw new OrganizerMinuteSettlementError('NOT_PAYABLE', 'This run has no payable minute basis.', 400);
        settlement = (await readSettlement(client, input.runId, input.guildId, true))!;
        if (settlement.organizerId !== input.actorId) {
            throw new OrganizerMinuteSettlementError(
                'NOT_ORIGINAL_ORGANIZER',
                'Only the original organizer can log minutes for this run.',
                403
            );
        }
        if (!Number.isSafeInteger(input.selectedMinutes)
            || input.selectedMinutes < 1
            || input.selectedMinutes > settlement.maxMinutes) {
            throw new OrganizerMinuteSettlementError(
                'INVALID_MINUTES',
                `Minutes must be an integer from 1 to ${settlement.maxMinutes}.`,
                400
            );
        }
        if (settlement.status === 'confirmed') {
            return { settlement, alreadyConfirmed: true };
        }
        if (settlement.status === 'cancelled') {
            throw new OrganizerMinuteSettlementError(
                'SETTLEMENT_CANCELLED',
                'Minute logging was cancelled and cannot be recovered with /logminutes.',
                409
            );
        }
        return {
            settlement: await bookSettlement(client, settlement, input.selectedMinutes),
            alreadyConfirmed: false,
        };
    });
}

export async function getOrganizerMinuteSettlement(input: {
    runId: number; guildId: string;
}): Promise<OrganizerMinuteSettlement | null> {
    return withTransaction(client => readSettlement(client, input.runId, input.guildId));
}

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { ActivityRoleSchema, ActivitySourceSchema } from './legacy-classification.js';
import { manualRunActivitySubjectId } from './activity-subject.js';
import { recordDungeonActivityAdjustment } from './adjustment-service.js';

const DatabaseIdSchema = z.union([
    z.string().regex(/^\d+$/),
    z.number().int().positive(),
    z.bigint().positive(),
]).transform(String);

const RecordDungeonActivitySchema = z.object({
    guildId: DatabaseIdSchema,
    userId: DatabaseIdSchema,
    runId: DatabaseIdSchema.nullable(),
    role: ActivityRoleSchema,
    dungeonStatsKey: z.string().trim().min(1),
    subjectId: z.string().trim().min(1),
    source: ActivitySourceSchema,
    count: z.number().int().positive(),
    occurredAt: z.date(),
});

export type RecordDungeonActivityInput = z.input<typeof RecordDungeonActivitySchema>;
export type RecordDungeonActivityResult = 'inserted' | 'existing';

export interface RecordManualRunActivityInput {
    guildId: string;
    userId: string;
    dungeonStatsKey: string;
    quotaSubjectId: string;
    count: number;
    occurredAt: Date;
}

export type RecordManualRunActivityResult = RecordDungeonActivityResult | 'not_meaningful';

const ExistingActivitySchema = z.object({
    user_id: DatabaseIdSchema,
    run_id: DatabaseIdSchema.nullable(),
    role: ActivityRoleSchema,
    dungeon_stats_key: z.string(),
    count: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().positive()),
});

export class DungeonActivityConflictError extends Error {
    constructor(guildId: string, subjectId: string) {
        super(`Dungeon activity subject ${guildId}/${subjectId} already exists with different semantics`);
        this.name = 'DungeonActivityConflictError';
    }
}

/**
 * Persist one canonical activity fact without consulting point configuration.
 * Duplicate logical writes are accepted only when their identity-defining
 * semantics match the existing append-only row.
 */
export async function recordDungeonActivity(
    rawInput: RecordDungeonActivityInput,
    client?: Pick<PoolClient, 'query'>
): Promise<RecordDungeonActivityResult> {
    const input = RecordDungeonActivitySchema.parse(rawInput);
    const db = client ?? pool;
    const inserted = await db.query(
        `INSERT INTO dungeon_activity_event (
             guild_id, user_id, run_id, role, dungeon_stats_key,
             subject_id, source, count, occurred_at
         )
         VALUES (
             $1::bigint,
             $2::bigint,
             (SELECT id FROM run WHERE id = $3::bigint AND guild_id = $1::bigint),
             $4, $5, $6, $7, $8, $9
         )
         ON CONFLICT (guild_id, subject_id) DO NOTHING
         RETURNING id`,
        [
            input.guildId,
            input.userId,
            input.runId,
            input.role,
            input.dungeonStatsKey,
            input.subjectId,
            input.source,
            input.count,
            input.occurredAt,
        ]
    );

    if (inserted.rowCount === 1) return 'inserted';

    const existingResult = await db.query(
        `SELECT user_id::text, run_id::text, role, dungeon_stats_key, count
         FROM dungeon_activity_event
         WHERE guild_id = $1::bigint AND subject_id = $2`,
        [input.guildId, input.subjectId]
    );
    if (existingResult.rowCount !== 1) {
        throw new Error(`Dungeon activity subject ${input.guildId}/${input.subjectId} conflicted but could not be read`);
    }

    const existing = ExistingActivitySchema.parse(existingResult.rows[0]);
    const sameRun = input.runId === null || existing.run_id === null || existing.run_id === input.runId;
    const sameSemantics = existing.user_id === input.userId
        && sameRun
        && existing.role === input.role
        && existing.dungeon_stats_key === input.dungeonStatsKey
        && existing.count === input.count;

    if (!sameSemantics) throw new DungeonActivityConflictError(input.guildId, input.subjectId);
    return 'existing';
}

/**
 * Split a manual run change by semantics. Positive values are activity facts;
 * negative values are append-only corrections. Neither path depends on points.
 */
export async function recordManualRunActivity(
    input: RecordManualRunActivityInput,
    client?: Pick<PoolClient, 'query'>
): Promise<RecordManualRunActivityResult> {
    if (!Number.isSafeInteger(input.count)) throw new Error('Manual run activity count must be an integer');
    if (input.count === 0) return 'not_meaningful';

    const subjectId = manualRunActivitySubjectId(input.quotaSubjectId);
    if (input.count < 0) {
        return recordDungeonActivityAdjustment({
            guildId: input.guildId,
            userId: input.userId,
            role: 'organizer',
            dungeonStatsKey: input.dungeonStatsKey,
            delta: input.count,
            subjectId,
            relatedActivitySubjectId: null,
            source: 'manual_log',
            occurredAt: input.occurredAt,
        }, client);
    }

    return recordDungeonActivity({
        guildId: input.guildId,
        userId: input.userId,
        runId: null,
        role: 'organizer',
        dungeonStatsKey: input.dungeonStatsKey,
        subjectId,
        source: 'manual_log',
        count: input.count,
        occurredAt: input.occurredAt,
    }, client);
}

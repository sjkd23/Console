import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { ActivityRoleSchema } from './legacy-classification.js';

const DatabaseIdSchema = z.union([
    z.string().regex(/^\d+$/),
    z.number().int().positive(),
    z.bigint().positive(),
]).transform(String);

export const ActivityAdjustmentSourceSchema = z.enum(['historical_manual_log', 'manual_log']);

const RecordActivityAdjustmentSchema = z.object({
    guildId: DatabaseIdSchema,
    userId: DatabaseIdSchema,
    role: ActivityRoleSchema,
    dungeonStatsKey: z.string().trim().min(1),
    delta: z.number().int().refine(value => value !== 0, 'Adjustment delta must not be zero'),
    subjectId: z.string().trim().min(1),
    relatedActivitySubjectId: z.string().trim().min(1).nullable().default(null),
    source: ActivityAdjustmentSourceSchema,
    occurredAt: z.date(),
});

export type RecordActivityAdjustmentInput = z.input<typeof RecordActivityAdjustmentSchema>;
export type RecordActivityAdjustmentResult = 'inserted' | 'existing';

const ExistingAdjustmentSchema = z.object({
    user_id: DatabaseIdSchema,
    role: ActivityRoleSchema,
    dungeon_stats_key: z.string(),
    delta: z.coerce.number().int(),
    related_activity_subject_id: z.string().nullable(),
});

export class DungeonActivityAdjustmentConflictError extends Error {
    constructor(guildId: string, subjectId: string) {
        super(`Dungeon activity adjustment ${guildId}/${subjectId} already exists with different semantics`);
        this.name = 'DungeonActivityAdjustmentConflictError';
    }
}

export async function recordDungeonActivityAdjustment(
    rawInput: RecordActivityAdjustmentInput,
    client?: Pick<PoolClient, 'query'>
): Promise<RecordActivityAdjustmentResult> {
    const input = RecordActivityAdjustmentSchema.parse(rawInput);
    const db = client ?? pool;
    const inserted = await db.query(
        `INSERT INTO dungeon_activity_adjustment (
             guild_id, user_id, role, dungeon_stats_key, delta, subject_id,
             related_activity_subject_id, source, occurred_at
         ) VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (guild_id, subject_id) DO NOTHING
         RETURNING id`,
        [
            input.guildId,
            input.userId,
            input.role,
            input.dungeonStatsKey,
            input.delta,
            input.subjectId,
            input.relatedActivitySubjectId,
            input.source,
            input.occurredAt,
        ]
    );
    if (inserted.rowCount === 1) return 'inserted';

    const existingResult = await db.query(
        `SELECT user_id::text, role, dungeon_stats_key, delta, related_activity_subject_id
         FROM dungeon_activity_adjustment
         WHERE guild_id = $1::bigint AND subject_id = $2`,
        [input.guildId, input.subjectId]
    );
    if (existingResult.rowCount !== 1) {
        throw new Error(`Dungeon activity adjustment ${input.guildId}/${input.subjectId} conflicted but could not be read`);
    }
    const existing = ExistingAdjustmentSchema.parse(existingResult.rows[0]);
    const sameSemantics = existing.user_id === input.userId
        && existing.role === input.role
        && existing.dungeon_stats_key === input.dungeonStatsKey
        && existing.delta === input.delta
        && existing.related_activity_subject_id === input.relatedActivitySubjectId;
    if (!sameSemantics) throw new DungeonActivityAdjustmentConflictError(input.guildId, input.subjectId);
    return 'existing';
}

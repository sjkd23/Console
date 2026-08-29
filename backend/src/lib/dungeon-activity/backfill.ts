import type { Client, QueryResultRow } from 'pg';
import { z } from 'zod';
import {
    classifyLegacyQuotaEvent,
    LegacyQuotaEventSchema,
    type LegacyExclusionReason,
} from './legacy-classification.js';
import { recordDungeonActivity } from './activity-service.js';

export type ActivityQueryClient = Pick<Client, 'query'>;

const HighWaterRowSchema = z.object({ max_id: z.union([z.string(), z.number(), z.bigint()]).transform(String) });

export interface BackfillBatchResult {
    scanned: number;
    inserted: number;
    duplicates: number;
    excluded: Record<LegacyExclusionReason, number>;
    lastEventId: string | null;
}

export async function getLegacyQuotaEventHighWaterMark(db: ActivityQueryClient): Promise<string> {
    const result = await db.query('SELECT COALESCE(MAX(id), 0)::text AS max_id FROM quota_event');
    return HighWaterRowSchema.parse(result.rows[0]).max_id;
}

function emptyExclusions(): Record<LegacyExclusionReason, number> {
    return {
        non_dungeon_action: 0,
        missing_dungeon_key: 0,
        manual_key_points_not_completion: 0,
        manual_quota_adjustment_not_activity: 0,
        manual_raider_points_adjustment_not_activity: 0,
        manual_run_reversal_not_positive_activity: 0,
        legacy_manual_run_reversal_not_positive_activity: 0,
        zero_count_manual_run_not_activity: 0,
        malformed_manual_run_subject: 0,
        malformed_automated_subject: 0,
        unknown_run_completed_subject: 0,
    };
}

export async function backfillDungeonActivityBatch(
    db: ActivityQueryClient,
    options: { afterId: string; highWaterId: string; limit: number; apply: boolean }
): Promise<BackfillBatchResult> {
    const rows = await db.query<QueryResultRow>(
        `SELECT id::text, guild_id::text, actor_user_id::text, action_type, subject_id,
                dungeon_key, points::text, quota_points::text, created_at
         FROM quota_event
         WHERE id > $1::bigint AND id <= $2::bigint
         ORDER BY quota_event.id ASC
         LIMIT $3`,
        [options.afterId, options.highWaterId, options.limit]
    );

    const result: BackfillBatchResult = {
        scanned: rows.rows.length,
        inserted: 0,
        duplicates: 0,
        excluded: emptyExclusions(),
        lastEventId: null,
    };

    for (const rawRow of rows.rows) {
        const legacy = LegacyQuotaEventSchema.parse(rawRow);
        result.lastEventId = legacy.id;
        const classification = classifyLegacyQuotaEvent(legacy);

        if (classification.kind === 'excluded') {
            result.excluded[classification.reason] += 1;
            continue;
        }

        if (!options.apply) {
            result.inserted += 1;
            continue;
        }

        const event = classification.event;
        const writeResult = await recordDungeonActivity({
            guildId: event.guildId,
            userId: event.userId,
            runId: event.runId,
            role: event.role,
            dungeonStatsKey: event.dungeonStatsKey,
            subjectId: event.subjectId,
            source: event.source,
            count: event.count,
            occurredAt: event.occurredAt,
        }, db);

        if (writeResult === 'inserted') result.inserted += 1;
        else result.duplicates += 1;
    }

    return result;
}

export function mergeBackfillResults(total: BackfillBatchResult, batch: BackfillBatchResult): BackfillBatchResult {
    total.scanned += batch.scanned;
    total.inserted += batch.inserted;
    total.duplicates += batch.duplicates;
    total.lastEventId = batch.lastEventId ?? total.lastEventId;
    for (const reason of Object.keys(total.excluded) as LegacyExclusionReason[]) {
        total.excluded[reason] += batch.excluded[reason];
    }
    return total;
}

export function createEmptyBackfillResult(): BackfillBatchResult {
    return { scanned: 0, inserted: 0, duplicates: 0, excluded: emptyExclusions(), lastEventId: null };
}

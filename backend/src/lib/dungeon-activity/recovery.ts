import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import type { ActivityQueryClient } from './backfill.js';
import { recordDungeonActivity } from './activity-service.js';
import { recordDungeonActivityAdjustment } from './adjustment-service.js';
import {
    ambiguousHistoricalActivitySubjectId,
    manualRunActivitySubjectId,
    organizerKeyPopActivitySubjectId,
    organizerRunActivitySubjectId,
    raiderKeyPopActivitySubjectId,
} from './activity-subject.js';

const IdSchema = z.union([z.string(), z.number(), z.bigint()]).transform(String);
const DateSchema = z.coerce.date();

const CorrectionCandidateSchema = z.object({
    event_id: IdSchema,
    guild_id: IdSchema,
    user_id: IdSchema,
    dungeon_stats_key: z.string().trim().min(1),
    quota_subject_id: z.string().nullable(),
    delta: z.coerce.number().int().negative(),
    occurred_at: DateSchema,
});

export interface HistoricalCorrectionReport {
    total_candidates: number;
    net_delta: number;
    inserted: number;
    existing: number;
}

export async function recoverHistoricalActivityCorrections(
    db: ActivityQueryClient,
    apply: boolean
): Promise<HistoricalCorrectionReport> {
    const result = await db.query<QueryResultRow>(
        `SELECT id::text AS event_id, guild_id::text, actor_user_id::text AS user_id,
                dungeon_key AS dungeon_stats_key, subject_id AS quota_subject_id,
                CASE
                    WHEN subject_id ~ '^manual_log_run:[0-9]+:[0-9]+:[0-9]+$'
                    THEN -split_part(subject_id, ':', 4)::int
                    ELSE -1
                END AS delta,
                created_at AS occurred_at
         FROM quota_event
         WHERE action_type = 'run_completed'
           AND dungeon_key IS NOT NULL
           AND BTRIM(dungeon_key) <> ''
           AND quota_points < 0
           AND (
               subject_id IS NULL
               OR subject_id ~ '^manual_log_run:[0-9]+:[0-9]+:[0-9]+$'
           )
         ORDER BY id`
    );

    const report: HistoricalCorrectionReport = {
        total_candidates: result.rows.length,
        net_delta: 0,
        inserted: 0,
        existing: 0,
    };
    for (const raw of result.rows) {
        const candidate = CorrectionCandidateSchema.parse(raw);
        report.net_delta += candidate.delta;
        if (!apply) continue;
        const adjustmentSubjectId = candidate.quota_subject_id
            ? manualRunActivitySubjectId(candidate.quota_subject_id)
            : ambiguousHistoricalActivitySubjectId(candidate.event_id, 'organizer');
        const write = await recordDungeonActivityAdjustment({
            guildId: candidate.guild_id,
            userId: candidate.user_id,
            role: 'organizer',
            dungeonStatsKey: candidate.dungeon_stats_key,
            delta: candidate.delta,
            subjectId: adjustmentSubjectId,
            relatedActivitySubjectId: null,
            source: 'historical_manual_log',
            occurredAt: candidate.occurred_at,
        }, db);
        report[write] += 1;
    }
    return report;
}

type RecoveryClass = 'organizer_key_pop' | 'o3_organizer' | 'snapshot_raider' | 'participant_raider';
type RecoveryDecision = 'proven' | 'ambiguous' | 'unrecoverable';

const RecoveryCandidateSchema = z.object({
    candidate_class: z.enum(['organizer_key_pop', 'o3_organizer', 'snapshot_raider', 'participant_raider']),
    guild_id: IdSchema,
    user_id: IdSchema,
    run_id: IdSchema,
    dungeon_stats_key: z.string().trim().min(1),
    key_pop_number: z.coerce.number().int().positive().nullable(),
    occurred_at: DateSchema.nullable(),
    decision: z.enum(['proven', 'ambiguous', 'unrecoverable']),
    proof: z.string().min(1),
});

interface RecoveryBucket {
    total_candidates: number;
    proven: number;
    ambiguous: number;
    unrecoverable: number;
    inserted: number;
    existing: number;
}

export interface HistoricalZeroPointRecoveryReport {
    organizer_key_pop: RecoveryBucket;
    o3_organizer: RecoveryBucket;
    snapshot_raider: RecoveryBucket;
    participant_raider: RecoveryBucket;
}

function emptyBucket(): RecoveryBucket {
    return { total_candidates: 0, proven: 0, ambiguous: 0, unrecoverable: 0, inserted: 0, existing: 0 };
}

function subjectFor(candidate: z.infer<typeof RecoveryCandidateSchema>): string {
    if (candidate.candidate_class === 'organizer_key_pop') {
        return organizerKeyPopActivitySubjectId(candidate.run_id, candidate.key_pop_number!);
    }
    if (candidate.candidate_class === 'o3_organizer') {
        return organizerRunActivitySubjectId(candidate.run_id, 'ORYX_3');
    }
    if (candidate.candidate_class === 'snapshot_raider') {
        return raiderKeyPopActivitySubjectId(candidate.run_id, candidate.key_pop_number!, candidate.user_id);
    }
    throw new Error('Participant-only candidates intentionally have no recoverable canonical identity');
}

export async function recoverHistoricalZeroPointActivity(
    db: ActivityQueryClient,
    apply: boolean,
    guildId?: string
): Promise<HistoricalZeroPointRecoveryReport> {
    const result = await db.query<QueryResultRow>(
        `WITH organizer_key_pop AS (
             SELECT 'organizer_key_pop'::text AS candidate_class,
                    run.guild_id, run.organizer_id AS user_id, run.id AS run_id,
                    run.dungeon_key AS dungeon_stats_key, pop.number AS key_pop_number,
                    COALESCE(MIN(snapshot.snapshot_time), run.ended_at) AS occurred_at,
                    CASE
                        WHEN run.organizer_id IS NOT NULL AND run.status = 'ended' AND run.ended_at IS NOT NULL
                        THEN 'proven' ELSE 'ambiguous'
                    END AS decision,
                    'run.key_pop_count proves the numbered pop; ended run and organizer identity are durable'::text AS proof
             FROM run
             CROSS JOIN LATERAL generate_series(1, run.key_pop_count) AS pop(number)
             LEFT JOIN key_pop_snapshot AS snapshot
               ON snapshot.run_id = run.id AND snapshot.key_pop_number = pop.number
             WHERE run.dungeon_key <> 'ORYX_3'
               AND run.status = 'ended'
               AND ($1::bigint IS NULL OR run.guild_id = $1::bigint)
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'run:' || run.id || ':keypop:' || pop.number
               )
             GROUP BY run.id, pop.number
         ), o3_organizer AS (
             SELECT 'o3_organizer'::text AS candidate_class,
                    run.guild_id, run.organizer_id AS user_id, run.id AS run_id,
                    run.dungeon_key AS dungeon_stats_key, NULL::integer AS key_pop_number,
                    run.ended_at AS occurred_at,
                    CASE WHEN run.organizer_id IS NOT NULL AND run.ended_at IS NOT NULL
                         THEN 'proven' ELSE 'ambiguous' END AS decision,
                    'ended ORYX_3 state is the persisted state that triggers the current organizer award'::text AS proof
             FROM run
             WHERE run.dungeon_key = 'ORYX_3'
               AND run.status = 'ended'
               AND ($1::bigint IS NULL OR run.guild_id = $1::bigint)
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id AND event.subject_id = 'run:' || run.id
               )
         ), snapshot_raider AS (
             SELECT 'snapshot_raider'::text AS candidate_class,
                    run.guild_id, snapshot.user_id, run.id AS run_id,
                    run.dungeon_key AS dungeon_stats_key,
                    snapshot.key_pop_number, snapshot.snapshot_time AS occurred_at,
                    CASE
                        WHEN snapshot.key_pop_number <= run.key_pop_count
                         AND (snapshot.key_pop_number < run.key_pop_count
                              OR (run.status = 'ended' AND run.ended_at IS NOT NULL))
                        THEN 'proven' ELSE 'ambiguous'
                    END AS decision,
                    'snapshot proves eligibility and a later pop or ended run proves finalization; zero-point legacy code left awarded_completion false'::text AS proof
             FROM key_pop_snapshot AS snapshot
             JOIN run ON run.id = snapshot.run_id
             WHERE (snapshot.key_pop_number < run.key_pop_count OR run.status = 'ended')
               AND ($1::bigint IS NULL OR run.guild_id = $1::bigint)
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'raider:' || run.id || ':'
                         || snapshot.key_pop_number || ':' || snapshot.user_id
               )
         ), participant_raider AS (
             SELECT DISTINCT 'participant_raider'::text AS candidate_class,
                    run.guild_id, reaction.user_id, run.id AS run_id,
                    run.dungeon_key AS dungeon_stats_key, NULL::integer AS key_pop_number,
                    run.ended_at AS occurred_at, 'unrecoverable'::text AS decision,
                    'a final join reaction proves presence, not completion eligibility'::text AS proof
             FROM reaction
             JOIN run ON run.id = reaction.run_id
             WHERE run.status = 'ended'
               AND run.key_pop_count = 0
               AND reaction.state = 'join'
               AND ($1::bigint IS NULL OR run.guild_id = $1::bigint)
               AND NOT EXISTS (
                   SELECT 1 FROM quota_event AS event
                   WHERE event.guild_id = run.guild_id
                     AND event.subject_id = 'raider:' || run.id || ':' || reaction.user_id
               )
         )
         SELECT * FROM organizer_key_pop
         UNION ALL SELECT * FROM o3_organizer
         UNION ALL SELECT * FROM snapshot_raider
         UNION ALL SELECT * FROM participant_raider
         ORDER BY candidate_class, run_id, key_pop_number, user_id`,
        [guildId ?? null]
    );

    const report: HistoricalZeroPointRecoveryReport = {
        organizer_key_pop: emptyBucket(),
        o3_organizer: emptyBucket(),
        snapshot_raider: emptyBucket(),
        participant_raider: emptyBucket(),
    };

    for (const raw of result.rows) {
        const candidate = RecoveryCandidateSchema.parse(raw);
        const bucket = report[candidate.candidate_class as RecoveryClass];
        bucket.total_candidates += 1;
        bucket[candidate.decision as RecoveryDecision] += 1;
        if (!apply || candidate.decision !== 'proven' || candidate.occurred_at === null) continue;

        const write = await recordDungeonActivity({
            guildId: candidate.guild_id,
            userId: candidate.user_id,
            runId: candidate.run_id,
            role: candidate.candidate_class === 'snapshot_raider' ? 'raider' : 'organizer',
            dungeonStatsKey: candidate.dungeon_stats_key,
            subjectId: subjectFor(candidate),
            source: candidate.candidate_class === 'snapshot_raider' ? 'historical_snapshot' : 'historical_run',
            count: 1,
            occurredAt: candidate.occurred_at,
        }, db);
        bucket[write] += 1;
    }

    return report;
}

import { z } from 'zod';
import {
    ambiguousHistoricalActivitySubjectId,
    manualRunActivitySubjectId,
    organizerKeyPopActivitySubjectId,
    organizerRunActivitySubjectId,
    raiderKeyPopActivitySubjectId,
    raiderParticipantActivitySubjectId,
} from './activity-subject.js';

export const ActivityRoleSchema = z.enum(['organizer', 'raider']);
export type ActivityRole = z.infer<typeof ActivityRoleSchema>;

export const ActivitySourceSchema = z.enum([
    'historical_quota_event',
    'historical_run',
    'historical_snapshot',
    'key_pop',
    'o3_end',
    'participant_fallback',
    'manual_log',
]);
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;

const DatabaseIdSchema = z.union([z.string(), z.number(), z.bigint()]).transform(value => String(value));
const DatabaseNumberSchema = z.union([z.string(), z.number()]).transform((value, context) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a finite database number' });
        return z.NEVER;
    }
    return parsed;
});

export const LegacyQuotaEventSchema = z.object({
    id: DatabaseIdSchema,
    guild_id: DatabaseIdSchema,
    actor_user_id: DatabaseIdSchema,
    action_type: z.string(),
    subject_id: z.string().nullable(),
    dungeon_key: z.string().nullable(),
    points: DatabaseNumberSchema,
    quota_points: DatabaseNumberSchema,
    created_at: z.coerce.date(),
});
export type LegacyQuotaEvent = z.infer<typeof LegacyQuotaEventSchema>;

export const DungeonActivityAggregateSchema = z.object({
    guild_id: DatabaseIdSchema,
    user_id: DatabaseIdSchema,
    role: ActivityRoleSchema,
    dungeon_stats_key: z.string().min(1),
    count: DatabaseNumberSchema.pipe(z.number().int()),
});
export type DungeonActivityAggregate = z.infer<typeof DungeonActivityAggregateSchema>;

export type LegacyExclusionReason =
    | 'non_dungeon_action'
    | 'missing_dungeon_key'
    | 'manual_key_points_not_completion'
    | 'manual_quota_adjustment_not_activity'
    | 'manual_raider_points_adjustment_not_activity'
    | 'manual_run_reversal_not_positive_activity'
    | 'legacy_manual_run_reversal_not_positive_activity'
    | 'zero_count_manual_run_not_activity'
    | 'malformed_manual_run_subject'
    | 'malformed_automated_subject'
    | 'unknown_run_completed_subject';

export interface ClassifiedActivity {
    kind: 'activity';
    event: {
        guildId: string;
        userId: string;
        runId: string | null;
        role: ActivityRole;
        dungeonStatsKey: string;
        subjectId: string;
        source: 'historical_quota_event';
        count: number;
        occurredAt: Date;
    };
    family:
        | 'automated_organizer_run'
        | 'automated_organizer_key_pop'
        | 'automated_raider_run'
        | 'automated_raider_key_pop'
        | 'manual_run'
        | 'legacy_manual_run';
}

export interface ExcludedLegacyEvent {
    kind: 'excluded';
    reason: LegacyExclusionReason;
}

export type LegacyEventClassification = ClassifiedActivity | ExcludedLegacyEvent;

const OrganizerRunSubject = /^run:(\d+)$/;
const OrganizerKeyPopSubject = /^run:(\d+):keypop:(\d+)$/;
const RaiderRunSubject = /^raider:(\d+):(\d+)$/;
const RaiderKeyPopSubject = /^raider:(\d+):(\d+):(\d+)$/;
const ManualRunSubject = /^manual_log_run:(\d+):(\d+):(\d+)$/;

function activity(
    legacy: LegacyQuotaEvent,
    role: ActivityRole,
    runId: string | null,
    count: number,
    family: ClassifiedActivity['family'],
    subjectId: string
): ClassifiedActivity {
    return {
        kind: 'activity',
        family,
        event: {
            guildId: legacy.guild_id,
            userId: legacy.actor_user_id,
            runId,
            role,
            dungeonStatsKey: legacy.dungeon_key!,
            subjectId,
            source: 'historical_quota_event',
            count,
            occurredAt: legacy.created_at,
        },
    };
}

/**
 * Classify a legacy quota row by the semantics of its writer, never merely by
 * which points column happens to be non-zero.
 */
export function classifyLegacyQuotaEvent(legacy: LegacyQuotaEvent): LegacyEventClassification {
    if (legacy.action_type !== 'run_completed') {
        return { kind: 'excluded', reason: 'non_dungeon_action' };
    }

    const subject = legacy.subject_id;

    if (subject?.startsWith('manual_adjust_points:')) {
        return { kind: 'excluded', reason: 'manual_raider_points_adjustment_not_activity' };
    }
    if (subject?.startsWith('manual_adjust:')) {
        return { kind: 'excluded', reason: 'manual_quota_adjustment_not_activity' };
    }
    if (subject?.startsWith('key_pop:')) {
        return { kind: 'excluded', reason: 'manual_key_points_not_completion' };
    }

    if (!legacy.dungeon_key || legacy.dungeon_key.trim() === '') {
        return { kind: 'excluded', reason: 'missing_dungeon_key' };
    }

    if (subject === null) {
        // Git history proves this was the original /quota/log-run representation:
        // one row per manually added/removed run before manual_log_run IDs existed.
        return legacy.quota_points > 0
            ? activity(
                legacy,
                'organizer',
                null,
                1,
                'legacy_manual_run',
                ambiguousHistoricalActivitySubjectId(legacy.id, 'organizer')
            )
            : { kind: 'excluded', reason: 'legacy_manual_run_reversal_not_positive_activity' };
    }

    const manualRun = ManualRunSubject.exec(subject);
    if (manualRun) {
        const [, , subjectUserId, encodedCount] = manualRun;
        const count = Number(encodedCount);
        if (subjectUserId !== legacy.actor_user_id || !Number.isSafeInteger(count)) {
            return { kind: 'excluded', reason: 'malformed_manual_run_subject' };
        }
        if (count <= 0) return { kind: 'excluded', reason: 'zero_count_manual_run_not_activity' };
        return legacy.quota_points < 0
            ? { kind: 'excluded', reason: 'manual_run_reversal_not_positive_activity' }
            : activity(
                legacy,
                'organizer',
                null,
                count,
                'manual_run',
                manualRunActivitySubjectId(subject)
            );
    }
    if (subject.startsWith('manual_log_run:')) {
        return { kind: 'excluded', reason: 'malformed_manual_run_subject' };
    }

    const organizerKeyPop = OrganizerKeyPopSubject.exec(subject);
    if (organizerKeyPop) {
        return activity(
            legacy,
            'organizer',
            organizerKeyPop[1],
            1,
            'automated_organizer_key_pop',
            organizerKeyPopActivitySubjectId(organizerKeyPop[1], Number(organizerKeyPop[2]))
        );
    }

    const organizerRun = OrganizerRunSubject.exec(subject);
    if (organizerRun) {
        return activity(
            legacy,
            'organizer',
            organizerRun[1],
            1,
            'automated_organizer_run',
            organizerRunActivitySubjectId(organizerRun[1], legacy.dungeon_key)
        );
    }

    const raiderKeyPop = RaiderKeyPopSubject.exec(subject);
    if (raiderKeyPop) {
        if (raiderKeyPop[3] !== legacy.actor_user_id) {
            return { kind: 'excluded', reason: 'malformed_automated_subject' };
        }
        return activity(
            legacy,
            'raider',
            raiderKeyPop[1],
            1,
            'automated_raider_key_pop',
            raiderKeyPopActivitySubjectId(raiderKeyPop[1], Number(raiderKeyPop[2]), legacy.actor_user_id)
        );
    }

    const raiderRun = RaiderRunSubject.exec(subject);
    if (raiderRun) {
        if (raiderRun[2] !== legacy.actor_user_id) {
            return { kind: 'excluded', reason: 'malformed_automated_subject' };
        }
        return activity(
            legacy,
            'raider',
            raiderRun[1],
            1,
            'automated_raider_run',
            raiderParticipantActivitySubjectId(raiderRun[1], legacy.actor_user_id)
        );
    }

    if (subject.startsWith('run:') || subject.startsWith('raider:')) {
        return { kind: 'excluded', reason: 'malformed_automated_subject' };
    }

    return { kind: 'excluded', reason: 'unknown_run_completed_subject' };
}

export interface LegacyStatsContribution {
    role: ActivityRole;
    count: number;
}

/** Reproduces the count portion of the current /stats SQL, including its quirks. */
export function getLegacyStatsContributions(legacy: LegacyQuotaEvent): LegacyStatsContribution[] {
    if (legacy.action_type !== 'run_completed') return [];

    let multiplier = 1;
    if (legacy.subject_id?.startsWith('manual_log_run:')) {
        const match = ManualRunSubject.exec(legacy.subject_id);
        if (!match) return [];
        multiplier = Number(match[3]);
        if (!Number.isSafeInteger(multiplier) || multiplier <= 0) return [];
    }

    const contributions: LegacyStatsContribution[] = [];
    if (legacy.points !== 0) {
        contributions.push({ role: 'raider', count: multiplier * Math.sign(legacy.points) });
    }
    if (legacy.quota_points !== 0) {
        contributions.push({ role: 'organizer', count: multiplier * Math.sign(legacy.quota_points) });
    }
    return contributions;
}

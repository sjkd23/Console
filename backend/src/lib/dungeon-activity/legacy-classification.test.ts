import { describe, expect, it } from 'vitest';
import {
    classifyLegacyQuotaEvent,
    LegacyQuotaEventSchema,
    type LegacyQuotaEvent,
} from './legacy-classification.js';
import { compareDungeonActivityParity } from './parity.js';

function legacy(overrides: Partial<LegacyQuotaEvent> = {}): LegacyQuotaEvent {
    return LegacyQuotaEventSchema.parse({
        id: '1',
        guild_id: '1437327222863040614',
        actor_user_id: '218823980524634112',
        action_type: 'run_completed',
        subject_id: 'run:10:keypop:1',
        dungeon_key: 'NEST',
        points: '0',
        quota_points: '1',
        created_at: '2026-01-02T03:04:05.000Z',
        ...overrides,
    });
}

describe('legacy dungeon activity classification', () => {
    it('classifies automated organizer, raider, and Oryx 3 events by subject semantics', () => {
        const organizer = classifyLegacyQuotaEvent(legacy());
        const raider = classifyLegacyQuotaEvent(legacy({
            id: '2',
            actor_user_id: '333333333333333333',
            subject_id: 'raider:10:1:333333333333333333',
            points: 2,
            quota_points: 0,
        }));
        const o3 = classifyLegacyQuotaEvent(legacy({
            id: '3',
            subject_id: 'run:11',
            dungeon_key: 'ORYX_3',
        }));

        expect(organizer).toMatchObject({ kind: 'activity', family: 'automated_organizer_key_pop' });
        expect(organizer).toMatchObject({ event: { subjectId: 'run:10:keypop:1:organizer' } });
        expect(raider).toMatchObject({
            kind: 'activity',
            family: 'automated_raider_key_pop',
            event: { subjectId: 'run:10:keypop:1:raider:333333333333333333' },
        });
        expect(o3).toMatchObject({
            kind: 'activity',
            family: 'automated_organizer_run',
            event: { dungeonStatsKey: 'ORYX_3', count: 1, subjectId: 'run:11:o3:organizer' },
        });
    });

    it('stores a positive manual_log_run as one aggregate activity row', () => {
        const result = classifyLegacyQuotaEvent(legacy({
            subject_id: 'manual_log_run:1700000000000:218823980524634112:5',
            quota_points: 10,
        }));
        expect(result).toMatchObject({
            kind: 'activity',
            family: 'manual_run',
            event: { role: 'organizer', count: 5, runId: null },
        });
        expect(classifyLegacyQuotaEvent(legacy({
            subject_id: 'manual_log_run:1700000000000:218823980524634112:0',
            quota_points: 0,
        }))).toEqual({ kind: 'excluded', reason: 'zero_count_manual_run_not_activity' });
    });

    it('recognizes the historical null-subject manual-run writer and excludes reversals', () => {
        expect(classifyLegacyQuotaEvent(legacy({ subject_id: null, quota_points: 1 }))).toMatchObject({
            kind: 'activity',
            family: 'legacy_manual_run',
            event: { count: 1 },
        });
        expect(classifyLegacyQuotaEvent(legacy({ subject_id: null, quota_points: -1 }))).toEqual({
            kind: 'excluded',
            reason: 'legacy_manual_run_reversal_not_positive_activity',
        });
    });

    it('excludes point corrections and manual key-point records from activity', () => {
        expect(classifyLegacyQuotaEvent(legacy({ subject_id: 'manual_adjust:1:218823980524634112' }))).toEqual({
            kind: 'excluded',
            reason: 'manual_quota_adjustment_not_activity',
        });
        expect(classifyLegacyQuotaEvent(legacy({ subject_id: 'manual_adjust_points:1:218823980524634112' }))).toEqual({
            kind: 'excluded',
            reason: 'manual_raider_points_adjustment_not_activity',
        });
        expect(classifyLegacyQuotaEvent(legacy({ subject_id: 'key_pop:1:218823980524634112:3' }))).toEqual({
            kind: 'excluded',
            reason: 'manual_key_points_not_completion',
        });
        expect(classifyLegacyQuotaEvent(legacy({
            subject_id: 'key_pop:run:42:123456789012345678:1',
            dungeon_key: 'NEST',
            points: 5,
        }))).toEqual({
            kind: 'excluded',
            reason: 'manual_key_points_not_completion',
        });
    });
});

describe('dungeon activity parity', () => {
    it('reports known legacy quirks as explained and missing backfill rows as unexpected', () => {
        const zeroPointOrganic = legacy({ id: '10', quota_points: 0 });
        const manualAdjustment = legacy({
            id: '11',
            subject_id: 'manual_adjust:1:218823980524634112',
            dungeon_key: null,
            quota_points: 4,
        });
        const manualKeyPoints = legacy({
            id: '12',
            subject_id: 'key_pop:1:218823980524634112:3',
            points: 6,
            quota_points: 0,
        });
        const organic = legacy({ id: '13', subject_id: 'run:13', dungeon_key: 'FUNGAL_CAVERN' });

        const report = compareDungeonActivityParity(
            [zeroPointOrganic, manualAdjustment, manualKeyPoints, organic],
            [{
                guild_id: zeroPointOrganic.guild_id,
                user_id: zeroPointOrganic.actor_user_id,
                role: 'organizer',
                dungeon_stats_key: 'NEST',
                count: '1',
            }]
        );

        expect(report.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'organizer',
                dungeon_stats_key: 'NEST',
                legacy_count: 0,
                activity_count: 1,
                status: 'explained_mismatch',
                reasons: ['canonical_activity_has_zero_legacy_points'],
            }),
            expect.objectContaining({
                role: 'organizer',
                dungeon_stats_key: null,
                status: 'explained_mismatch',
                reasons: ['manual_quota_adjustment_not_activity'],
            }),
            expect.objectContaining({
                role: 'raider',
                dungeon_stats_key: 'NEST',
                status: 'explained_mismatch',
                reasons: ['manual_key_points_not_completion'],
            }),
            expect.objectContaining({
                dungeon_stats_key: 'FUNGAL_CAVERN',
                status: 'unexpected_mismatch',
                reasons: ['backfill_missing_or_extra_activity'],
            }),
        ]));
        expect(report.summary).toMatchObject({ explained_mismatches: 3, unexpected_mismatches: 1 });
    });
});

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DecimalPointsSchema } from '../quota/decimal-points.js';
import type { RunKind } from './run-taxonomy.js';
import { DUNGEONS } from '../../config/raid-config.js';

// Shared with the SQL projection as a bound parameter; never infer from labels or unknown codes.
export const MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS = DUNGEONS
    .filter(dungeon => dungeon.selectionClass === 'non_exalt')
    .map(dungeon => dungeon.code);

export function isMinuteOrganizerQuotaRun(run: { run_kind: RunKind; activity_key: string }): boolean {
    return run.run_kind === 'realm_clearing' || run.run_kind === 'multi_non_exalt'
        || (run.run_kind === 'single' && MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS.includes(run.activity_key));
}

const MinuteRoleSchema = z.object({
    role_id: z.string().regex(/^\d+$/),
    rate: z.string().refine(value => DecimalPointsSchema.safeParse(value).success),
});

/** Only the original organizer's supplied roles are candidates, including zero-rate roles. */
export async function resolveMinuteQuotaRole(
    client: PoolClient,
    guildId: string,
    organizerRoles: readonly string[],
    rolePositions: Readonly<Record<string, number>> = {}
): Promise<{ roleId: string; rate: string } | null> {
    const result = await client.query(
        `SELECT discord_role_id::text AS role_id, misc_points_per_minute::text AS rate
         FROM quota_role_config
         WHERE guild_id = $1::bigint AND discord_role_id = ANY($2::bigint[])
         ORDER BY discord_role_id
         FOR SHARE`,
        [guildId, organizerRoles]
    );
    const candidates = z.array(MinuteRoleSchema).parse(result.rows);
    candidates.sort((a, b) => {
        const rateOrder = Number(b.rate) - Number(a.rate);
        if (rateOrder !== 0) return rateOrder;
        const positionOrder = (rolePositions[b.role_id] ?? 0) - (rolePositions[a.role_id] ?? 0);
        if (positionOrder !== 0) return positionOrder;
        return BigInt(a.role_id) < BigInt(b.role_id) ? -1 : BigInt(a.role_id) > BigInt(b.role_id) ? 1 : 0;
    });
    const winner = candidates[0];
    return winner ? { roleId: winner.role_id, rate: winner.rate } : null;
}

export const OrganizerMinuteQuotaSchema = z.object({
    // Eligible describes the completed basis, not a pending settlement. Zero can be eligible.
    eligible: z.boolean(),
    snapshottedRate: DecimalPointsSchema.nullable(),
    quotaRoleId: z.string().regex(/^\d+$/).nullable(),
    maxWholeMinutes: z.number().int().nonnegative().safe().nullable(),
    maxPoints: DecimalPointsSchema.nullable(),
    invalidReason: z.enum(['invalid_timestamps', 'out_of_range']).nullable(),
});

export type OrganizerMinuteQuota = z.infer<typeof OrganizerMinuteQuotaSchema>;

/**
 * Correlated projection for a `run` row. Keep timestamp subtraction and numeric multiplication
 * here so GET and future settlement transactions use the same definition and database snapshot.
 * Numeric epoch subtraction preserves microseconds even when a timestamp interval would overflow.
 * Never substitute now()/created_at or infer completion from entries/Discord state.
 * Bind MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS at $2 in the enclosing query.
 */
export const ORGANIZER_MINUTE_QUOTA_SQL = `(
    WITH basis AS (
        SELECT (run.run_kind IN ('realm_clearing', 'multi_non_exalt')
                   OR (run.run_kind = 'single' AND run.activity_key = ANY($2::text[]))) AS minute_mode,
               run.status = 'ended' AND run.finalization_kind = 'completed'
                   AND run.organizer_minute_rate IS NOT NULL AS completed_basis,
               run.started_at IS NOT NULL AND run.ended_at IS NOT NULL AS has_times,
               isfinite(run.started_at) AND isfinite(run.ended_at)
                   AND run.ended_at >= run.started_at AS valid_times
    ), duration AS (
        SELECT *, CASE WHEN minute_mode AND completed_basis AND has_times AND valid_times
                       THEN floor((extract(epoch FROM run.ended_at) - extract(epoch FROM run.started_at)) / 60)
                       ELSE NULL END AS whole_minutes
        FROM basis
    ), amount AS (
        SELECT *, whole_minutes * run.organizer_minute_rate AS points FROM duration
    ), checked AS (
        SELECT *, CASE
            WHEN minute_mode AND completed_basis AND has_times AND NOT valid_times
                THEN 'invalid_timestamps'
            WHEN whole_minutes > 9007199254740991 OR points > 99999999.99
                THEN 'out_of_range'
            ELSE NULL END AS invalid_reason
        FROM amount
    )
    SELECT jsonb_build_object(
        'eligible', COALESCE(minute_mode AND completed_basis AND has_times AND valid_times
                    AND run.organizer_minute_quota_role_id IS NOT NULL AND invalid_reason IS NULL, FALSE),
        'snapshottedRate', CASE WHEN minute_mode THEN run.organizer_minute_rate ELSE NULL END,
        'quotaRoleId', CASE WHEN minute_mode THEN run.organizer_minute_quota_role_id::text ELSE NULL END,
        'maxWholeMinutes', CASE WHEN invalid_reason IS NULL THEN whole_minutes ELSE NULL END,
        'maxPoints', CASE WHEN invalid_reason IS NULL THEN points ELSE NULL END,
        'invalidReason', invalid_reason
    ) FROM checked
)`;

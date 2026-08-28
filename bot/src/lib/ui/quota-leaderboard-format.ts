import { formatPoints } from '../utilities/format-helpers.js';

export interface QuotaLeaderboardPresentation {
    progress: string;
    metQuota: boolean;
}

/**
 * Present combined quota progress without exposing internal accounting language.
 * Ranking is handled independently by the backend using earned_points only.
 */
export function getQuotaLeaderboardPresentation(
    effectiveTotal: number,
    carryIn: number,
    requiredPoints: number
): QuotaLeaderboardPresentation {
    return {
        progress: carryIn > 0
            ? `${formatPoints(effectiveTotal)} (${formatPoints(carryIn)} rollover)`
            : formatPoints(effectiveTotal),
        metQuota: effectiveTotal >= requiredPoints,
    };
}

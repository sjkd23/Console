export interface CalculatedQuotaResult {
    effectiveTotal: number;
    metQuota: boolean;
    carryOut: number;
}

/** Pure period accounting. Carry never becomes earned activity. */
export function calculateQuotaResult(
    earnedPoints: number,
    carryIn: number,
    requiredPoints: number,
    rolloverEnabled: boolean
): CalculatedQuotaResult {
    const effectiveTotal = earnedPoints + carryIn;
    const carryOut = rolloverEnabled
        ? Math.min(Math.max(effectiveTotal - requiredPoints, 0), requiredPoints)
        : 0;

    return {
        effectiveTotal,
        metQuota: effectiveTotal >= requiredPoints,
        carryOut,
    };
}

export function isWithinHalfOpenPeriod(timestamp: Date, startsAt: Date, endsAt: Date): boolean {
    return timestamp >= startsAt && timestamp < endsAt;
}

export function nextQuotaBoundary(startsAt: Date, resetIntervalDays: number): Date {
    return new Date(startsAt.getTime() + resetIntervalDays * 86_400_000);
}

export function isLatestReachedBoundary(endsAt: Date, resetIntervalDays: number, now: Date): boolean {
    return nextQuotaBoundary(endsAt, resetIntervalDays) > now;
}

export function getLegacyQuotaTransitionWindow(
    legacyStartsAt: Date,
    legacyResetAt: Date,
    transitionTime: Date,
    resetIntervalDays: number
): { startsAt: Date; endsAt: Date } {
    if (legacyStartsAt < legacyResetAt && legacyResetAt > transitionTime) {
        return { startsAt: legacyStartsAt, endsAt: legacyResetAt };
    }

    if (legacyResetAt <= transitionTime) {
        return {
            startsAt: legacyResetAt,
            endsAt: nextQuotaBoundary(transitionTime, resetIntervalDays),
        };
    }

    return {
        startsAt: transitionTime,
        endsAt: nextQuotaBoundary(transitionTime, resetIntervalDays),
    };
}

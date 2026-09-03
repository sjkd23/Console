export interface CalculatedQuotaResult {
    effectiveTotal: number;
    metQuota: boolean;
    carryOut: number;
}

const POINTS_SCALE = 100;

function toHundredths(value: number, label: string): number {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    if (Number(value.toFixed(2)) !== value) throw new Error(`${label} must have at most two decimal places`);
    const scaled = Math.round(value * POINTS_SCALE);
    if (!Number.isSafeInteger(scaled)) throw new Error(`${label} is outside the supported range`);
    return scaled;
}

function fromHundredths(value: number): number {
    return value === 0 ? 0 : value / POINTS_SCALE;
}

/** Pure period accounting. Carry never becomes earned activity. */
export function calculateQuotaResult(
    earnedPoints: number,
    carryIn: number,
    requiredPoints: number,
    rolloverEnabled: boolean
): CalculatedQuotaResult {
    const earnedHundredths = toHundredths(earnedPoints, 'Earned points');
    const carryInHundredths = toHundredths(carryIn, 'Carry in');
    const requiredHundredths = toHundredths(requiredPoints, 'Required points');
    const effectiveHundredths = earnedHundredths + carryInHundredths;
    if (!Number.isSafeInteger(effectiveHundredths)) throw new Error('Effective quota total is outside the supported range');
    const carryOutHundredths = rolloverEnabled
        ? Math.min(Math.max(effectiveHundredths - requiredHundredths, 0), requiredHundredths)
        : 0;

    return {
        effectiveTotal: fromHundredths(effectiveHundredths),
        metQuota: effectiveHundredths >= requiredHundredths,
        carryOut: fromHundredths(carryOutHundredths),
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

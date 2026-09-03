import { describe, expect, it } from 'vitest';
import {
    calculateQuotaResult,
    getLegacyQuotaTransitionWindow,
    isLatestReachedBoundary,
    isWithinHalfOpenPeriod,
    nextQuotaBoundary,
} from './quota-period-accounting.js';

describe('quota rollover accounting', () => {
    it.each([
        { earned: 8, carry: 0, expectedEffective: 8, expectedCarry: 0 },
        { earned: 10, carry: 0, expectedEffective: 10, expectedCarry: 0 },
        { earned: 15, carry: 0, expectedEffective: 15, expectedCarry: 5 },
        { earned: 20, carry: 0, expectedEffective: 20, expectedCarry: 10 },
        { earned: 30, carry: 0, expectedEffective: 30, expectedCarry: 10 },
        { earned: 0, carry: 10, expectedEffective: 10, expectedCarry: 0 },
        { earned: 10, carry: 10, expectedEffective: 20, expectedCarry: 10 },
    ])('calculates earned $earned + carry $carry', ({ earned, carry, expectedEffective, expectedCarry }) => {
        const result = calculateQuotaResult(earned, carry, 10, true);
        expect(result.effectiveTotal).toBe(expectedEffective);
        expect(result.carryOut).toBe(expectedCarry);
        expect(result.metQuota).toBe(expectedEffective >= 10);
    });

    it('always emits zero carry when rollover is disabled', () => {
        expect(calculateQuotaResult(30, 10, 10, false)).toEqual({
            effectiveTotal: 40,
            metQuota: true,
            carryOut: 0,
        });
    });

    it.each([
        { earned: 0.7, carryIn: 0.1, required: 0.8, met: true, effective: 0.8, carryOut: 0 },
        { earned: 0.69, carryIn: 0.1, required: 0.8, met: false, effective: 0.79, carryOut: 0 },
        { earned: 0.81, carryIn: 0.1, required: 0.8, met: true, effective: 0.91, carryOut: 0.11 },
        { earned: 2.5, carryIn: 1.5, required: 1.25, met: true, effective: 4, carryOut: 1.25 },
        { earned: -0.2, carryIn: 0.1, required: 0.8, met: false, effective: -0.1, carryOut: 0 },
    ])('calculates fractional accounting exactly for $earned + $carryIn', ({ earned, carryIn, required, met, effective, carryOut }) => {
        expect(calculateQuotaResult(earned, carryIn, required, true)).toEqual({
            effectiveTotal: effective,
            metQuota: met,
            carryOut,
        });
    });

    it('keeps fractional arithmetic exact when rollover is disabled', () => {
        expect(calculateQuotaResult(0.7, 0.1, 0.8, false)).toEqual({
            effectiveTotal: 0.8,
            metQuota: true,
            carryOut: 0,
        });
    });

    it('rejects inputs beyond the persisted two-decimal contract instead of silently rounding', () => {
        expect(() => calculateQuotaResult(0.001, 0, 1, true)).toThrow(/two decimal places/);
    });

    it('normalizes negative zero at the public boundary', () => {
        const result = calculateQuotaResult(-0, -0, 0, false);
        expect(Object.is(result.effectiveTotal, -0)).toBe(false);
        expect(Object.is(result.carryOut, -0)).toBe(false);
        expect(result).toEqual({ effectiveTotal: 0, metQuota: true, carryOut: 0 });
    });
});

describe('legacy quota transition', () => {
    const transitionTime = new Date('2026-08-28T12:00:00.000Z');

    it('turns one overdue legacy window into one current transition period', () => {
        const window = getLegacyQuotaTransitionWindow(
            new Date('2026-04-01T00:00:00.000Z'),
            new Date('2026-04-09T00:00:00.000Z'),
            transitionTime,
            7
        );
        expect(window.startsAt.toISOString()).toBe('2026-04-09T00:00:00.000Z');
        expect(window.endsAt.toISOString()).toBe('2026-09-04T12:00:00.000Z');
    });

    it('preserves a valid future legacy boundary', () => {
        const window = getLegacyQuotaTransitionWindow(
            new Date('2026-08-25T00:00:00.000Z'),
            new Date('2026-09-01T00:00:00.000Z'),
            transitionTime,
            7
        );
        expect(window.startsAt.toISOString()).toBe('2026-08-25T00:00:00.000Z');
        expect(window.endsAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });
});

describe('quota period boundaries', () => {
    const startsAt = new Date('2026-08-01T00:00:00.000Z');
    const endsAt = new Date('2026-08-08T00:00:00.000Z');

    it('uses a half-open interval', () => {
        expect(isWithinHalfOpenPeriod(new Date('2026-08-07T23:59:59.999Z'), startsAt, endsAt)).toBe(true);
        expect(isWithinHalfOpenPeriod(endsAt, startsAt, endsAt)).toBe(false);
        expect(isWithinHalfOpenPeriod(new Date('2026-08-08T00:00:00.001Z'), startsAt, endsAt)).toBe(false);
    });

    it('advances sequentially from the persisted predecessor boundary', () => {
        const second = nextQuotaBoundary(endsAt, 7);
        const third = nextQuotaBoundary(second, 7);
        expect(second.toISOString()).toBe('2026-08-15T00:00:00.000Z');
        expect(third.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    });

    it('uses live membership only for the latest reached catch-up boundary', () => {
        expect(isLatestReachedBoundary(endsAt, 7, new Date('2026-08-20T00:00:00.000Z'))).toBe(false);
        expect(isLatestReachedBoundary(new Date('2026-08-15T00:00:00.000Z'), 7, new Date('2026-08-20T00:00:00.000Z'))).toBe(true);
    });
});

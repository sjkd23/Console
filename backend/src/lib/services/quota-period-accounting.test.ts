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

import { describe, expect, it } from 'vitest';
import { DecimalPointsSchema } from './decimal-points.js';

describe('quota decimal inputs', () => {
    it.each([0, 0.1, 0.29, 0.57, 1.10, '0', '0.10', '0.29', '0.57', '1.10', '99999999.99'])('accepts %s without binary equality checks', value => {
        expect(DecimalPointsSchema.parse(value)).toBe(Number(value));
    });
    it.each([-0.1, NaN, Infinity, -Infinity, 0.001, 100000000, '-0.1', 'NaN', 'Infinity', '0.1abc', '0.100', '100000000', '', '1e-1', null])('rejects %s', value => {
        expect(DecimalPointsSchema.safeParse(value).success).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { normalizeRunId } from './run-id.js';

describe('normalizeRunId', () => {
    it('normalizes the string representation returned by pg for BIGINT', () => {
        expect(normalizeRunId('674')).toBe(674);
    });

    it('preserves the canonical numeric API representation', () => {
        expect(normalizeRunId(675)).toBe(675);
    });

    it.each(['', 'not-a-run', '0', '-1', '9007199254740992'])(
        'rejects invalid or unsafe PostgreSQL run ID %j',
        value => {
            expect(() => normalizeRunId(value)).toThrow(/invalid or unsafe run ID/i);
        }
    );
});

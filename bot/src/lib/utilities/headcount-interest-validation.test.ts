import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    getHeadcountInterestRejection,
    parseHeadcountInterestCustomId,
} from './headcount-interest-validation.js';

const now = new Date('2026-09-03T12:00:00.000Z');

describe('headcount interest validation', () => {
    it('parses the dungeon-specific custom ID and rejects malformed IDs', () => {
        assert.deepEqual(parseHeadcountInterestCustomId('headcount:interest:12345:LOST_HALLS'), {
            panelTimestamp: '12345',
            dungeonCode: 'LOST_HALLS',
        });
        assert.equal(parseHeadcountInterestCustomId('headcount:interest:12345'), null);
        assert.equal(parseHeadcountInterestCustomId('headcount:interest:not-a-timestamp:NEST'), null);
        assert.equal(parseHeadcountInterestCustomId('headcount:interest:12345:NEST:extra'), null);
    });

    it('accepts only a selected dungeon on an active headcount', () => {
        const active = {
            autoEndAt: new Date('2026-09-03T12:05:00.000Z'),
            dungeonCodes: ['LOST_HALLS', 'FUNGAL_CAVERN'],
        };

        assert.equal(getHeadcountInterestRejection(active, 'LOST_HALLS', now), null);
        assert.match(getHeadcountInterestRejection(active, 'NEST', now) ?? '', /not part/);
        assert.match(getHeadcountInterestRejection(active, 'NOT_A_DUNGEON', now) ?? '', /not part/);
    });

    it('rejects closed and expired headcounts', () => {
        assert.match(getHeadcountInterestRejection(null, 'LOST_HALLS', now) ?? '', /closed or expired/);
        assert.match(getHeadcountInterestRejection({
            autoEndAt: new Date('2026-09-03T12:00:00.000Z'),
            dungeonCodes: ['LOST_HALLS'],
        }, 'LOST_HALLS', now) ?? '', /closed or expired/);
    });
});

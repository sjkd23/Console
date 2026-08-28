import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getQuotaLeaderboardPresentation } from './quota-leaderboard-format.js';

describe('live quota leaderboard presentation', () => {
    it('shows carry-only progress without accounting terminology', () => {
        assert.deepEqual(getQuotaLeaderboardPresentation(10, 10, 10), {
            progress: '10 (10 rollover)',
            metQuota: true,
        });
    });

    it('shows combined progress and only the rollover component', () => {
        assert.deepEqual(getQuotaLeaderboardPresentation(11, 3, 10), {
            progress: '11 (3 rollover)',
            metQuota: true,
        });
    });

    it('omits the rollover suffix when carry is zero', () => {
        assert.deepEqual(getQuotaLeaderboardPresentation(9, 0, 10), {
            progress: '9',
            metQuota: false,
        });
    });
});

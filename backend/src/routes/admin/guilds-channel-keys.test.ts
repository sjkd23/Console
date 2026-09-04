import { describe, expect, it } from 'vitest';
import { CHANNEL_KEYS } from './guilds.js';

describe('guild channel catalog contract', () => {
    it('supports Active Runs while retaining existing raid channel keys', () => {
        expect(CHANNEL_KEYS).toContain('active_runs');
        expect(CHANNEL_KEYS).toContain('raid');
        expect(CHANNEL_KEYS).toContain('raid_log');
    });
});

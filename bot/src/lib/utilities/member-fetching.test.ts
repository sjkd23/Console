import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import type { Guild, Role } from 'discord.js';

mock.module('../../config.js', { namedExports: { botConfig: {
    MEMBER_FETCH_TIMEOUT_MS: 5, MEMBER_CACHE_THRESHOLD: 0.95, MEMBER_FETCH_BACKOFF_MS: 10000,
} } });
mock.module('../logging/logger.js', { namedExports: { createLogger: () => ({ debug() {}, info() {}, warn() {} }) } });
const { fetchGuildMembersWithTimeout, getRoleMembersWithCache } = await import('./member-fetching.js');
let nextId = 0;
function fixture(cached: number, total: number) {
    const cache = new Map(Array.from({ length: cached }, (_, i) => [String(i), { id: String(i) }]));
    const fetch = mock.fn(async () => cache);
    const guild = { id: `fixture-${nextId++}`, name: 'Test guild', memberCount: total, members: { cache, fetch } };
    return { guild, fetch, cache };
}
for (const [cached, total, complete] of [[95, 100, false], [100, 100, true], [0, 0, false], [101, 100, false]] as const) {
    it(`cache ${cached}/${total} has verified completeness=${complete}`, async () => {
        const { guild, fetch } = fixture(cached, total);
        const result = await fetchGuildMembersWithTimeout(guild as unknown as Guild);
        assert.equal(result.source, 'cache'); assert.equal(result.complete, complete); assert.equal(fetch.mock.callCount(), 0);
    });
}
it('marks a successful fetch complete only when its cache covers the current known guild count', async () => {
    const { guild, cache } = fixture(1, 2);
    const partial = await fetchGuildMembersWithTimeout(guild as unknown as Guild, { forceFetch: true });
    assert.equal(partial.source, 'fetch'); assert.equal(partial.complete, false);
    cache.set('other', { id: 'other' });
    const full = await fetchGuildMembersWithTimeout(guild as unknown as Guild, { forceFetch: true });
    assert.equal(full.complete, true);
});
it('keeps timeout/failure and backoff rosters unverified, while retaining available role members', async () => {
    const { guild, fetch } = fixture(1, 2);
    fetch.mock.mockImplementation(async () => { throw new Error('synthetic fetch failure'); });
    const role = { id: 'role', name: 'Quota role', guild, members: { map: () => ['known-zero-point-member'] } };
    const failed = await getRoleMembersWithCache(role as unknown as Role);
    assert.equal(failed.fetchResult.source, 'timeout-fallback'); assert.equal(failed.fetchResult.complete, false);
    assert.deepEqual(failed.memberIds, ['known-zero-point-member']);
    const backoff = await getRoleMembersWithCache(role as unknown as Role);
    assert.equal(backoff.fetchResult.source, 'backoff-skip'); assert.equal(backoff.fetchResult.complete, false);
    assert.deepEqual(backoff.memberIds, failed.memberIds); assert.equal(fetch.mock.callCount(), 1);
});
it('does not mark a real timeout complete even when the existing cache covers the count', async () => {
    const { guild, fetch } = fixture(1, 1);
    fetch.mock.mockImplementation(() => new Promise(() => {}));
    const result = await fetchGuildMembersWithTimeout(guild as unknown as Guild, { forceFetch: true });
    assert.equal(result.source, 'timeout-fallback'); assert.equal(result.complete, false);
});

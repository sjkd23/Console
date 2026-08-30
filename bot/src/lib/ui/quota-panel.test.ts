import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLeaderboardEmbed } from './quota-panel.js';
import { buildQuotaConfigPanel } from './quota-config-panel.js';

const config = { base_exalt_points: 1, base_non_exalt_points: 0, misc_points_per_minute: 20, moderation_points: 0 };
const overrides = { NEST: 2, SNAKE_PIT: 1, ABYSS_OF_DEMONS: 0.57 };

function description(values = config, dungeonOverrides: Record<string, number> = {}) {
    return buildLeaderboardEmbed('Organizers', 10, '2026-08-01', '2026-08-08', [], values, dungeonOverrides).toJSON().description ?? '';
}

describe('quota panel point sources', () => {
    for (const [points, text] of [[0.5, '0.5 points'], [1, '1 point'], [1.5, '1.5 points'], [2, '2 points']] as const) {
        it(`formats dungeon points as ${text}`, () => {
            const result = description({ ...config, base_exalt_points: points, base_non_exalt_points: points });
            assert.ok(result.includes(`**Exalt Dungeons:** ${text}\n`));
            assert.ok(result.includes(`**Non-Exalt Dungeons:** ${text}\n`));
        });
    }
    it('shows compact minutes and hides a zero non-exalt base without hiding any specific overrides', () => {
        const result = description(config, overrides);
        assert.ok(result.includes('**Exalt Dungeons:** 1 point'));
        assert.ok(result.includes('**Non-Exalt Dungeons:** 20/min'));
        assert.equal((result.match(/\*\*Non-Exalt Dungeons:\*\*/g) ?? []).length, 1);
        assert.ok(result.includes('**Dungeon Overrides:** Nest: 2 points, Snake Pit: 1 point, Abyss of Demons: 0.57 points'));
        assert.doesNotMatch(result, /Entries|\bpts\b|point\(s\)|frozen at Start|\b1 points\b|\b0 points\b/i);
    });
    it('uses canonical display names for known overrides rather than formatting their internal keys', () => {
        const result = description(config, { MAGIC_WOODS: 0.57, SNAKE_PIT: 1, FUNGAL_CAVERN: 2, THE_VOID: 3 });
        assert.ok(result.includes('**Dungeon Overrides:** Void: 3 points, Fungal Cavern: 2 points, Snake Pit: 1 point, Magic Woods: 0.57 points'));
        assert.doesNotMatch(result, /MAGIC_WOODS|SNAKE_PIT|FUNGAL_CAVERN|THE_VOID|The Void/);
    });
    it('falls back to the original key for unknown or legacy overrides', () => {
        const result = description(config, { LEGACY_DUNGEON: 0.5, SNAKE_PIT: 1 });
        assert.ok(result.includes('**Dungeon Overrides:** Snake Pit: 1 point, LEGACY_DUNGEON: 0.5 points'));
    });
    it('preserves override sorting and the existing top-ten layout', () => {
        const manyOverrides = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`DUNGEON_${i}`, i + 1]));
        const result = description(config, manyOverrides);
        assert.ok(result.includes('**Dungeon Overrides:** DUNGEON_11: 12 points, DUNGEON_10: 11 points'));
        assert.ok(result.includes('_...and 2 more_'));
        assert.ok(!result.includes('DUNGEON_0:'));
    });
    it('uses compact decimal minute formatting and natural moderation pluralization', () => {
        assert.ok(description({ ...config, misc_points_per_minute: 0.1, moderation_points: 1 }).includes('**Non-Exalt Dungeons:** 0.1/min'));
        assert.ok(description({ ...config, moderation_points: 1 }).includes('**Verifications:** 1 point each'));
    });
    it('uses canonical admin override labels while preserving decimals, zero values, and legacy keys', async context => {
        context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
            config: { ...config, required_points: 10, reset_interval_days: 7, rollover_enabled: false },
            active_period: { starts_at: '2026-08-01', ends_at: '2026-08-08', required_points: 10, rollover_enabled: false },
            dungeon_overrides: { ...overrides, THE_VOID: 3, LEGACY_DUNGEON: 0 },
        }), { status: 200 }));
        const panel = (await buildQuotaConfigPanel('1', '2')).embed.toJSON();
        const overrideField = panel.fields?.find(field => field.name === '⚙️ Dungeon Point Overrides');
        assert.equal(overrideField?.value, 'Void: 3 points\nNest: 2 points\nSnake Pit: 1 point\nAbyss of Demons: 0.57 points\nLEGACY_DUNGEON: 0 points');
        assert.doesNotMatch(overrideField?.value ?? '', /NEST|SNAKE_PIT|ABYSS_OF_DEMONS|THE_VOID|The Void/);
        assert.ok(panel.fields?.some(field => field.name.includes('Base Non-Exalt') && field.value === '0'));
        assert.doesNotMatch(JSON.stringify(panel), /frozen at Start|pts\/entry|point\(s\)/i);
    });
});

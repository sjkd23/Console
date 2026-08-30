import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DUNGEON_DATA } from './DungeonData.js';
import { dungeonByCode } from './dungeon-helpers.js';
import {
    classifyRunDungeons,
    isAggregateActivityKey,
    validateHeadcountDungeons,
} from './dungeon-taxonomy.js';
import { getCategorizedDungeons } from './dungeon-helpers.js';
import { buildDungeonEnteredButton } from '../../interactions/buttons/raids/organizer-panel.js';
import { getDungeonEnteredEmojiIdentifier } from '../../lib/utilities/key-emoji-helpers.js';
import {
    buildRunButtons,
    buildRunEmbed,
    buildRunTitle,
    transitionRunEmbed,
} from '../../lib/utilities/run-panel-builder.js';
import { buildRunRoleName } from '../../lib/utilities/run-role-manager.js';
import { getOrderedDungeonRoleMappingIds } from '../../lib/utilities/dungeon-role-pings.js';
import { RunDetailsSchema, getRunDisplayLabel } from '../../lib/utilities/http.js';
import { getPhysicalDungeonKeyOffers } from '../../lib/utilities/dungeon-key-offers.js';

function dungeons(...codes: string[]) {
    return codes.map(code => {
        const dungeon = dungeonByCode[code];
        assert.ok(dungeon, `missing fixture dungeon ${code}`);
        return dungeon;
    });
}

describe('bot run-selection policy', () => {
    it('accepts a one-dungeon run and same-class multi-runs', () => {
        assert.equal(classifyRunDungeons(dungeons('NEST')).runKind, 'single');
        assert.deepEqual(classifyRunDungeons(dungeons('NEST', 'FUNGAL_CAVERN')), {
            runKind: 'multi_exalt',
            activityKey: 'EXALTATION_DUNGEONS',
            dungeonKey: 'EXALTATION_DUNGEONS',
            dungeonLabel: 'Exaltation Dungeons',
        });
        assert.equal(
            classifyRunDungeons(dungeons('SNAKE_PIT', 'ABYSS_OF_DEMONS')).runKind,
            'multi_non_exalt'
        );
    });

    it('accepts Realm plus non-exalts and rejects Realm plus exalt or O3', () => {
        assert.equal(
            classifyRunDungeons(dungeons('REALM_DUNGEON', 'SNAKE_PIT')).runKind,
            'multi_non_exalt'
        );
        assert.equal(
            classifyRunDungeons(dungeons('REALM_DUNGEON', 'SNAKE_PIT', 'MAGIC_WOODS', 'ABYSS_OF_DEMONS')).activityKey,
            'MISC_DUNGEONS'
        );
        assert.throws(() => classifyRunDungeons(dungeons('REALM_DUNGEON', 'NEST')), /cannot mix exaltation/i);
        assert.throws(() => classifyRunDungeons(dungeons('REALM_DUNGEON', 'ORYX_3')), /Oryx 3 must be selected alone/i);
    });

    it('rejects mixed, O3-plus-other, duplicates, and more than five', () => {
        assert.throws(() => classifyRunDungeons(dungeons('NEST', 'SNAKE_PIT')), /cannot mix/i);
        assert.throws(() => classifyRunDungeons(dungeons('ORYX_3', 'NEST')), /alone/i);
        assert.throws(() => classifyRunDungeons(dungeons('NEST', 'NEST')), /duplicate/i);
        assert.throws(
            () => classifyRunDungeons(dungeons('NEST', 'FUNGAL_CAVERN', 'STEAMWORKS', 'SHATTERS', 'LOST_HALLS', 'THE_VOID')),
            /between 1 and 5/i
        );
    });

    it('keeps aggregate activity keys out of physical run metadata', () => {
        assert.equal(DUNGEON_DATA.some(dungeon => isAggregateActivityKey(dungeon.codeName)), false);
    });

    it('includes Realm Clearing in the shared run/headcount selector source', () => {
        const categorized = getCategorizedDungeons();
        const selectableCodes = [...categorized.exalt, ...categorized.misc1, ...categorized.misc2]
            .map(dungeon => dungeon.codeName);
        assert.ok(selectableCodes.includes('REALM_DUNGEON'));
        assert.ok(!selectableCodes.includes('MISC_DUNGEONS'));
        assert.ok(!selectableCodes.includes('EXALTATION_DUNGEONS'));
    });

    it('does not impose run policy on a mixed headcount selection', () => {
        const mixedHeadcount = dungeons('NEST', 'SNAKE_PIT', 'ORYX_3');
        assert.equal(mixedHeadcount.length, 3);
        assert.throws(() => classifyRunDungeons(mixedHeadcount), /Oryx 3 must be selected alone/i);
    });

    it('keeps headcounts fully permissive across Realm, exalt, non-exalt, and O3', () => {
        assert.equal(validateHeadcountDungeons(dungeons('REALM_DUNGEON')), null);
        assert.equal(validateHeadcountDungeons(dungeons('REALM_DUNGEON', 'SNAKE_PIT', 'MAGIC_WOODS')), null);
        assert.equal(validateHeadcountDungeons(dungeons('REALM_DUNGEON', 'NEST')), null);
        assert.equal(validateHeadcountDungeons(dungeons('REALM_DUNGEON', 'ORYX_3')), null);
        assert.equal(
            validateHeadcountDungeons(dungeons('REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3')),
            null
        );
        assert.equal(validateHeadcountDungeons(dungeons('NEST', 'SNAKE_PIT', 'ORYX_3')), null);
    });

    it('keeps the same combinations illegal for actual runs', () => {
        assert.throws(() => classifyRunDungeons(dungeons('REALM_DUNGEON', 'NEST')), /cannot mix/i);
        assert.throws(() => classifyRunDungeons(dungeons('REALM_DUNGEON', 'ORYX_3')), /alone/i);
        assert.throws(
            () => classifyRunDungeons(dungeons('REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3')),
            /alone/i
        );
        assert.throws(() => classifyRunDungeons(dungeons('NEST', 'SNAKE_PIT', 'ORYX_3')), /alone/i);
    });

    it('builds Dungeon Entered buttons with the required portal icons', () => {
        const nestButton = buildDungeonEnteredButton(1, { runKind: 'single', dungeonKey: 'NEST' }).toJSON() as unknown as { label: string; emoji?: { id?: string } };
        const realmButton = buildDungeonEnteredButton(2, { runKind: 'realm_clearing', dungeonKey: 'REALM_DUNGEON' }).toJSON() as unknown as { emoji?: { id?: string } };
        const miscButton = buildDungeonEnteredButton(3, { runKind: 'multi_non_exalt', dungeonKey: 'MISC_DUNGEONS' }).toJSON() as unknown as { emoji?: { id?: string } };
        const exaltButton = buildDungeonEnteredButton(4, { runKind: 'multi_exalt', dungeonKey: 'EXALTATION_DUNGEONS' }).toJSON() as unknown as { emoji?: { id?: string } };
        assert.equal(nestButton.label, 'Dungeon Entered');
        assert.equal(nestButton.emoji?.id, getDungeonEnteredEmojiIdentifier('single', 'NEST'));
        const realmIcon = getDungeonEnteredEmojiIdentifier('realm_clearing', 'REALM_DUNGEON');
        assert.equal(realmButton.emoji?.id, realmIcon);
        assert.equal(miscButton.emoji?.id, realmIcon);
        assert.equal(exaltButton.emoji?.id, realmIcon);
    });
});

describe('Realm Clearing physical key offers', () => {
    it('has no physical Realm key offer for run or headcount builders', () => {
        const realm = dungeons('REALM_DUNGEON')[0];
        assert.equal(realm.keyReactions.length, 0);
        assert.deepEqual(getPhysicalDungeonKeyOffers([realm]), []);

        const rows = buildRunButtons({ runId: 42, dungeonData: realm, runKind: 'realm_clearing' });
        const customIds = rows.flatMap(row => row.components.map(component => component.toJSON()))
            .flatMap(component => 'custom_id' in component ? [component.custom_id] : []);
        assert.equal(customIds.some(customId => customId.startsWith('run:key:')), false);
    });

    it('exposes only Snake Pit physical key offers for Realm plus Snake', () => {
        const selected = dungeons('REALM_DUNGEON', 'SNAKE_PIT');
        const offers = getPhysicalDungeonKeyOffers(selected);
        assert.ok(offers.length > 0);
        assert.ok(offers.every(offer => offer.dungeon.codeName === 'SNAKE_PIT'));

        const rows = buildRunButtons({ runId: 42, dungeonData: selected, runKind: 'multi_non_exalt' });
        const keyIds = rows.flatMap(row => row.components.map(component => component.toJSON()))
            .flatMap(component => 'custom_id' in component && component.custom_id.startsWith('run:key:')
                ? [component.custom_id]
                : []);
        assert.deepEqual(keyIds, offers.map(offer => `run:key:42:${offer.reaction.mapKey}`));
    });
});

describe('multi-run presentation helpers', () => {
    it('uses exact single and Realm labels plus concise taxonomy labels for multi-runs', () => {
        assert.equal(buildRunTitle('starting', dungeons('NEST'), 'single'), '⏳ Starting Soon: Nest');
        assert.equal(buildRunTitle('live', dungeons('REALM_DUNGEON'), 'realm_clearing'), '🟢 LIVE: Realm Clearing');
        assert.equal(buildRunTitle('ended', dungeons('SNAKE_PIT', 'ABYSS_OF_DEMONS'), 'multi_non_exalt'), '✅ Ended: Misc Dungeons');
        assert.equal(buildRunTitle('live', dungeons('NEST', 'FUNGAL_CAVERN'), 'multi_exalt'), '🟢 LIVE: Exalt Dungeons');
    });

    it('lists multi-run physical dungeons in persisted order for every public status', () => {
        const selected = dungeons('NEST', 'FUNGAL_CAVERN', 'STEAMWORKS');

        for (const status of ['starting', 'live', 'ended', 'cancelled'] as const) {
            const embed = buildRunEmbed({
                dungeonData: selected,
                runKind: 'multi_exalt',
                organizerId: '100000000000000001',
                status,
            }).toJSON();
            const dungeonField = embed.fields?.find(field => field.name === 'Dungeons');
            assert.equal(dungeonField?.value, '• Nest\n• Fungal Cavern\n• Steamworks');
        }
    });

    it('does not add a redundant dungeon field to single or Realm Clearing runs', () => {
        for (const [selected, runKind] of [
            [dungeons('NEST'), 'single'],
            [dungeons('REALM_DUNGEON'), 'realm_clearing'],
        ] as const) {
            const embed = buildRunEmbed({
                dungeonData: selected,
                runKind,
                organizerId: '100000000000000001',
                status: 'starting',
            }).toJSON();
            assert.equal(embed.fields?.some(field => field.name === 'Dungeons') ?? false, false);
        }
    });

    it('adds the ordered multi-dungeon field when an existing panel is rebuilt', () => {
        const rebuilt = transitionRunEmbed(
            buildRunEmbed({
                dungeonData: dungeons('NEST'),
                runKind: 'single',
                organizerId: '100000000000000001',
                status: 'starting',
            }),
            'ended',
            {
                dungeonKey: 'EXALTATION_DUNGEONS',
                dungeonLabel: 'Exaltation Dungeons',
                runKind: 'multi_exalt',
                selectedDungeons: [
                    { dungeonKey: 'NEST', dungeonLabel: 'Nest' },
                    { dungeonKey: 'FUNGAL_CAVERN', dungeonLabel: 'Fungal Cavern' },
                ],
                organizerId: '100000000000000001',
            }
        ).toJSON();

        assert.equal(rebuilt.title, '✅ Ended: Exalt Dungeons');
        assert.equal(
            rebuilt.fields?.find(field => field.name === 'Dungeons')?.value,
            '• Nest\n• Fungal Cavern'
        );
    });

    it('keeps temporary taxonomy role names under Discord limits and cleanup-compatible', () => {
        const roleName = buildRunRoleName('A'.repeat(100), 'Multi Exalt');
        assert.ok(roleName.length <= 100);
        assert.match(roleName, /'s Multi Exalt$/);
    });

    it('fits the worst current legal five-dungeon key set without dropping buttons', () => {
        const selected = dungeons(
            'MOONLIGHT VILLAGE', 'STEAMWORKS', 'ADVANCED STEAMWORKS', 'SHATTERS', 'LOST_HALLS'
        );
        const distinctMapKeys = new Set(selected.flatMap(dungeon => dungeon.keyReactions.map(reaction => reaction.mapKey)));
        const rows = buildRunButtons({ runId: 42, dungeonData: selected, runKind: 'multi_exalt' });

        assert.equal(distinctMapKeys.size, 7);
        assert.equal(rows.length, 3); // main controls + two rows for seven key offers
        assert.ok(rows.every(row => row.components.length <= 5));
    });
});

describe('multi-dungeon role mapping', () => {
    it('preserves physical selection order and removes duplicate role IDs', () => {
        assert.deepEqual(getOrderedDungeonRoleMappingIds({
            NEST: 'role-a',
            FUNGAL_CAVERN: 'role-a',
            STEAMWORKS: 'role-b',
        }, ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS']), ['role-a', 'role-b']);
    });

    it('skips missing mappings and never requires aggregate mappings', () => {
        assert.deepEqual(getOrderedDungeonRoleMappingIds({ NEST: 'role-a' }, [
            'NEST', 'FUNGAL_CAVERN',
        ]), ['role-a']);
    });
});

describe('normalized run read contract', () => {
    it('validates taxonomy fields and ordered physical selection snapshots', () => {
        const run = RunDetailsSchema.parse({
            id: 42,
            channelId: '100',
            postMessageId: '200',
            dungeonKey: 'EXALTATION_DUNGEONS',
            dungeonLabel: 'Exaltation Dungeons',
            runKind: 'multi_exalt',
            activityKey: 'EXALTATION_DUNGEONS',
            selectedDungeons: [
                { dungeonKey: 'NEST', dungeonLabel: 'Nest', selectionOrder: 1 },
                { dungeonKey: 'FUNGAL_CAVERN', dungeonLabel: 'Fungal Cavern', selectionOrder: 2 },
            ],
            status: 'open',
            organizerId: '300',
            startedAt: null,
            endedAt: null,
            createdAt: '2026-08-29T00:00:00.000Z',
            autoEndMinutes: 120,
            keyWindowEndsAt: null,
            party: null,
            location: null,
            description: null,
            roleId: null,
            pingMessageId: null,
            keyPopCount: 0,
            chainAmount: null,
            screenshotUrl: null,
            o3Stage: null,
            joinLocked: false,
        });

        assert.equal(getRunDisplayLabel(run), 'Nest | Fungal Cavern');
        assert.equal(run.dungeonLabel, 'Exaltation Dungeons');
    });
});

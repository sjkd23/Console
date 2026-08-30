import { describe, expect, it } from 'vitest';
import { classifyRunSelection, RunSelectionError } from './run-taxonomy.js';
import { isExaltDungeon } from '../../config/raid-config.js';

describe('classifyRunSelection', () => {
    it('classifies one physical exalt as an exact single run', () => {
        expect(classifyRunSelection(['NEST'])).toMatchObject({
            runKind: 'single',
            activityKey: 'NEST',
            dungeonKey: 'NEST',
            dungeonLabel: 'Nest',
        });
    });

    it('classifies one physical non-exalt as an exact single run', () => {
        expect(classifyRunSelection(['SNAKE_PIT'])).toMatchObject({
            runKind: 'single',
            activityKey: 'SNAKE_PIT',
            dungeonKey: 'SNAKE_PIT',
            dungeonLabel: 'Snake Pit',
        });
    });

    it('classifies Realm Clearing alone', () => {
        expect(classifyRunSelection(['REALM_DUNGEON'])).toMatchObject({
            runKind: 'realm_clearing',
            activityKey: 'MISC_DUNGEONS',
            dungeonKey: 'REALM_DUNGEON',
            dungeonLabel: 'Realm Clearing',
        });
    });

    it('classifies O3 alone', () => {
        expect(classifyRunSelection(['ORYX_3'])).toMatchObject({
            runKind: 'oryx_3',
            activityKey: 'ORYX_3',
            dungeonKey: 'ORYX_3',
        });
        expect(isExaltDungeon('ORYX_3')).toBe(true);
    });

    it.each([
        ['NEST', 'FUNGAL_CAVERN'],
        ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS'],
        ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS', 'SHATTERS'],
        ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS', 'SHATTERS', 'LOST_HALLS'],
    ])('classifies 2-5 physical exalts as one multi-exalt run', (...keys) => {
        const classified = classifyRunSelection(keys);
        expect(classified).toMatchObject({
            runKind: 'multi_exalt',
            activityKey: 'EXALTATION_DUNGEONS',
            dungeonKey: 'EXALTATION_DUNGEONS',
            dungeonLabel: 'Exaltation Dungeons',
        });
        expect(classified.selectedDungeons.map(selection => selection.dungeonKey)).toEqual(keys);
        expect(classified.selectedDungeons.map(selection => selection.selectionOrder)).toEqual(
            keys.map((_, index) => index + 1)
        );
    });

    it.each([
        ['SNAKE_PIT', 'ABYSS_OF_DEMONS'],
        ['SNAKE_PIT', 'ABYSS_OF_DEMONS', 'SPRITE_WORLD'],
        ['SNAKE_PIT', 'ABYSS_OF_DEMONS', 'SPRITE_WORLD', 'UNDEAD_LAIR'],
        ['SNAKE_PIT', 'ABYSS_OF_DEMONS', 'SPRITE_WORLD', 'UNDEAD_LAIR', 'MAGIC_WOODS'],
    ])('classifies 2-5 physical non-exalts as one multi-non-exalt run', (...keys) => {
        expect(classifyRunSelection(keys)).toMatchObject({
            runKind: 'multi_non_exalt',
            activityKey: 'MISC_DUNGEONS',
            dungeonKey: 'MISC_DUNGEONS',
            dungeonLabel: 'Misc Dungeons',
        });
    });

    it.each([
        ['REALM_DUNGEON', 'SNAKE_PIT'],
        ['REALM_DUNGEON', 'SNAKE_PIT', 'MAGIC_WOODS', 'ABYSS_OF_DEMONS'],
    ])('classifies Realm Clearing plus non-exalts as multi-non-exalt', (...keys) => {
        const result = classifyRunSelection(keys);
        expect(result).toMatchObject({
            runKind: 'multi_non_exalt',
            activityKey: 'MISC_DUNGEONS',
            dungeonKey: 'MISC_DUNGEONS',
            dungeonLabel: 'Misc Dungeons',
        });
        expect(result.selectedDungeons.map(selection => selection.dungeonKey)).toEqual(keys);
    });

    it.each([
        [['NEST', 'SNAKE_PIT'], /cannot mix/i],
        [['ORYX_3', 'NEST'], /Oryx 3 must be selected alone/i],
        [['REALM_DUNGEON', 'NEST'], /cannot mix exaltation/i],
        [['REALM_DUNGEON', 'ORYX_3'], /Oryx 3 must be selected alone/i],
        [['NEST', 'NEST'], /Duplicate/i],
        [['DOES_NOT_EXIST'], /Unknown dungeon code/i],
        [['MISC_DUNGEONS'], /not a selectable dungeon/i],
        [['EXALTATION_DUNGEONS'], /not a selectable dungeon/i],
        [[], /between 1 and 5/i],
        [['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS', 'SHATTERS', 'LOST_HALLS', 'THE_VOID'], /between 1 and 5/i],
    ] as const)('rejects illegal selections %#', (keys, expected) => {
        expect(() => classifyRunSelection(keys)).toThrow(RunSelectionError);
        expect(() => classifyRunSelection(keys)).toThrow(expected);
    });
});

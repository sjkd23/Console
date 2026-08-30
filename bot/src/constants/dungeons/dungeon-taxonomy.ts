import type { DungeonInfo, DungeonSelectionClass } from './dungeon-types.js';

export const RUN_KINDS = [
    'single',
    'realm_clearing',
    'multi_non_exalt',
    'multi_exalt',
    'oryx_3',
] as const;

export type RunKind = typeof RUN_KINDS[number];

export const AGGREGATE_ACTIVITY_LABELS = {
    MISC_DUNGEONS: 'Misc Dungeons',
    EXALTATION_DUNGEONS: 'Exaltation Dungeons',
} as const;

const EXALT_DUNGEON_CODES = new Set([
    'SHATTERS', 'NEST', 'ADVANCED_NEST', 'FUNGAL_CAVERN', 'CULTIST_HIDEOUT',
    'THE_VOID', 'LOST_HALLS', 'MOONLIGHT VILLAGE', 'STEAMWORKS',
    'ADVANCED STEAMWORKS', 'ICE_CITADEL', 'SPECTRAL_PENITENTIARY',
]);

export function getDungeonSelectionClass(code: string): DungeonSelectionClass {
    if (code === 'ORYX_3') return 'oryx_3';
    if (code === 'REALM_DUNGEON') return 'realm_clearing';
    return EXALT_DUNGEON_CODES.has(code) ? 'exalt' : 'non_exalt';
}

export function isExaltDungeon(code: string): boolean {
    return getDungeonSelectionClass(code) === 'exalt';
}

export function isOryx3Dungeon(code: string): boolean {
    return getDungeonSelectionClass(code) === 'oryx_3';
}

export function isRealmClearingDungeon(code: string): boolean {
    return getDungeonSelectionClass(code) === 'realm_clearing';
}

export function isAggregateActivityKey(code: string): code is keyof typeof AGGREGATE_ACTIVITY_LABELS {
    return Object.hasOwn(AGGREGATE_ACTIVITY_LABELS, code);
}

export interface BotRunClassification {
    runKind: RunKind;
    activityKey: string;
    dungeonKey: string;
    dungeonLabel: string;
}

export function classifyRunDungeons(dungeons: readonly DungeonInfo[]): BotRunClassification {
    if (dungeons.length < 1 || dungeons.length > 5) {
        throw new Error('Select between 1 and 5 dungeons.');
    }
    const codes = dungeons.map(dungeon => dungeon.codeName);
    if (new Set(codes).size !== codes.length) throw new Error('Duplicate dungeons are not allowed.');
    if (codes.some(isAggregateActivityKey)) throw new Error('Aggregate activity categories cannot be selected as dungeons.');

    if (dungeons.length === 1) {
        const dungeon = dungeons[0];
        const selectionClass = getDungeonSelectionClass(dungeon.codeName);
        if (selectionClass === 'oryx_3') {
            return { runKind: 'oryx_3', activityKey: 'ORYX_3', dungeonKey: 'ORYX_3', dungeonLabel: dungeon.dungeonName };
        }
        if (selectionClass === 'realm_clearing') {
            return { runKind: 'realm_clearing', activityKey: 'MISC_DUNGEONS', dungeonKey: 'REALM_DUNGEON', dungeonLabel: 'Realm Clearing' };
        }
        return { runKind: 'single', activityKey: dungeon.codeName, dungeonKey: dungeon.codeName, dungeonLabel: dungeon.dungeonName };
    }

    const classes = dungeons.map(dungeon => getDungeonSelectionClass(dungeon.codeName));
    if (classes.includes('oryx_3')) throw new Error('Oryx 3 must be selected alone.');
    if (classes.every(selectionClass => selectionClass === 'exalt')) {
        return {
            runKind: 'multi_exalt', activityKey: 'EXALTATION_DUNGEONS',
            dungeonKey: 'EXALTATION_DUNGEONS', dungeonLabel: AGGREGATE_ACTIVITY_LABELS.EXALTATION_DUNGEONS,
        };
    }
    if (classes.every(selectionClass => selectionClass === 'non_exalt' || selectionClass === 'realm_clearing')) {
        return {
            runKind: 'multi_non_exalt', activityKey: 'MISC_DUNGEONS',
            dungeonKey: 'MISC_DUNGEONS', dungeonLabel: AGGREGATE_ACTIVITY_LABELS.MISC_DUNGEONS,
        };
    }
    throw new Error('A run cannot mix exaltation dungeons with Realm Clearing or non-exalt dungeons.');
}

/** Headcounts are intentionally category-agnostic; run taxonomy is applied only at conversion. */
export function validateHeadcountDungeons(dungeons: readonly DungeonInfo[]): string | null {
    return dungeons.length >= 1 && dungeons.length <= 5
        ? null
        : 'Choose between 1 and 5 dungeons.';
}

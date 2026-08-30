import { z } from 'zod';
import {
    AGGREGATE_ACTIVITY_KEYS,
    getDungeonByCode,
    isAggregateActivityKey,
    type DungeonConfig,
} from '../../config/raid-config.js';

export const RUN_KINDS = [
    'single',
    'realm_clearing',
    'multi_non_exalt',
    'multi_exalt',
    'oryx_3',
] as const;

export const RunKindSchema = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKindSchema>;

export interface RunDungeonSelection {
    dungeonKey: string;
    dungeonLabel: string;
    selectionOrder: number;
}

export interface ClassifiedRunSelection {
    runKind: RunKind;
    activityKey: string;
    dungeonKey: string;
    dungeonLabel: string;
    selectedDungeons: RunDungeonSelection[];
}

export class RunSelectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RunSelectionError';
    }
}

const SelectedKeysSchema = z.array(z.string().trim().min(1).max(64)).min(1).max(5);

function normalizeSelections(dungeons: readonly DungeonConfig[]): RunDungeonSelection[] {
    return dungeons.map((dungeon, index) => ({
        dungeonKey: dungeon.code,
        dungeonLabel: dungeon.name,
        selectionOrder: index + 1,
    }));
}

export function classifyRunSelection(input: readonly string[]): ClassifiedRunSelection {
    const parsed = SelectedKeysSchema.safeParse(input);
    if (!parsed.success) {
        throw new RunSelectionError('Select between 1 and 5 dungeons.');
    }

    const selectedKeys = parsed.data;
    if (new Set(selectedKeys).size !== selectedKeys.length) {
        throw new RunSelectionError('Duplicate dungeons are not allowed.');
    }

    const dungeons = selectedKeys.map(code => {
        if (isAggregateActivityKey(code)) {
            throw new RunSelectionError(`${AGGREGATE_ACTIVITY_KEYS[code]} is an activity category, not a selectable dungeon.`);
        }
        const dungeon = getDungeonByCode(code);
        if (!dungeon) throw new RunSelectionError(`Unknown dungeon code: ${code}`);
        return dungeon;
    });

    const selectedDungeons = normalizeSelections(dungeons);
    const first = dungeons[0];

    if (dungeons.length === 1) {
        if (first.selectionClass === 'oryx_3') {
            return {
                runKind: 'oryx_3',
                activityKey: 'ORYX_3',
                dungeonKey: 'ORYX_3',
                dungeonLabel: first.name,
                selectedDungeons,
            };
        }
        if (first.selectionClass === 'realm_clearing') {
            return {
                runKind: 'realm_clearing',
                activityKey: 'MISC_DUNGEONS',
                dungeonKey: 'REALM_DUNGEON',
                dungeonLabel: 'Realm Clearing',
                selectedDungeons,
            };
        }
        return {
            runKind: 'single',
            activityKey: first.code,
            dungeonKey: first.code,
            dungeonLabel: first.name,
            selectedDungeons,
        };
    }

    if (dungeons.some(dungeon => dungeon.selectionClass === 'oryx_3')) {
        throw new RunSelectionError('Oryx 3 must be selected alone.');
    }
    const allExalt = dungeons.every(dungeon => dungeon.selectionClass === 'exalt');
    const allNonExalt = dungeons.every(dungeon =>
        dungeon.selectionClass === 'non_exalt' || dungeon.selectionClass === 'realm_clearing'
    );
    if (!allExalt && !allNonExalt) {
        throw new RunSelectionError('A run cannot mix exaltation dungeons with Realm Clearing or non-exalt dungeons.');
    }

    return allExalt
        ? {
            runKind: 'multi_exalt',
            activityKey: 'EXALTATION_DUNGEONS',
            dungeonKey: 'EXALTATION_DUNGEONS',
            dungeonLabel: AGGREGATE_ACTIVITY_KEYS.EXALTATION_DUNGEONS,
            selectedDungeons,
        }
        : {
            runKind: 'multi_non_exalt',
            activityKey: 'MISC_DUNGEONS',
            dungeonKey: 'MISC_DUNGEONS',
            dungeonLabel: AGGREGATE_ACTIVITY_KEYS.MISC_DUNGEONS,
            selectedDungeons,
        };
}

export function usesAggregateActivity(runKind: RunKind): boolean {
    return runKind === 'realm_clearing' || runKind === 'multi_non_exalt' || runKind === 'multi_exalt';
}

export function quotaBaseCategoryForRun(runKind: RunKind): 'exalt' | 'non_exalt' | null {
    if (runKind === 'multi_exalt') return 'exalt';
    if (runKind === 'multi_non_exalt') return 'non_exalt';
    return null;
}

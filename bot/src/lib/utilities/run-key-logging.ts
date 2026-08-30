import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { isAggregateActivityKey } from '../../constants/dungeons/dungeon-taxonomy.js';
import type { RunDetails } from './http.js';

export interface LoggableRunDungeon {
    dungeonKey: string;
    dungeonLabel: string;
}

/** Actual physical key choices; activity summary keys and Realm Clearing are never key ledger entries. */
export function getLoggableRunDungeons(
    run: Pick<RunDetails, 'selectedDungeons'>
): LoggableRunDungeon[] {
    const seen = new Set<string>();
    const result: LoggableRunDungeon[] = [];
    for (const selection of run.selectedDungeons) {
        if (seen.has(selection.dungeonKey)
            || isAggregateActivityKey(selection.dungeonKey)
            || selection.dungeonKey === 'REALM_DUNGEON') {
            continue;
        }
        const dungeon = dungeonByCode[selection.dungeonKey];
        if (!dungeon || dungeon.keyReactions.length === 0) continue;
        seen.add(selection.dungeonKey);
        result.push({
            dungeonKey: selection.dungeonKey,
            dungeonLabel: selection.dungeonLabel,
        });
    }
    return result;
}

export function shouldStartRunKeyLogging(
    run: Pick<RunDetails, 'runKind' | 'keyPopCount' | 'selectedDungeons'>
): boolean {
    return run.runKind !== 'oryx_3'
        && run.keyPopCount > 0
        && getLoggableRunDungeons(run).length > 0;
}

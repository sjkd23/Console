import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLoggableRunDungeons, shouldStartRunKeyLogging } from './run-key-logging.js';

const selected = (...entries: Array<[string, string]>) => entries.map(([dungeonKey, dungeonLabel], index) => ({
    dungeonKey,
    dungeonLabel,
    selectionOrder: index + 1,
}));

describe('post-run physical key choices', () => {
    it('keeps selected physical key dungeons in order and excludes Realm/aggregates', () => {
        assert.deepEqual(getLoggableRunDungeons({
            selectedDungeons: selected(
                ['REALM_DUNGEON', 'Realm Clearing'],
                ['NEST', 'Nest'],
                ['MISC_DUNGEONS', 'Misc Dungeons'],
                ['STEAMWORKS', 'Kogbold Steamworks']
            ),
        }), [
            { dungeonKey: 'NEST', dungeonLabel: 'Nest' },
            { dungeonKey: 'STEAMWORKS', dungeonLabel: 'Kogbold Steamworks' },
        ]);
    });

    it('starts only for a normal run with at least one entered event and keyable selection', () => {
        const nest = selected(['NEST', 'Nest']);
        assert.equal(shouldStartRunKeyLogging({ runKind: 'single', keyPopCount: 3, selectedDungeons: nest }), true);
        assert.equal(shouldStartRunKeyLogging({ runKind: 'single', keyPopCount: 0, selectedDungeons: nest }), false);
        assert.equal(shouldStartRunKeyLogging({
            runKind: 'realm_clearing',
            keyPopCount: 3,
            selectedDungeons: selected(['REALM_DUNGEON', 'Realm Clearing']),
        }), false);
        assert.equal(shouldStartRunKeyLogging({ runKind: 'oryx_3', keyPopCount: 3, selectedDungeons: nest }), false);
    });
});

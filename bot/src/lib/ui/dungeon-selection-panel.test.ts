import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDungeonSelectionSuccessState } from './dungeon-selection-panel.js';

describe('run selector completion state', () => {
    it('removes all selector UI only after receiving a published Discord message URL', () => {
        const runUrl = 'https://discord.com/channels/100/200/300';

        assert.deepEqual(buildDungeonSelectionSuccessState(runUrl), {
            content: `Run created and posted: [Jump to run](${runUrl})`,
            components: [],
            embeds: [],
        });
    });

    it('cannot display selector success for a failed or unpublished run', () => {
        assert.throws(
            () => buildDungeonSelectionSuccessState(''),
            /before a published Discord run message exists/i
        );
    });
});

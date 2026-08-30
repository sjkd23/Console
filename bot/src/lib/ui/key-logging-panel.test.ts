import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildKeyLoggingPanel, type KeyLoggingState } from './key-logging-panel.js';

function state(overrides: Partial<KeyLoggingState> = {}): KeyLoggingState {
    return {
        runId: 42,
        organizerId: '1',
        dungeonLabel: 'Nest | Fungal Cavern',
        enteredCount: 3,
        remainingKeys: 2,
        runBoundAllowance: true,
        loggableDungeons: [
            { dungeonKey: 'NEST', dungeonLabel: 'Nest' },
            { dungeonKey: 'FUNGAL_CAVERN', dungeonLabel: 'Fungal Cavern' },
        ],
        selectedDungeonKey: null,
        keyReactionUsers: ['2'],
        keyReactionUsersByDungeon: { NEST: ['2'], FUNGAL_CAVERN: [] },
        userDisplayNames: new Map([['2', 'Raider']]),
        logs: [{
            userId: '2',
            username: 'Raider',
            amount: 1,
            pointsAwarded: 5,
            dungeonKey: 'NEST',
            dungeonLabel: 'Nest',
        }],
        ...overrides,
    };
}

describe('post-run key logging panel', () => {
    it('shows the entered-count allowance and allows finishing with unused slots', () => {
        const panel = buildKeyLoggingPanel(state());
        const description = panel.embed.toJSON().description ?? '';
        assert.match(description, /Dungeon Entries:\*\* 3/);
        assert.match(description, /Keys Logged:\*\* 1/);
        assert.match(description, /Remaining Possible Key Logs:\*\* 2/);
        const components = panel.components.flatMap(row => row.components.map(component => component.toJSON()));
        const finish = components.find(component => 'custom_id' in component && component.custom_id === 'keylog:cancel:42');
        assert.ok(finish && 'label' in finish);
        assert.equal(finish.label, 'Finish Key Logging');
    });

    it('requires an explicit physical dungeon choice for multi-run logs', () => {
        const panel = buildKeyLoggingPanel(state());
        const components = panel.components.flatMap(row => row.components.map(component => component.toJSON()));
        const dungeonSelect = components.find(component =>
            'custom_id' in component && component.custom_id === 'keylog:selectdungeon:42'
        );
        assert.ok(dungeonSelect && 'options' in dungeonSelect);
        assert.deepEqual(dungeonSelect.options.map(option => option.value), ['NEST', 'FUNGAL_CAVERN']);
        const customName = components.find(component =>
            'custom_id' in component && component.custom_id === 'keylog:custom:42'
        );
        assert.ok(customName && 'disabled' in customName);
        assert.equal(customName.disabled, true);
    });

    it('uses normal hyphens in Phase D key logging presentation', () => {
        const panel = buildKeyLoggingPanel(state());
        const serialized = JSON.stringify({
            embed: panel.embed.toJSON(),
            components: panel.components.map(row => row.toJSON()),
        });
        assert.match(serialized, /Log Keys - Nest \| Fungal Cavern/);
        assert.match(serialized, /<@2> - 1 Nest key/);
        assert.equal(serialized.includes('—'), false);
    });
});

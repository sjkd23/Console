import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildRunMessageContent,
    buildRunLifecycleMessageContent,
    buildRunMessageContentEdit,
} from './run-message-helpers.js';
import { shouldRefreshRunPublicMessage } from './run-public-panel-updater.js';

const oneDungeon = [{ dungeonLabel: 'The Nest' }];
const multiDungeons = [
    { dungeonLabel: 'The Nest' },
    { dungeonLabel: 'Fungal Cavern' },
    { dungeonLabel: 'Steamworks' },
];

describe('public run message content', () => {
    it('puts one role before one dungeon name', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: oneDungeon,
            additionalPingRoleIds: ['123'],
        }), '@here <@&123> - The Nest');
    });

    it('keeps one dungeon name present without a configured role', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: oneDungeon,
        }), '@here - The Nest');
    });

    it('puts deduplicated roles before ordered multi-dungeon names', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: multiDungeons,
            additionalPingRoleIds: ['123', '456', '123'],
        }), '@here <@&123> <@&456> - The Nest | Fungal Cavern | Steamworks');
    });

    it('keeps all ordered multi-dungeon names present without configured roles', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: multiDungeons,
        }), '@here - The Nest | Fungal Cavern | Steamworks');
    });

    it('uses only dungeon names when a message intentionally has no mentions', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: multiDungeons,
            includeHere: false,
        }), 'The Nest | Fungal Cavern | Steamworks');
    });

    it('places existing party/location formatting on the second line', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: multiDungeons,
            party: 'North',
            location: 'USWest4',
        }), '@here - The Nest | Fungal Cavern | Steamworks\nParty: **North** | Location: **USWest4**');
    });

    it('preserves O3 closed-location hiding on the second line', () => {
        assert.equal(buildRunMessageContent({
            selectedDungeons: [{ dungeonLabel: 'Oryx 3' }],
            party: 'Hidden Party',
            location: 'Hidden Location',
            o3Stage: 'closed',
        }), '@here - Oryx 3\n🔒 **REALM CLOSED** 🔒');
    });

    it('suppresses mention parsing when public content is rebuilt by an edit', () => {
        assert.deepEqual(buildRunMessageContentEdit('@here <@&123> - The Nest'), {
            content: '@here <@&123> - The Nest',
            allowedMentions: { parse: [] },
        });
    });

    it('includes party/location in initial lifecycle publication', () => {
        assert.equal(buildRunLifecycleMessageContent({
            selectedDungeons: oneDungeon,
            party: 'North',
            location: 'USWest4',
        }, { additionalPingRoleIds: ['123'] }),
        '@here <@&123> - The Nest\nParty: **North** | Location: **USWest4**');
    });

    it('allows open-state refresh and preserves party/location without repinging', () => {
        assert.equal(shouldRefreshRunPublicMessage('open'), true);
        const content = buildRunLifecycleMessageContent({
            selectedDungeons: oneDungeon,
            party: 'South',
            location: 'USEast',
        });
        assert.deepEqual(buildRunMessageContentEdit(content), {
            content: '@here - The Nest\nParty: **South** | Location: **USEast**',
            allowedMentions: { parse: [] },
        });
    });

    it('preserves party/location for manual and scheduled end content', () => {
        const ended = buildRunLifecycleMessageContent({
            selectedDungeons: multiDungeons,
            party: 'North',
            location: 'USWest4',
        }, { includeHere: false });
        assert.equal(ended, 'The Nest | Fungal Cavern | Steamworks\nParty: **North** | Location: **USWest4**');
        assert.deepEqual(buildRunMessageContentEdit(ended).allowedMentions, { parse: [] });
    });

    it('keeps hidden O3 location rules through lifecycle transitions', () => {
        assert.equal(buildRunLifecycleMessageContent({
            selectedDungeons: [{ dungeonLabel: 'Oryx 3' }],
            party: 'Secret',
            location: 'Hidden',
            o3Stage: 'closed',
        }, { includeHere: false }), 'Oryx 3\n🔒 **REALM CLOSED** 🔒');
    });
});

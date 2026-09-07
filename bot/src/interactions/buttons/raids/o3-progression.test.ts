import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { ButtonInteraction } from 'discord.js';

const events: string[] = [];

mock.module('../../../lib/utilities/http.js', {
    namedExports: {
        patchJSON: async () => {
            events.push('persist-closed');
            return { ok: true };
        },
        getRunDetails: async () => ({
            runKind: 'oryx_3',
            status: 'live',
            o3Stage: 'closed',
            activeRunsMessageId: 'active-runs-message-id',
        }),
    },
});

mock.module('../../../lib/utilities/o3-progression.js', {
    namedExports: {
        sendO3ProgressionPing: async () => {
            events.push('send-ping');
            return 'ping-message-id';
        },
    },
});

mock.module('./organizer-panel.js', {
    namedExports: {
        refreshOrganizerPanel: async () => {
            events.push('refresh-organizer-panel');
        },
    },
});

mock.module('../../../lib/utilities/run-public-panel-updater.js', {
    namedExports: {
        updateRunPublicPanelContent: async () => {
            events.push('refresh-public-and-active-runs');
        },
    },
});

const { handleRealmClosed } = await import('./o3-progression.js');

describe('Oryx 3 realm closure synchronization', () => {
    it('persists closure before refreshing the public and active-runs messages', async () => {
        events.length = 0;
        const interaction = {
            deferUpdate: async () => undefined,
            guildId: '100000000000000001',
            guild: {},
            client: {},
            user: { id: '100000000000000002' },
        } as unknown as ButtonInteraction;

        await handleRealmClosed(interaction, '42');

        assert.deepEqual(events, [
            'persist-closed',
            'refresh-public-and-active-runs',
            'send-ping',
            'refresh-organizer-panel',
        ]);
    });
});

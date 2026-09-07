import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ChannelType, EmbedBuilder, type ButtonInteraction, type Client } from 'discord.js';

const guildId = '100000000000000001';
const raidChannelId = '100000000000000002';
const activeRunsChannelId = '100000000000000003';
const raidMessageId = '100000000000000004';
const activeRunsMessageId = '100000000000000005';
const runId = 42;

let o3Stage: 'closed' | null = null;
const backendReads: Array<'closed' | null> = [];
const activeRunsEdits: unknown[] = [];
const publicRunEdits: unknown[] = [];

function runDetails() {
    backendReads.push(o3Stage);
    return {
        id: runId,
        status: 'live' as const,
        runKind: 'oryx_3' as const,
        selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
        organizerId: '100000000000000006',
        party: '3/4',
        location: 'USWest',
        o3Stage,
        channelId: raidChannelId,
        postMessageId: raidMessageId,
        activeRunsChannelId,
        activeRunsMessageId,
        joinLocked: false,
        roleId: null,
    };
}

mock.module('../../../lib/utilities/http.js', {
    namedExports: {
        patchJSON: async () => {
            o3Stage = 'closed';
            return { ok: true };
        },
        getRunDetails: async () => runDetails(),
        getGuildChannels: async () => ({ channels: { active_runs: activeRunsChannelId } }),
        getActiveRunsSync: async () => ({ runs: [{ id: runId, guildId }] }),
        setActiveRunsMessage: async () => ({ ok: true as const }),
        getDungeonRolePings: async () => ({ dungeon_role_pings: {} }),
    },
});

mock.module('../../../lib/utilities/o3-progression.js', {
    namedExports: {
        sendO3ProgressionPing: async () => 'ping-message-id',
    },
});

mock.module('./organizer-panel.js', {
    namedExports: {
        refreshOrganizerPanel: async () => undefined,
    },
});

const publicMessage = {
    url: `https://discord.com/channels/${guildId}/${raidChannelId}/${raidMessageId}`,
    embeds: [new EmbedBuilder().setTitle('🟢 LIVE: Oryx 3').setDescription('Organizer')],
    edit: async (payload: unknown) => {
        publicRunEdits.push(payload);
        return publicMessage;
    },
};

const activeRunsMessage = {
    edit: async (payload: unknown) => {
        activeRunsEdits.push(payload);
        return activeRunsMessage;
    },
};

function textChannel(channelId: string) {
    return {
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isDMBased: () => false,
        messages: {
            fetch: async (messageId: string) => {
                if (channelId === raidChannelId && messageId === raidMessageId) return publicMessage;
                if (channelId === activeRunsChannelId && messageId === activeRunsMessageId) return activeRunsMessage;
                return null;
            },
        },
    };
}

const client = {
    channels: { fetch: async (channelId: string) => textChannel(channelId) },
    guilds: {
        cache: new Map(),
        fetch: async () => null,
    },
} as unknown as Client;

const { handleRealmClosed } = await import('./o3-progression.js');
const { syncActiveRunsMirror } = await import('../../../lib/utilities/active-runs-mirror.js');

describe('Oryx 3 Realm Closed production refresh chain', () => {
    it('persists first, refetches closed state, and edits the same Active Runs mirror without a stale overwrite', async () => {
        o3Stage = null;
        backendReads.length = 0;
        activeRunsEdits.length = 0;
        publicRunEdits.length = 0;
        const interaction = {
            deferUpdate: async () => undefined,
            guildId,
            guild: {},
            client,
            user: { id: '100000000000000007' },
        } as unknown as ButtonInteraction;

        await handleRealmClosed(interaction, String(runId));

        // Simulate a later canonical reconciliation. It must refetch the persisted
        // stage and may only reapply Closed, never overwrite it with stale LIVE state.
        await syncActiveRunsMirror(client, guildId, runId);

        assert.ok(backendReads.length >= 4);
        assert.deepEqual(new Set(backendReads), new Set(['closed']));
        assert.equal(activeRunsEdits.length, 2);
        assert.equal(publicRunEdits.length, 1);

        for (const activeRunsEdit of activeRunsEdits) {
            const edit = activeRunsEdit as { embeds?: EmbedBuilder[] };
            const rendered = edit.embeds?.[0]?.toJSON();
            const fieldNames = rendered?.fields?.map(field => field.name) ?? [];
            assert.match(rendered?.title ?? '', /Closed: Oryx 3/);
            assert.equal(fieldNames.includes('Party'), false);
            assert.equal(fieldNames.includes('Location'), false);
            assert.equal(fieldNames.includes('Status'), false);
        }
    });
});

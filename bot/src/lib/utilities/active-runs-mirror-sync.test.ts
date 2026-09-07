import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ChannelType, type Client } from 'discord.js';

interface TestRun {
    id: number;
    status: 'open' | 'live' | 'ended';
    channelId: string;
    postMessageId: string;
    activeRunsChannelId: string | null;
    activeRunsMessageId: string | null;
    dungeonKey: string;
    dungeonLabel: string;
    runKind: 'single' | 'oryx_3';
    selectedDungeons: Array<{ dungeonKey: string; dungeonLabel: string; selectionOrder: number }>;
    organizerId: string;
    party: string;
    location: string;
    o3Stage: 'closed' | 'miniboss' | 'third_room' | null;
}

const guildId = '100000000000000001';
const raidChannelId = '100000000000000002';
const activeChannelId = '100000000000000003';
const oldActiveChannelId = '100000000000000004';
const raidMessageId = '100000000000000005';
const mirrorMessageId = '100000000000000006';
const organizerId = '100000000000000007';

let run: TestRun;
let configuredChannelId: string | null;
let mirrorExists: boolean;
let sends: unknown[];
let edits: unknown[];
let deletes: string[];
let persistence: Array<{ channelId: string; messageId: string } | null>;

function reset(options: {
    status?: TestRun['status'];
    activeRunsChannelId?: string | null;
    activeRunsMessageId?: string | null;
    configuredChannelId?: string | null;
    mirrorExists?: boolean;
    runKind?: TestRun['runKind'];
    o3Stage?: TestRun['o3Stage'];
} = {}): void {
    run = {
        id: 42,
        status: options.status ?? 'open',
        channelId: raidChannelId,
        postMessageId: raidMessageId,
        activeRunsChannelId: options.activeRunsChannelId ?? null,
        activeRunsMessageId: options.activeRunsMessageId ?? null,
        dungeonKey: 'NEST',
        dungeonLabel: 'The Nest',
        runKind: options.runKind ?? 'single',
        selectedDungeons: options.runKind === 'oryx_3'
            ? [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }]
            : [{ dungeonKey: 'NEST', dungeonLabel: 'The Nest', selectionOrder: 1 }],
        organizerId,
        party: '2',
        location: 'USWest',
        o3Stage: options.o3Stage ?? null,
    };
    configuredChannelId = options.configuredChannelId === undefined
        ? activeChannelId
        : options.configuredChannelId;
    mirrorExists = options.mirrorExists ?? false;
    sends = [];
    edits = [];
    deletes = [];
    persistence = [];
}

mock.module('./http.js', {
    namedExports: {
        getRunDetails: async () => ({ ...run }),
        getGuildChannels: async () => ({ channels: { active_runs: configuredChannelId } }),
        getActiveRunsSync: async () => ({ runs: [{ id: run.id, guildId }] }),
        setActiveRunsMessage: async (
            _runId: number | string,
            _guildId: string,
            message: { channelId: string; messageId: string } | null
        ) => {
            persistence.push(message);
            run.activeRunsChannelId = message?.channelId ?? null;
            run.activeRunsMessageId = message?.messageId ?? null;
            return { ok: true as const };
        },
    },
});

const mirrorMessage = {
    deletable: true,
    edit: async (payload: unknown) => { edits.push(payload); },
    delete: async () => {
        mirrorExists = false;
        deletes.push('mirror');
    },
};

function textChannel(channelId: string) {
    return {
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isDMBased: () => false,
        messages: {
            fetch: async (messageId: string) => {
                if (channelId === raidChannelId && messageId === raidMessageId) {
                    return { url: `https://discord.com/channels/${guildId}/${raidChannelId}/${raidMessageId}` };
                }
                return mirrorExists && messageId === run.activeRunsMessageId ? mirrorMessage : null;
            },
        },
        send: async (payload: unknown) => {
            sends.push(payload);
            mirrorExists = true;
            return {
                id: mirrorMessageId,
                channelId,
                delete: async () => { mirrorExists = false; },
            };
        },
    };
}

const client = {
    channels: {
        fetch: async (channelId: string) => textChannel(channelId),
    },
} as unknown as Client;

const { syncActiveRunsMirror } = await import('./active-runs-mirror.js');

describe('Active Runs mirror synchronization', () => {
    it('creates one Starting Soon mirror and reuses it for the LIVE transition', async () => {
        reset();
        await syncActiveRunsMirror(client, guildId, run.id);

        assert.equal(sends.length, 1);
        assert.deepEqual(persistence, [{ channelId: activeChannelId, messageId: mirrorMessageId }]);
        assert.doesNotMatch(JSON.stringify(sends[0]), /@here|<@&/);

        run.status = 'live';
        await syncActiveRunsMirror(client, guildId, run.id);

        assert.equal(sends.length, 1);
        assert.equal(edits.length, 1);
        assert.match(JSON.stringify(edits[0]), /LIVE/);
    });

    it('edits a live Oryx 3 mirror to Closed and removes persisted party and location after realm closure', async () => {
        reset({
            status: 'live',
            runKind: 'oryx_3',
            activeRunsChannelId: activeChannelId,
            activeRunsMessageId: mirrorMessageId,
            mirrorExists: true,
        });

        await syncActiveRunsMirror(client, guildId, run.id);
        const livePayload = edits.at(-1) as { embeds?: Array<{ toJSON(): { fields?: Array<{ name: string }> } }> };
        const liveEdit = JSON.stringify(livePayload);
        const liveFieldNames = livePayload.embeds?.[0]?.toJSON().fields?.map(field => field.name) ?? [];
        assert.match(liveEdit, /LIVE/);
        assert.match(liveEdit, /Party/);
        assert.match(liveEdit, /Location/);
        assert.equal(liveFieldNames.includes('Status'), false);

        run.o3Stage = 'closed';
        await syncActiveRunsMirror(client, guildId, run.id);
        const closedPayload = edits.at(-1) as { embeds?: Array<{ toJSON(): { fields?: Array<{ name: string }> } }> };
        const closedEdit = JSON.stringify(closedPayload);
        const closedFieldNames = closedPayload.embeds?.[0]?.toJSON().fields?.map(field => field.name) ?? [];

        assert.equal(sends.length, 0);
        assert.match(closedEdit, /Closed/);
        assert.doesNotMatch(closedEdit, /Party|Location|USWest/);
        assert.equal(closedFieldNames.includes('Status'), false);
    });

    it('recreates a manually deleted mirror without duplicating an existing message', async () => {
        reset({
            activeRunsChannelId: activeChannelId,
            activeRunsMessageId: mirrorMessageId,
            mirrorExists: false,
        });

        await syncActiveRunsMirror(client, guildId, run.id);

        assert.equal(sends.length, 1);
        assert.deepEqual(persistence, [null, { channelId: activeChannelId, messageId: mirrorMessageId }]);
    });

    it('moves an active mirror when the configured channel changes', async () => {
        reset({
            activeRunsChannelId: oldActiveChannelId,
            activeRunsMessageId: mirrorMessageId,
            configuredChannelId: activeChannelId,
            mirrorExists: true,
        });

        await syncActiveRunsMirror(client, guildId, run.id);

        assert.deepEqual(deletes, ['mirror']);
        assert.equal(sends.length, 1);
        assert.deepEqual(persistence, [null, { channelId: activeChannelId, messageId: mirrorMessageId }]);
    });

    it('removes and clears terminal mirrors, including already-deleted messages', async () => {
        reset({
            status: 'ended',
            activeRunsChannelId: activeChannelId,
            activeRunsMessageId: mirrorMessageId,
            mirrorExists: true,
        });
        await syncActiveRunsMirror(client, guildId, run.id);
        assert.deepEqual(deletes, ['mirror']);
        assert.deepEqual(persistence, [null]);

        reset({
            status: 'ended',
            activeRunsChannelId: activeChannelId,
            activeRunsMessageId: mirrorMessageId,
            mirrorExists: false,
        });
        await syncActiveRunsMirror(client, guildId, run.id);
        assert.deepEqual(deletes, []);
        assert.deepEqual(persistence, [null]);
    });

    it('does nothing when no Active Runs channel is configured', async () => {
        reset({ configuredChannelId: null });
        await syncActiveRunsMirror(client, guildId, run.id);
        assert.equal(sends.length, 0);
        assert.deepEqual(persistence, []);
    });
});

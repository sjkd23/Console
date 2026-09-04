import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { ChannelType, type ButtonInteraction } from 'discord.js';

const guildId = '100000000000000001';
const organizerId = '100000000000000002';
let duplicate = false;
let chainCalls: unknown[] = [];
let publishedRunIds: number[] = [];
let initializedRunIds: number[] = [];
let organizerPanelRunIds: number[] = [];
let deletedRoleIds: string[] = [];
let sequence: string[] = [];

class TestBackendError extends Error {
    code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.code = code;
    }
}

const previousRun = {
    id: 100,
    runKind: 'oryx_3' as const,
    status: 'ended' as const,
    finalizationKind: 'completed' as const,
    organizerId,
};

const newRun = {
    id: 101,
    channelId: '100000000000000004',
    description: 'Bring maxed characters',
    party: '2',
    location: 'USWest',
};

const created = {
    runId: 101,
    dungeonKey: 'ORYX_3',
    dungeonLabel: 'Oryx 3',
    runKind: 'oryx_3' as const,
    activityKey: 'ORYX_3',
    selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
};

mock.module('../../../lib/utilities/http.js', {
    namedExports: {
        BackendError: TestBackendError,
        getRunDetails: async (runId: string | number) => Number(runId) === 100 ? previousRun : newRun,
        chainOryx3Run: async (...args: unknown[]) => {
            chainCalls.push(args);
            if (duplicate) throw new TestBackendError('Already chained', 'O3_ALREADY_CHAINED');
            return created;
        },
        deleteJSON: async () => ({}),
    },
});

mock.module('../../../lib/permissions/interaction-permissions.js', {
    namedExports: { checkOrganizerAccess: async () => ({ allowed: true, isOriginalOrganizer: true }) },
});

mock.module('../../../lib/permissions/permissions.js', {
    namedExports: { getMemberRoleIds: () => ['100000000000000010'] },
});

mock.module('../../../lib/utilities/run-role-manager.js', {
    namedExports: {
        createRunRole: async () => ({ id: '100000000000000005' }),
        deleteRunRole: async (_guild: unknown, roleId: string) => {
            deletedRoleIds.push(roleId);
            return true;
        },
    },
});

mock.module('../../../lib/utilities/button-mutex.js', {
    namedExports: {
        getRunLockKey: (action: string, runId: string) => `run:${action}:${runId}`,
        withButtonLock: async (_btn: unknown, _key: string, work: () => Promise<void>) => {
            await work();
            return true;
        },
    },
});

mock.module('../../../lib/utilities/organizer-activity-checker.js', {
    namedExports: {
        checkOrganizerActiveActivities: async () => ({
            hasActiveRun: false,
            hasActiveHeadcount: false,
            errorMessage: null,
        }),
    },
});

mock.module('../../../lib/utilities/run-publication.js', {
    namedExports: {
        publishCreatedRun: async (options: { created: { runId: number } }) => {
            publishedRunIds.push(options.created.runId);
            sequence.push('publish');
            return {
                id: '100000000000000006',
                channelId: newRun.channelId,
                url: 'https://discord.test/new-o3',
            };
        },
        initializePublishedRun: (options: { created: { runId: number } }) => {
            initializedRunIds.push(options.created.runId);
            sequence.push('initialize');
        },
    },
});

mock.module('./organizer-panel.js', {
    namedExports: {
        sendRunOrganizerPanelAsFollowUp: async (_btn: unknown, runId: number) => {
            organizerPanelRunIds.push(runId);
            sequence.push('organizer-panel');
        },
    },
});

mock.module('../../../lib/logging/logger.js', {
    namedExports: {
        createLogger: () => ({
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        }),
    },
});

const { handleStartNewO3 } = await import('./o3-chain.js');

beforeEach(() => {
    duplicate = false;
    chainCalls = [];
    publishedRunIds = [];
    initializedRunIds = [];
    organizerPanelRunIds = [];
    deletedRoleIds = [];
    sequence = [];
});

function createInteraction(): { interaction: ButtonInteraction; edits: unknown[] } {
    const edits: unknown[] = [];
    const member = {
        user: { username: 'Organizer' },
        roles: { cache: new Map() },
    };
    const channel = { type: ChannelType.GuildText };
    return {
        interaction: {
            guildId,
            guild: {
                id: guildId,
                name: 'Guill 2.0',
                members: { fetch: async () => member },
            },
            user: { id: organizerId, username: 'Organizer' },
            client: { channels: { fetch: async () => channel } },
            deferUpdate: async () => undefined,
            editReply: async (payload: unknown) => { edits.push(payload); },
        } as unknown as ButtonInteraction,
        edits,
    };
}

describe('Start New O3 interaction', () => {
    it('publishes and opens the organizer panel for the new backend run ID', async () => {
        const { interaction, edits } = createInteraction();
        await handleStartNewO3(interaction, '100');

        assert.equal(chainCalls.length, 1);
        assert.deepEqual(publishedRunIds, [101]);
        assert.deepEqual(initializedRunIds, [101]);
        assert.deepEqual(organizerPanelRunIds, [101]);
        assert.ok(sequence.indexOf('publish') < sequence.indexOf('organizer-panel'));
        assert.match(JSON.stringify(edits), /new Oryx 3/i);
        assert.equal(previousRun.status, 'ended');
    });

    it('handles a repeated chaining action safely without publishing again', async () => {
        duplicate = true;
        const { interaction, edits } = createInteraction();
        await handleStartNewO3(interaction, '100');

        assert.equal(chainCalls.length, 1);
        assert.deepEqual(publishedRunIds, []);
        assert.deepEqual(initializedRunIds, []);
        assert.deepEqual(organizerPanelRunIds, []);
        assert.deepEqual(deletedRoleIds, ['100000000000000005']);
        assert.match(JSON.stringify(edits), /already been created/i);
    });
});

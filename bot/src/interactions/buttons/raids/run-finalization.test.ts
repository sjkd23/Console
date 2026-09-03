import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ChannelType } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

interface RunFixture {
    channelId: string;
    postMessageId: string;
    dungeonKey: string;
    dungeonLabel: string;
    organizerId: string;
    runKind: 'single' | 'oryx_3';
    selectedDungeons: Array<{
        dungeonKey: string;
        dungeonLabel: string;
        selectionOrder: number;
    }>;
    status: 'live';
    startedAt: string;
    endedAt: null;
    createdAt: string;
    autoEndMinutes: number;
    keyWindowEndsAt: null;
    party: string;
    location: string;
    description: null;
    roleId: null;
    pingMessageId: null;
    keyPopCount: number;
    chainAmount: null;
}

interface BackendCall {
    path: string;
    body: unknown;
}

const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const runId = '42';
let activeRun: RunFixture;
let backendPatchCalls: BackendCall[] = [];
let backendPostCalls: BackendCall[] = [];
let keyPanelCalls = 0;
let cleanupCalls = 0;
let quotaRefreshCalls = 0;
let statusLogCalls = 0;
let threadEndTimeCalls = 0;
let clearedPanelCalls = 0;
let reactionCleanupCalls = 0;

class TestBackendError extends Error {
    code?: string;
}

mock.module('../../../lib/utilities/http.js', {
    namedExports: {
        BackendError: TestBackendError,
        getRunDetails: async () => activeRun,
        patchJSON: async (path: string, body: unknown) => {
            backendPatchCalls.push({ path, body });
            return { ok: true, status: 'ended', organizerMinuteSettlement: null };
        },
        postJSON: async (path: string, body: unknown) => {
            backendPostCalls.push({ path, body });
            if (path === '/quota/log-key') {
                return {
                    logged: 1,
                    new_total: 1,
                    points_awarded: 0,
                    user_id: '100000000000000003',
                };
            }
            return {};
        },
        deleteJSON: async () => ({}),
        getRolePositions: () => ({}),
    },
});

mock.module('../../../lib/permissions/permissions.js', {
    namedExports: {
        getMemberRoleIds: () => ['100000000000000010'],
    },
});

mock.module('../../../lib/permissions/interaction-permissions.js', {
    namedExports: {
        checkOrganizerAccess: async () => ({ allowed: true, isOriginalOrganizer: true }),
    },
});

mock.module('../../../lib/logging/raid-logger.js', {
    namedExports: {
        logRunStatusChange: async () => { statusLogCalls += 1; },
        clearLogThreadCache: () => { cleanupCalls += 1; },
        updateThreadStarterWithEndTime: async () => { threadEndTimeCalls += 1; },
    },
});

mock.module('../../../lib/utilities/run-role-manager.js', {
    namedExports: { deleteRunRole: async () => true },
});

mock.module('../../../lib/utilities/run-ping.js', {
    namedExports: { sendRunPing: async () => 'ping-message' },
});

mock.module('../../../lib/utilities/button-mutex.js', {
    namedExports: {
        getRunLockKey: (status: string, id: string) => `run:${status}:${id}`,
        withButtonLock: async (_interaction: unknown, _key: string, work: () => Promise<void>) => {
            await work();
            return true;
        },
    },
});

mock.module('../../../lib/logging/logger.js', {
    namedExports: {
        createLogger: () => ({
            debug: (..._args: unknown[]) => undefined,
            info: (..._args: unknown[]) => undefined,
            warn: (..._args: unknown[]) => undefined,
            error: (..._args: unknown[]) => undefined,
        }),
    },
});

mock.module('../../../lib/utilities/run-reactions.js', {
    namedExports: {
        clearRunReactions: async () => { reactionCleanupCalls += 1; },
    },
});

mock.module('../../../lib/ui/quota-panel.js', {
    namedExports: {
        updateQuotaPanelsForUser: async () => { quotaRefreshCalls += 1; },
    },
});

mock.module('./organizer-panel.js', {
    namedExports: { refreshOrganizerPanel: async () => undefined },
});

mock.module('../../../lib/state/organizer-panel-tracker.js', {
    namedExports: {
        clearOrganizerPanelsForRun: () => { clearedPanelCalls += 1; },
    },
});

mock.module('../../../lib/utilities/run-panel-builder.js', {
    namedExports: { transitionRunEmbed: () => ({ title: 'Run Ended' }) },
});

mock.module('../../../lib/utilities/dungeon-role-pings.js', {
    namedExports: { resolveDungeonRolePingIds: async () => [] },
});

mock.module('../../../lib/utilities/run-message-helpers.js', {
    namedExports: {
        buildRunLifecycleMessageContent: () => 'Run ended',
        buildRunMessageContentEdit: (content: string) => ({ content }),
    },
});

mock.module('../../../lib/utilities/organizer-start-context.js', {
    namedExports: { fetchOrganizerStartContext: async () => ({}) },
});

mock.module('../../../lib/utilities/organizer-minute-settlement-contract.js', {
    namedExports: {
        EndRunResponseSchema: {
            parse: (value: unknown) => value,
        },
    },
});

mock.module('../../../lib/ui/organizer-minute-settlement.js', {
    namedExports: {
        buildMinuteSettlementMessage: () => ({}),
        sendMinuteRecordDm: async () => undefined,
    },
});

mock.module('./key-logging.js', {
    namedExports: {
        showKeyLoggingPanel: async () => { keyPanelCalls += 1; },
    },
});

mock.module('../../../lib/logging/bot-logger.js', {
    namedExports: { logCommandExecution: async () => undefined },
});

const { buildPostRunComponents, handleStatus } = await import('./run-status.js');
const { logkey } = await import('../../../commands/organizer/logkey.js');

function runFixture(dungeonKey: string, dungeonLabel: string, runKind: 'single' | 'oryx_3', keyPopCount: number): RunFixture {
    return {
        channelId: '100000000000000004',
        postMessageId: '100000000000000005',
        dungeonKey,
        dungeonLabel,
        organizerId,
        runKind,
        selectedDungeons: [{ dungeonKey, dungeonLabel, selectionOrder: 1 }],
        status: 'live',
        startedAt: '2026-09-03T21:00:00.000Z',
        endedAt: null,
        createdAt: '2026-09-03T20:55:00.000Z',
        autoEndMinutes: 120,
        keyWindowEndsAt: null,
        party: '1',
        location: 'USWest',
        description: null,
        roleId: null,
        pingMessageId: null,
        keyPopCount,
        chainAmount: null,
    };
}

function resetCaptures(): void {
    backendPatchCalls = [];
    backendPostCalls = [];
    keyPanelCalls = 0;
    cleanupCalls = 0;
    quotaRefreshCalls = 0;
    statusLogCalls = 0;
    threadEndTimeCalls = 0;
    clearedPanelCalls = 0;
    reactionCleanupCalls = 0;
}

function createEndInteraction() {
    const editReplies: unknown[] = [];
    const followUps: unknown[] = [];
    const publicEdits: unknown[] = [];
    const member = {
        permissions: { has: () => true },
        roles: { cache: new Map<string, { id: string; position: number }>() },
        guild: { id: guildId },
    };
    const publicMessage = {
        id: activeRun.postMessageId,
        channelId: activeRun.channelId,
        embeds: [{ title: 'Live Run' }],
        edit: async (payload: unknown) => { publicEdits.push(payload); },
    };
    const channel = {
        type: ChannelType.GuildText,
        messages: { fetch: async () => publicMessage },
    };
    const client = {
        channels: { fetch: async () => channel },
    };
    const guild = {
        id: guildId,
        members: { fetch: async () => member },
    };
    const interaction = {
        customId: `run:end:${runId}`,
        guildId,
        guild,
        user: { id: organizerId },
        client,
        deferUpdate: async () => undefined,
        editReply: async (payload: unknown) => { editReplies.push(payload); },
        followUp: async (payload: unknown) => { followUps.push(payload); },
    } as unknown as ButtonInteraction;

    return { interaction, editReplies, followUps, publicEdits };
}

function assertNoKeyLoggingPayload(payloads: unknown[]): void {
    const serialized = JSON.stringify(payloads);
    assert.doesNotMatch(serialized, /keylog:/i);
    assert.doesNotMatch(serialized, /log keys|key logging/i);
}

describe('normal run End interaction', () => {
    for (const testCase of [
        { dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', runKind: 'oryx_3' as const, keyPopCount: 0 },
        { dungeonKey: 'LOST_HALLS', dungeonLabel: 'Lost Halls', runKind: 'single' as const, keyPopCount: 1 },
    ]) {
        it(`ends ${testCase.dungeonLabel} without showing key logging UI`, async () => {
            resetCaptures();
            activeRun = runFixture(
                testCase.dungeonKey,
                testCase.dungeonLabel,
                testCase.runKind,
                testCase.keyPopCount
            );
            const { interaction, editReplies, followUps, publicEdits } = createEndInteraction();

            await handleStatus(interaction, runId, 'ended');

            assert.equal(backendPatchCalls.length, 1);
            assert.equal(backendPatchCalls[0].path, `/runs/${runId}`);
            assert.equal((backendPatchCalls[0].body as Record<string, unknown>).status, 'ended');
            assert.equal(keyPanelCalls, 0);
            assert.equal(cleanupCalls, 1);
            assert.equal(quotaRefreshCalls, 1);
            assert.equal(statusLogCalls, 1);
            assert.equal(threadEndTimeCalls, 1);
            assert.equal(clearedPanelCalls, 1);
            assert.equal(reactionCleanupCalls, 1);
            assert.equal(editReplies.length, 1);
            assertNoKeyLoggingPayload([...editReplies, ...followUps, ...publicEdits]);
            const closurePayload = JSON.stringify(editReplies[0]);
            if (testCase.runKind === 'oryx_3') {
                assert.match(closurePayload, /run:chaino3:42/);
                assert.match(closurePayload, /Start New O3/);
                assert.match(closurePayload, /run:finish:42/);
            } else {
                assert.doesNotMatch(closurePayload, /chaino3|Start New O3/);
            }
        });
    }
});

describe('post-run O3 chaining visibility', () => {
    it('is shown only after a successful O3 End', () => {
        assert.equal(buildPostRunComponents('42', 'oryx_3', 'ended').length, 1);
        assert.equal(buildPostRunComponents('42', 'oryx_3', 'cancelled').length, 0);
        assert.equal(buildPostRunComponents('42', 'single', 'ended').length, 0);
        assert.equal(buildPostRunComponents('42', 'multi_exalt', 'ended').length, 0);
        assert.equal(buildPostRunComponents('42', 'realm_clearing', 'ended').length, 0);
    });
});

describe('/logkey manual command', () => {
    it('still logs a key independently through the manual backend endpoint', async () => {
        resetCaptures();
        const editReplies: unknown[] = [];
        const member = {
            roles: { cache: new Map<string, { id: string; position: number }>() },
        };
        const guild = {
            id: guildId,
            members: { fetch: async () => member },
        };
        const interaction = {
            guildId,
            guild,
            user: { id: organizerId, username: 'Organizer' },
            client: {},
            options: {
                getUser: () => ({ id: '100000000000000003', username: 'KeyPopper' }),
                getString: () => 'LOST_HALLS',
                getInteger: () => 1,
            },
            deferReply: async () => undefined,
            editReply: async (payload: unknown) => { editReplies.push(payload); },
            reply: async () => undefined,
        } as unknown as ChatInputCommandInteraction;

        await logkey.run(interaction);

        const manualCall = backendPostCalls.find(call => call.path === '/quota/log-key');
        assert.ok(manualCall);
        assert.equal((manualCall.body as Record<string, unknown>).dungeonKey, 'LOST_HALLS');
        assert.equal((manualCall.body as Record<string, unknown>).amount, 1);
        assert.equal(editReplies.length, 1);
        assert.match(JSON.stringify(editReplies[0]), /Key Pops Logged/);
    });
});

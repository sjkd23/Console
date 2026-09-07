import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import {
    ChannelType,
    EmbedBuilder,
    type ButtonInteraction,
    type GuildMember,
    type Message,
    type MessageCreateOptions,
} from 'discord.js';

const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const publicMessageId = '100000000000000003';
const channelId = '100000000000000004';

let selectedDungeonKey = 'SNAKE_PIT';
let configuredImage = true;
let imageSendFails = false;
let imageLookups = 0;
let deletedRunIds: number[] = [];
let sequence: string[] = [];

mock.module('../../../lib/state/headcount-state.js', {
    namedExports: {
        clearHeadcountState: () => undefined,
        getDungeonCodes: () => [selectedDungeonKey],
        getOrganizerId: () => organizerId,
    },
});

mock.module('./headcount-key.js', {
    namedExports: {
        clearKeyOffers: () => undefined,
        getKeyOffers: () => new Map(),
    },
});

mock.module('../../../lib/utilities/http.js', {
    namedExports: {
        createRun: async (payload: { selectedDungeonKeys: string[] }) => {
            const dungeonKey = payload.selectedDungeonKeys[0];
            const realmClearing = dungeonKey === 'REALM_DUNGEON';
            return {
                runId: 101,
                dungeonKey,
                dungeonLabel: realmClearing ? 'Realm Clearing' : 'Snake Pit',
                runKind: realmClearing ? 'realm_clearing' as const : 'single' as const,
                activityKey: realmClearing ? 'MISC_DUNGEONS' : dungeonKey,
                selectedDungeons: [{
                    dungeonKey,
                    dungeonLabel: realmClearing ? 'Realm Clearing' : 'Snake Pit',
                    selectionOrder: 1,
                }],
            };
        },
        deleteJSON: async (path: string) => {
            const runId = Number(path.split('/')[2]);
            deletedRunIds.push(runId);
            return {};
        },
        getDungeonImage: async () => {
            imageLookups += 1;
            return configuredImage ? {
                dungeon_key: 'SNAKE_PIT',
                image_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
                content_type: 'image/png' as const,
                filename: 'snake.png',
                updated_at: '2026-09-04T01:00:00.000Z',
            } : null;
        },
        postJSON: async () => ({}),
    },
});

mock.module('../../../lib/permissions/permissions.js', {
    namedExports: {
        getMemberRoleIds: () => ['100000000000000010'],
        hasRequiredRoleOrHigher: async () => ({ hasRole: true, userRole: 'organizer' }),
    },
});

mock.module('../../../lib/utilities/interaction-helpers.js', {
    namedExports: {
        fetchGuildMember: async () => ({
            id: organizerId,
            user: { username: 'Organizer' },
        } as GuildMember),
    },
});

mock.module('../../../lib/logging/raid-logger.js', {
    namedExports: { logRaidCreation: async () => undefined },
});

mock.module('../../../lib/permissions/interaction-permissions.js', {
    namedExports: { checkOrganizerAccess: async () => ({ allowed: true, isOriginalOrganizer: true }) },
});

mock.module('../../../lib/utilities/button-mutex.js', {
    namedExports: {
        getHeadcountLockKey: (action: string, messageId: string) => `headcount:${action}:${messageId}`,
        withButtonLock: async (_btn: unknown, _key: string, work: () => Promise<void>) => {
            await work();
            return true;
        },
    },
});

mock.module('../../../lib/state/active-headcount-tracker.js', {
    namedExports: {
        getActiveHeadcount: () => ({
            messageId: publicMessageId,
            channelId,
            createdAt: new Date(),
            autoEndAt: new Date(Date.now() + 60_000),
            dungeons: [selectedDungeonKey],
            dungeonCodes: [selectedDungeonKey],
        }),
        unregisterHeadcount: () => undefined,
        unregisterHeadcountByMessageId: () => ({ removed: true, organizerId }),
    },
});

mock.module('../../../lib/state/headcount-panel-tracker.js', {
    namedExports: { clearHeadcountPanels: () => undefined },
});

mock.module('../../../lib/state/organizer-panel-tracker.js', {
    namedExports: { registerOrganizerPanel: () => undefined },
});

mock.module('../../../lib/utilities/run-role-manager.js', {
    namedExports: {
        createRunRole: async () => ({ id: '100000000000000005' }),
        deleteRunRole: async () => true,
    },
});

mock.module('./organizer-panel.js', {
    namedExports: {
        buildRunOrganizerPanelContent: async () => ({ embeds: [], components: [] }),
    },
});

mock.module('../../../lib/utilities/auto-join-helpers.js', {
    namedExports: { autoJoinOrganizerToRun: async () => undefined },
});

mock.module('../../../lib/utilities/run-reactions.js', {
    namedExports: { addRunReactions: async () => undefined },
});

mock.module('../../../lib/utilities/early-loc-notifier.js', {
    namedExports: { sendEarlyLocNotification: async () => undefined },
});

mock.module('../../../lib/utilities/dungeon-role-pings.js', {
    namedExports: { resolveDungeonRolePingIds: async () => [] },
});

mock.module('../../../lib/utilities/run-panel-builder.js', {
    namedExports: {
        buildRunButtons: () => [],
        buildRunEmbed: () => new EmbedBuilder().setTitle('Run'),
    },
});

mock.module('./key-reaction.js', {
    namedExports: {
        updateRunKeysField: (embed: EmbedBuilder) => embed,
    },
});

mock.module('../../../lib/utilities/run-message-helpers.js', {
    namedExports: {
        buildRunLifecycleMessageContent: () => 'Run',
        buildRunMessageContent: () => 'Run',
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

mock.module('../../../lib/ui/headcount-conversion-selector.js', {
    namedExports: { collectHeadcountRunSubset: async () => null },
});

mock.module('../../../lib/utilities/active-runs-mirror.js', {
    namedExports: {
        syncActiveRunsMirror: async () => {
            sequence.push('active-runs-sync');
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

const { handleHeadcountConvert } = await import('./headcount-convert.js');

beforeEach(() => {
    selectedDungeonKey = 'SNAKE_PIT';
    configuredImage = true;
    imageSendFails = false;
    imageLookups = 0;
    deletedRunIds = [];
    sequence = [];
});

function createInteraction(): ButtonInteraction {
    const runMessage = {
        id: '100000000000000006',
        url: 'https://discord.test/converted-run',
        delete: async () => undefined,
    } as unknown as Message<true>;

    const channel = {
        id: channelId,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        messages: {
            fetch: async () => publicMessage,
        },
        send: async (message: MessageCreateOptions) => {
            if (message.files) {
                sequence.push(imageSendFails ? 'image-attempt' : 'image');
                if (imageSendFails) throw new Error('Discord rejected attachment');
            } else {
                sequence.push('run-panel');
            }
            return runMessage;
        },
    };

    const publicMessage = {
        id: publicMessageId,
        channelId,
        channel,
        embeds: [new EmbedBuilder().setTitle('Headcount').toJSON()],
        components: [],
        delete: async () => {
            sequence.push('retire-headcount');
        },
        edit: async () => undefined,
    } as unknown as Message<true>;

    return {
        channel,
        guildId,
        guild: {
            id: guildId,
            name: 'Test Guild',
            channels: { cache: new Map([[channelId, channel]]) },
        },
        user: { id: organizerId, username: 'Organizer' },
        client: {},
        webhook: {},
        deferUpdate: async () => undefined,
        reply: async () => undefined,
        editReply: async () => undefined,
        followUp: async () => {
            sequence.push('organizer-panel');
            return { id: '100000000000000007' };
        },
    } as unknown as ButtonInteraction;
}

describe('headcount conversion dungeon image publication', () => {
    it('publishes panel, configured image, then automatic organizer panel', async () => {
        await handleHeadcountConvert(createInteraction(), publicMessageId);

        assert.equal(imageLookups, 1);
        assert.ok(sequence.indexOf('run-panel') < sequence.indexOf('image'));
        assert.ok(sequence.indexOf('image') < sequence.indexOf('organizer-panel'));
        assert.deepEqual(deletedRunIds, []);
    });

    it('continues to the organizer panel when no image is configured', async () => {
        configuredImage = false;
        await handleHeadcountConvert(createInteraction(), publicMessageId);

        assert.equal(imageLookups, 1);
        assert.equal(sequence.includes('image'), false);
        assert.ok(sequence.indexOf('run-panel') < sequence.indexOf('organizer-panel'));
        assert.deepEqual(deletedRunIds, []);
    });

    it('keeps the converted run usable when Discord rejects the image', async () => {
        imageSendFails = true;
        await handleHeadcountConvert(createInteraction(), publicMessageId);

        assert.equal(imageLookups, 1);
        assert.ok(sequence.indexOf('run-panel') < sequence.indexOf('image-attempt'));
        assert.ok(sequence.indexOf('image-attempt') < sequence.indexOf('organizer-panel'));
        assert.deepEqual(deletedRunIds, []);
    });

    it('does not look up an image for an ineligible Realm Clearing run', async () => {
        selectedDungeonKey = 'REALM_DUNGEON';
        await handleHeadcountConvert(createInteraction(), publicMessageId);

        assert.equal(imageLookups, 0);
        assert.equal(sequence.includes('image'), false);
        assert.ok(sequence.indexOf('run-panel') < sequence.indexOf('organizer-panel'));
        assert.deepEqual(deletedRunIds, []);
    });
});

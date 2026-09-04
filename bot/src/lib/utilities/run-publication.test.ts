import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { Guild, GuildTextBasedChannel, Message } from 'discord.js';
import type { CreateRunResponse } from './http.js';

let configuredImage: {
    dungeon_key: string;
    image_base64: string;
    content_type: 'image/png';
    filename: string;
    updated_at: string;
} | null = null;
let imageLookupError = false;
let mirrorCalls = 0;
let loggerErrors = 0;
let imageLookups = 0;
let imageSendError = false;

mock.module('./http.js', {
    namedExports: {
        postJSON: async () => ({}),
        getDungeonImage: async () => {
            imageLookups += 1;
            if (imageLookupError) throw new Error('backend unavailable');
            return configuredImage;
        },
    },
});
mock.module('./run-panel-builder.js', {
    namedExports: {
        buildRunButtons: () => [],
        buildRunEmbed: () => ({ title: 'Raid' }),
    },
});
mock.module('./dungeon-role-pings.js', {
    namedExports: { resolveDungeonRolePingIds: async () => [] },
});
mock.module('./run-message-helpers.js', {
    namedExports: { buildRunLifecycleMessageContent: () => '@here - Snake Pit' },
});
mock.module('./auto-join-helpers.js', {
    namedExports: { autoJoinOrganizerToRun: async () => undefined },
});
mock.module('./run-reactions.js', {
    namedExports: { addRunReactions: async () => undefined },
});
mock.module('./early-loc-notifier.js', {
    namedExports: { sendEarlyLocNotification: async () => undefined },
});
mock.module('../logging/raid-logger.js', {
    namedExports: { logRaidCreation: async () => undefined },
});
mock.module('../logging/logger.js', {
    namedExports: {
        createLogger: () => ({
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => { loggerErrors += 1; },
        }),
    },
});
mock.module('./active-runs-mirror.js', {
    namedExports: { syncActiveRunsMirror: async () => { mirrorCalls += 1; } },
});

const { isDungeonImageEligible, publishCreatedRun } = await import('./run-publication.js');

const singleRun: CreateRunResponse = {
    runId: 42,
    dungeonKey: 'SNAKE_PIT',
    dungeonLabel: 'Snake Pit',
    runKind: 'single',
    activityKey: 'SNAKE_PIT',
    selectedDungeons: [{ dungeonKey: 'SNAKE_PIT', dungeonLabel: 'Snake Pit', selectionOrder: 1 }],
};

beforeEach(() => {
    configuredImage = null;
    imageLookupError = false;
    mirrorCalls = 0;
    loggerErrors = 0;
    imageLookups = 0;
    imageSendError = false;
});

function publicationHarness() {
    const sends: Array<Record<string, unknown>> = [];
    const sequence: string[] = [];
    const message = {
        id: '100000000000000010',
        url: 'https://discord.test/raid',
        delete: async () => undefined,
    } as unknown as Message<true>;
    const channel = {
        send: async (payload: Record<string, unknown>) => {
            sends.push(payload);
            sequence.push(sends.length === 1 ? 'raid-panel' : 'dungeon-image');
            if (sends.length === 2 && imageSendError) throw new Error('Discord rejected attachment');
            return message;
        },
    } as unknown as GuildTextBasedChannel;
    const guild = { id: '100000000000000001', client: {} } as unknown as Guild;
    return { sends, sequence, message, channel, guild };
}

describe('single-dungeon image publication', () => {
    it('posts panel then image in the same channel before the caller opens the organizer panel', async () => {
        configuredImage = {
            dungeon_key: 'SNAKE_PIT',
            image_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
            content_type: 'image/png',
            filename: 'snake.png',
            updated_at: '2026-09-04T01:00:00.000Z',
        };
        const harness = publicationHarness();
        await publishCreatedRun({
            guild: harness.guild,
            raidChannel: harness.channel,
            organizerId: '100000000000000002',
            created: singleRun,
        });
        harness.sequence.push('organizer-panel');

        assert.deepEqual(harness.sequence, ['raid-panel', 'dungeon-image', 'organizer-panel']);
        assert.equal(harness.sends.length, 2);
        assert.deepEqual(harness.sends[1].allowedMentions, { parse: [] });
        assert.equal(Object.hasOwn(harness.sends[1], 'content'), false);
        assert.equal(mirrorCalls, 1);
    });

    it('posts no extra message when no image is configured', async () => {
        const harness = publicationHarness();
        await publishCreatedRun({
            guild: harness.guild,
            raidChannel: harness.channel,
            organizerId: '100000000000000002',
            created: singleRun,
        });
        assert.equal(harness.sends.length, 1);
        assert.equal(imageLookups, 1);
    });

    it('does not look up or post images for multi-dungeon or Realm Clearing runs', async () => {
        configuredImage = {
            dungeon_key: 'SNAKE_PIT',
            image_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
            content_type: 'image/png',
            filename: 'snake.png',
            updated_at: '2026-09-04T01:00:00.000Z',
        };
        const multi: CreateRunResponse = {
            ...singleRun,
            runKind: 'multi_non_exalt',
            selectedDungeons: [
                singleRun.selectedDungeons[0],
                { dungeonKey: 'SPRITE_WORLD', dungeonLabel: 'Sprite World', selectionOrder: 2 },
            ],
        };
        const realm: CreateRunResponse = {
            ...singleRun,
            dungeonKey: 'REALM_DUNGEON',
            dungeonLabel: 'Realm Clearing',
            runKind: 'realm_clearing',
            selectedDungeons: [{ dungeonKey: 'REALM_DUNGEON', dungeonLabel: 'Realm Clearing', selectionOrder: 1 }],
        };
        assert.equal(isDungeonImageEligible(multi), false);
        assert.equal(isDungeonImageEligible(realm), false);

        for (const created of [multi, realm]) {
            const harness = publicationHarness();
            await publishCreatedRun({
                guild: harness.guild,
                raidChannel: harness.channel,
                organizerId: '100000000000000002',
                created,
            });
            assert.equal(harness.sends.length, 1);
        }
        assert.equal(imageLookups, 0);
    });

    it('continues the valid raid flow when the optional image cannot be loaded', async () => {
        imageLookupError = true;
        const harness = publicationHarness();
        await assert.doesNotReject(() => publishCreatedRun({
            guild: harness.guild,
            raidChannel: harness.channel,
            organizerId: '100000000000000002',
            created: singleRun,
        }));
        assert.equal(harness.sends.length, 1);
        assert.equal(loggerErrors, 1);
        assert.equal(mirrorCalls, 1);
    });

    it('continues the valid raid flow when Discord rejects the optional image', async () => {
        configuredImage = {
            dungeon_key: 'SNAKE_PIT',
            image_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
            content_type: 'image/png',
            filename: 'snake.png',
            updated_at: '2026-09-04T01:00:00.000Z',
        };
        imageSendError = true;
        const harness = publicationHarness();
        await assert.doesNotReject(() => publishCreatedRun({
            guild: harness.guild,
            raidChannel: harness.channel,
            organizerId: '100000000000000002',
            created: singleRun,
        }));
        harness.sequence.push('organizer-panel');
        assert.deepEqual(harness.sequence, ['raid-panel', 'dungeon-image', 'organizer-panel']);
        assert.equal(loggerErrors, 1);
        assert.equal(mirrorCalls, 1);
    });

    it('treats chained Oryx 3 as an eligible single-dungeon run', () => {
        assert.equal(isDungeonImageEligible({
            ...singleRun,
            dungeonKey: 'ORYX_3',
            dungeonLabel: 'Oryx 3',
            runKind: 'oryx_3',
            selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
        }), true);
    });
});

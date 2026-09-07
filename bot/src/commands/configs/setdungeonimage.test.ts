import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';

const stored: unknown[][] = [];
const botLogEvents: unknown[][] = [];
const runtimeErrors: unknown[][] = [];
let downloadFails = false;
let persistenceFails = false;
let botLogFails = false;
let botLogConfigured = true;
let previousImage: {
    content_type: 'image/png';
    filename: string;
    size_bytes: number;
    updated_at: string;
} | null = null;

class TestBackendError extends Error {
    code?: string;
}

mock.module('../../lib/utilities/http.js', {
    namedExports: {
        BackendError: TestBackendError,
        setDungeonImage: async (...args: unknown[]) => {
            if (persistenceFails) throw new Error('database unavailable');
            stored.push(args);
            return {
                image: {
                    dungeon_key: 'SNAKE_PIT',
                    image_base64: 'iVBORw0KGgo=',
                    content_type: 'image/png',
                    filename: 'snake.png',
                    updated_at: '2026-09-06T12:00:00.000Z',
                },
                previousImage,
            };
        },
    },
});
mock.module('../../lib/utilities/dungeon-image.js', {
    namedExports: {
        DungeonImageValidationError: class extends Error { },
        downloadDungeonImage: async () => {
            if (downloadFails) throw new Error('invalid');
            return {
                data: Buffer.from('89504e470d0a1a0a', 'hex'),
                contentType: 'image/png',
                filename: 'snake.png',
            };
        },
    },
});
mock.module('../../lib/permissions/permissions.js', {
    namedExports: {
        getMemberRoleIds: () => ['100000000000000004'],
        hasRequiredRoleOrHigher: async () => ({ hasRole: false, isConfigured: true }),
        hasInternalRole: async () => false,
        canBotManageMember: async () => ({ canManage: true }),
    },
});
mock.module('../../lib/logging/bot-logger.js', {
    namedExports: {
        logBotEvent: async (...args: unknown[]) => {
            if (botLogFails) throw new Error('Missing Access');
            if (!botLogConfigured) return;
            botLogEvents.push(args);
        },
    },
});
mock.module('../../lib/logging/logger.js', {
    namedExports: {
        createLogger: () => ({
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: (...args: unknown[]) => { runtimeErrors.push(args); },
        }),
    },
});

const { setdungeonimage } = await import('./setdungeonimage.js');
const { withPermissionCheck } = await import('../../lib/permissions/command-middleware.js');

beforeEach(() => {
    stored.length = 0;
    botLogEvents.length = 0;
    runtimeErrors.length = 0;
    downloadFails = false;
    persistenceFails = false;
    botLogFails = false;
    botLogConfigured = true;
    previousImage = null;
});

function interaction(guildId: string, dungeonKey = 'SNAKE_PIT') {
    const edits: unknown[] = [];
    const replies: unknown[] = [];
    const value = {
        inGuild: () => true,
        guildId,
        guild: {
            id: guildId,
            members: { fetch: async () => ({
                roles: { cache: new Map() },
                permissions: { has: () => false },
            }) },
        },
        user: { id: '100000000000000003', username: 'Auditor' },
        client: { channels: { fetch: async () => null } },
        options: {
            getString: () => dungeonKey,
            getAttachment: () => ({ name: 'snake.png' }),
        },
        deferReply: async () => undefined,
        editReply: async (payload: unknown) => { edits.push(payload); },
        reply: async (payload: unknown) => { replies.push(payload); },
    } as unknown as ChatInputCommandInteraction;
    return { value, edits, replies };
}

describe('/setdungeonimage', () => {
    it('is registered as moderator+ with canonical dungeon autocomplete', () => {
        assert.equal(setdungeonimage.requiredRole, 'moderator');
        const json = setdungeonimage.data.toJSON();
        const dungeon = json.options?.find(option => option.name === 'dungeon');
        assert.equal(dungeon && 'autocomplete' in dungeon ? dungeon.autocomplete : false, true);
        assert.ok(json.options?.some(option => option.name === 'image'));
    });

    it('uses the existing permission middleware to reject an unauthorized user', async () => {
        const wrapped = withPermissionCheck(setdungeonimage);
        const test = interaction('100000000000000001');
        await wrapped.run(test.value);
        assert.equal(stored.length, 0);
        assert.match(JSON.stringify(test.replies), /Missing Permission/);
    });

    it('stores valid uploads and lets the backend replace or isolate each guild record', async () => {
        const first = interaction('100000000000000001');
        const replacement = interaction('100000000000000001');
        const otherGuild = interaction('100000000000000002');
        await setdungeonimage.run(first.value);
        await setdungeonimage.run(replacement.value);
        await setdungeonimage.run(otherGuild.value);
        assert.equal(stored.length, 3);
        assert.deepEqual(stored.map(call => call.slice(0, 2)), [
            ['100000000000000001', 'SNAKE_PIT'],
            ['100000000000000001', 'SNAKE_PIT'],
            ['100000000000000002', 'SNAKE_PIT'],
        ]);
        assert.match(String(first.edits.at(-1)), /Dungeon image set for Snake Pit/);
    });

    it('sends one first-time bot-log audit with the command, actor, dungeon, and new image', async () => {
        const test = interaction('100000000000000001');
        await setdungeonimage.run(test.value);

        assert.equal(stored.length, 1);
        assert.equal(botLogEvents.length, 1);
        const serialized = JSON.stringify(botLogEvents[0]);
        assert.match(serialized, /setdungeonimage/);
        assert.match(serialized, /100000000000000003/);
        assert.match(serialized, /Auditor/);
        assert.match(serialized, /Snake Pit/);
        assert.match(serialized, /None \/ Not set/);
        assert.match(serialized, /snake\.png/);
        assert.match(serialized, /image\/png/);
        assert.match(serialized, /8 bytes/);
        assert.match(serialized, /Dungeon Image Set/);
    });

    it('records both previous and new image metadata when replacing an image', async () => {
        previousImage = {
            content_type: 'image/png',
            filename: 'old-snake.png',
            size_bytes: 4096,
            updated_at: '2026-09-01T12:00:00.000Z',
        };

        await setdungeonimage.run(interaction('100000000000000001').value);

        assert.equal(botLogEvents.length, 1);
        const serialized = JSON.stringify(botLogEvents[0]);
        assert.match(serialized, /Dungeon Image Replaced/);
        assert.match(serialized, /old-snake\.png/);
        assert.match(serialized, /4,096 bytes/);
        assert.match(serialized, /snake\.png/);
    });

    it('does not send a successful audit when persistence fails', async () => {
        persistenceFails = true;
        const test = interaction('100000000000000001');

        await setdungeonimage.run(test.value);

        assert.equal(stored.length, 0);
        assert.equal(botLogEvents.length, 0);
        assert.match(String(test.edits.at(-1)), /Failed to set the dungeon image/);
    });

    it('keeps a persisted update successful when bot-log delivery unexpectedly rejects', async () => {
        botLogFails = true;
        const test = interaction('100000000000000001');

        await setdungeonimage.run(test.value);

        assert.equal(stored.length, 1);
        assert.equal(runtimeErrors.length, 1);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
    });

    it('keeps a persisted update successful when bot-logs is unconfigured', async () => {
        botLogConfigured = false;
        const test = interaction('100000000000000001');

        await setdungeonimage.run(test.value);

        assert.equal(stored.length, 1);
        assert.equal(botLogEvents.length, 0);
        assert.equal(runtimeErrors.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
    });

    it('rejects non-canonical and Realm Clearing selections before storage', async () => {
        await setdungeonimage.run(interaction('100000000000000001', 'NOT_A_DUNGEON').value);
        await setdungeonimage.run(interaction('100000000000000001', 'REALM_DUNGEON').value);
        assert.equal(stored.length, 0);
    });
});

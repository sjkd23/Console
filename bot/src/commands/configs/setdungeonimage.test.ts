import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';

const stored: unknown[][] = [];
let downloadFails = false;

class TestBackendError extends Error {
    code?: string;
}

mock.module('../../lib/utilities/http.js', {
    namedExports: {
        BackendError: TestBackendError,
        setDungeonImage: async (...args: unknown[]) => { stored.push(args); return {}; },
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

const { setdungeonimage } = await import('./setdungeonimage.js');
const { withPermissionCheck } = await import('../../lib/permissions/command-middleware.js');

beforeEach(() => {
    stored.length = 0;
    downloadFails = false;
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
        user: { id: '100000000000000003' },
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

    it('rejects non-canonical and Realm Clearing selections before storage', async () => {
        await setdungeonimage.run(interaction('100000000000000001', 'NOT_A_DUNGEON').value);
        await setdungeonimage.run(interaction('100000000000000001', 'REALM_DUNGEON').value);
        assert.equal(stored.length, 0);
    });
});

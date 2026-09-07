import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { ChatInputCommandInteraction, Client } from 'discord.js';

const guildId = '1437327222863040614';
const configuredChannelId = '1438797857669775360';
const sentMessages: unknown[] = [];
const fetchedChannelIds: string[] = [];
const runtimeLogs: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
    data?: Record<string, unknown>;
}> = [];

let botLogChannelId: string | null = configuredChannelId;
let channelState: 'sendable' | 'missing' | 'not_sendable' = 'sendable';
let fetchFails = false;
let sendFails = false;

class TestBackendError extends Error {
    code?: string;
}

mock.module('../../lib/utilities/http.js', {
    namedExports: {
        BackendError: TestBackendError,
        getGuildChannels: async () => ({
            // This is the exact dynamic Record shape returned by GET
            // /guilds/:guild_id/channels and populated from guild_channel.channel_key.
            channels: botLogChannelId === null ? {} : { bot_log: botLogChannelId },
        }),
        setDungeonImage: async () => ({
            image: {
                dungeon_key: 'SNAKE_PIT',
                image_base64: 'iVBORw0KGgo=',
                content_type: 'image/png',
                filename: 'snake.png',
                updated_at: '2026-09-06T12:00:00.000Z',
            },
            previousImage: null,
        }),
    },
});

mock.module('../../lib/utilities/dungeon-image.js', {
    namedExports: {
        DungeonImageValidationError: class extends Error { },
        downloadDungeonImage: async () => ({
            data: Buffer.from('89504e470d0a1a0a', 'hex'),
            contentType: 'image/png',
            filename: 'snake.png',
        }),
    },
});

mock.module('../../lib/permissions/permissions.js', {
    namedExports: {
        getMemberRoleIds: () => ['100000000000000004'],
        hasRequiredRoleOrHigher: async () => ({ hasRole: true, isConfigured: true }),
        hasInternalRole: async () => true,
        canBotManageMember: async () => ({ canManage: true }),
    },
});

mock.module('../../lib/logging/logger.js', {
    namedExports: {
        createLogger: () => ({
            debug: () => undefined,
            info: (message: string, data?: Record<string, unknown>) => {
                runtimeLogs.push({ level: 'info', message, data });
            },
            warn: (message: string, data?: Record<string, unknown>) => {
                runtimeLogs.push({ level: 'warn', message, data });
            },
            error: (message: string, data?: Record<string, unknown>) => {
                runtimeLogs.push({ level: 'error', message, data });
            },
        }),
    },
});

const { setdungeonimage } = await import('./setdungeonimage.js');

beforeEach(() => {
    botLogChannelId = configuredChannelId;
    channelState = 'sendable';
    fetchFails = false;
    sendFails = false;
    sentMessages.length = 0;
    fetchedChannelIds.length = 0;
    runtimeLogs.length = 0;
});

function interaction(): { value: ChatInputCommandInteraction; edits: unknown[] } {
    const edits: unknown[] = [];
    const channel = {
        type: 0,
        isSendable: () => channelState === 'sendable',
        send: async (payload: unknown) => {
            if (sendFails) throw new Error('Missing Permissions');
            sentMessages.push(payload);
        },
    };
    const client = {
        channels: {
            fetch: async (channelId: string) => {
                fetchedChannelIds.push(channelId);
                if (fetchFails) throw new Error('Missing Access');
                return channelState === 'missing' ? null : channel;
            },
        },
    } as unknown as Client;

    const value = {
        inGuild: () => true,
        guildId,
        guild: {
            id: guildId,
            members: {
                fetch: async () => ({
                    roles: { cache: new Map() },
                    permissions: { has: () => false },
                }),
            },
        },
        user: { id: '218823980524634112', username: 'Auditor' },
        client,
        options: {
            getString: () => 'SNAKE_PIT',
            getAttachment: () => ({ name: 'snake.png' }),
        },
        deferReply: async () => undefined,
        editReply: async (payload: unknown) => { edits.push(payload); },
        reply: async () => undefined,
    } as unknown as ChatInputCommandInteraction;

    return { value, edits };
}

function findRuntimeLog(level: 'info' | 'warn' | 'error') {
    return runtimeLogs.find(entry => entry.level === level && entry.data?.auditEvent === '/setdungeonimage');
}

describe('/setdungeonimage real bot-log delivery path', () => {
    it('uses channels.bot_log, fetches that channel, and sends exactly one audit embed', async () => {
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.deepEqual(fetchedChannelIds, [configuredChannelId]);
        assert.equal(sentMessages.length, 1);
        assert.match(JSON.stringify(sentMessages[0]), /Dungeon Image Set/);
        assert.match(JSON.stringify(sentMessages[0]), /Snake Pit/);
        const payload = sentMessages[0] as {
            embeds?: Array<{ toJSON(): { image?: { url?: string } } }>;
            files?: Array<{ attachment: unknown; name?: string }>;
        };
        assert.equal(payload.files?.length, 1);
        assert.equal(payload.files?.[0]?.name, 'dungeon-image.png');
        assert.ok(Buffer.isBuffer(payload.files?.[0]?.attachment));
        assert.deepEqual(payload.files?.[0]?.attachment, Buffer.from('89504e470d0a1a0a', 'hex'));
        assert.equal(payload.embeds?.[0]?.toJSON().image?.url, 'attachment://dungeon-image.png');
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const successLog = findRuntimeLog('info');
        assert.equal(successLog?.message, 'Sent bot-log audit event');
        assert.equal(successLog?.data?.guildId, guildId);
        assert.equal(successLog?.data?.botLogChannelId, configuredChannelId);
    });

    it('keeps the command successful and warns when bot_log is not configured', async () => {
        botLogChannelId = null;
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.equal(fetchedChannelIds.length, 0);
        assert.equal(sentMessages.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const warning = findRuntimeLog('warn');
        assert.equal(warning?.data?.reason, 'not_configured');
        assert.equal(warning?.data?.guildId, guildId);
        assert.equal(warning?.data?.botLogChannelId, null);
    });

    it('keeps the command successful and warns when the configured channel was deleted', async () => {
        channelState = 'missing';
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.deepEqual(fetchedChannelIds, [configuredChannelId]);
        assert.equal(sentMessages.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const warning = findRuntimeLog('warn');
        assert.equal(warning?.data?.reason, 'channel_not_found');
        assert.equal(warning?.data?.botLogChannelId, configuredChannelId);
    });

    it('keeps the command successful and diagnoses an inaccessible configured channel', async () => {
        fetchFails = true;
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.deepEqual(fetchedChannelIds, [configuredChannelId]);
        assert.equal(sentMessages.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const failure = findRuntimeLog('error');
        assert.equal(failure?.data?.reason, 'channel_fetch_failed');
        assert.equal(failure?.data?.botLogChannelId, configuredChannelId);
    });

    it('keeps the command successful and warns when the configured channel is not sendable', async () => {
        channelState = 'not_sendable';
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.deepEqual(fetchedChannelIds, [configuredChannelId]);
        assert.equal(sentMessages.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const warning = findRuntimeLog('warn');
        assert.equal(warning?.data?.reason, 'channel_not_sendable');
        assert.equal(warning?.data?.botLogChannelId, configuredChannelId);
    });

    it('keeps the command successful and diagnoses a Discord send failure', async () => {
        sendFails = true;
        const test = interaction();

        await setdungeonimage.run(test.value);

        assert.deepEqual(fetchedChannelIds, [configuredChannelId]);
        assert.equal(sentMessages.length, 0);
        assert.match(String(test.edits.at(-1)), /Dungeon image set for Snake Pit/);
        const failure = findRuntimeLog('error');
        assert.equal(failure?.data?.reason, 'send_failed');
        assert.equal(failure?.data?.botLogChannelId, configuredChannelId);
    });
});

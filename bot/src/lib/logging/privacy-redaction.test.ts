import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { ChannelType, TextChannel, type ChatInputCommandInteraction, type Client } from 'discord.js';

const secret = 'SYNTHETIC_PRIVATE_DISCORD_PAYLOAD_417e';
const logs: unknown[] = [], sent: unknown[] = [];
mock.module('../utilities/http.js', { namedExports: { getGuildChannels: async () => ({ channels: { bot_log: 'log', raid_log: 'log' } }) } });
const { logCommandExecution, logModerationAction, logConfigChange, logVerificationAction } = await import('./bot-logger.js');
const { logScreenshotSubmission, clearLogThreadCache } = await import('./raid-logger.js');
const context = { guildId: 'guild', organizerId: 'actor', organizerUsername: 'actor', dungeonName: 'Oryx 3', type: 'run' as const, runId: 1 };
const thread = { id: 'thread', archived: false, send: async (payload: unknown) => {
    sent.push(payload); throw Object.assign(new Error(secret), { requestBody: payload });
} };
const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
    type: ChannelType.GuildText,
    messages: {},
    send: async (payload: unknown) => {
        sent.push(payload);
        if (inspect(payload, { depth: null }).includes(secret)) throw Object.assign(new Error(secret), { requestBody: payload });
        return { startThread: async () => thread };
    },
});
const client = { channels: { fetch: async (id: string) => id === 'thread' ? thread : channel } } as unknown as Client;
beforeEach(() => {
    logs.length = 0; sent.length = 0; clearLogThreadCache(context);
    for (const level of ['log', 'warn', 'error'] as const) mock.method(console, level, (...args: unknown[]) => logs.push(args));
});
afterEach(() => mock.restoreAll());
const operations: Array<[string, () => Promise<void>]> = [
    ['command text', () => logCommandExecution(client, { guildId: 'guild', commandName: 'test', channelId: 'channel', id: 'command', user: { id: 'actor' }, options: { getSubcommand: () => null } } as unknown as ChatInputCommandInteraction, { details: { text: secret } })],
    ['moderation reason', () => logModerationAction(client, 'guild', 'warn', 'actor', 'target', { reason: secret })],
    ['configuration text', () => logConfigChange(client, 'guild', 'test', 'actor', { template: { new: secret } })],
    ['verification reason', () => logVerificationAction(client, 'guild', 'unverified', 'actor', 'target', 'Player', secret)],
    ['screenshot URL', () => logScreenshotSubmission(client, context, `https://example.invalid/${secret}.png`, 'actor')],
];
for (const [name, operation] of operations) it(`retains intended Discord ${name} while redacting failed-send diagnostics`, async () => {
    await operation();
    assert.ok(inspect(sent, { depth: null }).includes(secret), inspect(logs, { depth: null }));
    assert.ok(!inspect(logs, { depth: null }).includes(secret));
    assert.ok(inspect(logs).includes('Failed to'));
    assert.ok(inspect(logs).includes('guild'));
});

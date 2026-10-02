import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { afterEach, beforeEach, it, mock } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';

const secret = 'SYNTHETIC_SCREENSHOT_URL_912c';
const url = `https://example.invalid/${secret}.png`;
const logs: unknown[] = [], writes: unknown[] = [], replies: unknown[] = [];
let backendFails = false, discordFails = false;
mock.module('../../lib/utilities/interaction-helpers.js', { namedExports: {
    ensureGuildContext: async () => ({ id: 'guild' }), fetchGuildMember: async () => ({}),
} });
mock.module('../../lib/permissions/permissions.js', { namedExports: { getMemberRoleIds: () => [] } });
mock.module('../../lib/utilities/http.js', { namedExports: {
    getActiveRunsByOrganizer: async () => ({ activeRuns: [{ id: 1, dungeonLabel: 'Oryx 3', status: 'starting', createdAt: '2026-01-01', channelId: 'channel', postMessageId: null }] }),
    postJSON: async (...args: unknown[]) => { writes.push(args); if (backendFails) throw new Error(secret); return {}; },
} });
mock.module('../../lib/logging/raid-logger.js', { namedExports: { logScreenshotSubmission: async () => { if (discordFails) throw { requestBody: url }; } } });
mock.module('../../lib/errors/error-handler.js', { namedExports: { formatErrorMessage: () => 'Failed to submit screenshot' } });
const { taken } = await import('./taken.js');
beforeEach(() => {
    backendFails = discordFails = false;
    for (const list of [logs, writes, replies]) list.length = 0;
    for (const level of ['log', 'warn', 'error'] as const) mock.method(console, level, (...args: unknown[]) => logs.push(args));
});
afterEach(() => mock.restoreAll());
for (const scenario of ['success', 'backend failure', 'Discord log failure'] as const) it(`/taken ${scenario} does not print the screenshot URL`, async () => {
    backendFails = scenario === 'backend failure'; discordFails = scenario === 'Discord log failure';
    const interaction = { user: { id: 'actor', username: 'actor' }, client: {},
        options: { getAttachment: () => ({ url, size: 123, contentType: 'image/png' }) },
        deferReply: async () => {}, editReply: async (payload: unknown) => replies.push(payload),
    };
    await taken.run(interaction as unknown as ChatInputCommandInteraction);
    assert.ok(inspect(writes, { depth: null }).includes(secret));
    assert.ok(!inspect(logs, { depth: null }).includes(secret));
    assert.ok(replies.length > 0);
    assert.ok(inspect(logs).includes('guild'));
});

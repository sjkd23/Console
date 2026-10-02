import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { EmbedBuilder, type ModalSubmitInteraction, type ButtonInteraction, type Message } from 'discord.js';

const secret = 'SYNTHETIC_CUSTOM_ROLE_DENIAL_731b';
const logs: unknown[] = [], updates: unknown[] = [], sent: unknown[] = [], audits: unknown[][] = [];
let failUpdate = false, failEdit = false;
mock.module('../../../lib/utilities/http.js', { namedExports: {
    BackendError: class extends Error {}, getCustomRoleVerificationConfig: async () => ({}),
    createCustomRoleVerificationSession: async () => ({ id: 1 }), getCustomRoleVerificationSessionByUser: async () => null,
    getCustomRoleVerificationSession: async () => ({ id: 1, status: 'pending_review', user_id: 'target', role_id: 'role', ticket_message_id: 'message', instructions: 'Test instructions', screenshot_url: `https://example.invalid/${secret}.png` }),
    updateCustomRoleVerificationSession: async (...args: unknown[]) => { updates.push(args); if (failUpdate) throw new Error(secret); return {}; },
} });
mock.module('../../../lib/permissions/permissions.js', { namedExports: { hasInternalRole: async () => true, getMemberRoleIds: () => [] } });
mock.module('../../../lib/verification/verification.js', { namedExports: { logVerificationEvent: async (...args: unknown[]) => { audits.push(args); } } });
const { handleCustomRoleDenyModal, handleCustomRoleGetVerified } = await import('./custom-role-verification.js');
beforeEach(() => {
    failUpdate = failEdit = false;
    for (const list of [logs, updates, sent, audits]) list.length = 0;
    mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
});
for (const scenario of ['success', 'backend failure', 'ticket send failure'] as const) it(`custom-role screenshot ${scenario} protects URL diagnostics`, async () => {
    let collect: ((message: Message) => Promise<void>) | undefined;
    const collector = { on: (event: string, handler: (message: Message) => Promise<void>) => { if (event === 'collect') collect = handler; }, stop: () => {} };
    const user = { id: 'target', tag: 'target' };
    const guild = { id: 'guild', name: 'Guild', members: { fetch: async () => ({ roles: { cache: new Set() } }) },
        roles: { fetch: async () => ({ name: 'Role', color: 0x5865f2 }) }, client: { users: { fetch: async () => user } },
        channels: { fetch: async () => ({ send: async (payload: unknown) => {
            sent.push(payload); if (scenario === 'ticket send failure') throw Object.assign(new Error(secret), { requestBody: payload });
            return { id: 'ticket' };
        } }) },
    };
    const dm = { send: async (payload: unknown) => sent.push(payload), createMessageCollector: () => collector, client: { guilds: { fetch: async () => guild } } };
    const interaction = { inGuild: () => true, guildId: 'guild', guild, user: { ...user, createDM: async () => dm },
        customId: 'customrole:get_verified:1', deferReply: async () => {}, editReply: async () => {},
    };
    await handleCustomRoleGetVerified(interaction as unknown as ButtonInteraction);
    assert.ok(collect);
    failUpdate = scenario === 'backend failure';
    await collect({ content: '', attachments: { size: 1, first: () => ({ url: `https://example.invalid/${secret}.png`, contentType: 'image/png' }) } } as unknown as Message);
    assert.ok(inspect(updates, { depth: null }).includes(secret));
    assert.ok(!inspect(logs, { depth: null }).includes(secret));
    if (scenario !== 'backend failure') {
        const screenshotAudit = audits.find(args => String(args[2]).includes(secret));
        assert.deepEqual(screenshotAudit?.[3], { redactErrorDetails: true });
    }
});
afterEach(() => mock.restoreAll());
for (const scenario of ['success', 'backend failure', 'ticket edit failure'] as const) it(`custom-role denial ${scenario} preserves reason delivery without plaintext diagnostics`, async () => {
    failUpdate = scenario === 'backend failure'; failEdit = scenario === 'ticket edit failure';
    const ticket = { embeds: [new EmbedBuilder().setTitle('Verification')], edit: async (payload: unknown) => { sent.push(payload); if (failEdit) throw { requestBody: payload }; } };
    const interaction = { inGuild: () => true, guildId: 'guild', guild: { id: 'guild', name: 'Guild', roles: { fetch: async () => ({ name: 'Role' }) } },
        user: { id: 'reviewer', tag: 'reviewer' }, customId: 'customrole:deny_modal:1', fields: { getTextInputValue: () => secret },
        channel: { messages: { fetch: async () => ticket } }, client: { users: { fetch: async () => ({ send: async (payload: unknown) => sent.push(payload) }) } },
        deferReply: async () => {}, editReply: async () => {},
    };
    await handleCustomRoleDenyModal(interaction as unknown as ModalSubmitInteraction);
    assert.ok(inspect(updates, { depth: null }).includes(secret));
    assert.ok(!inspect(logs, { depth: null }).includes(secret));
    if (scenario === 'success') {
        assert.ok(inspect(sent, { depth: null }).includes(secret));
        assert.deepEqual(audits[0][3], { error: true, redactErrorDetails: true });
    } else assert.ok(inspect(logs).includes('reviewer'));
});

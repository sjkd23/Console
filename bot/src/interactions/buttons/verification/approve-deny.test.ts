import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, it, mock } from 'node:test';
import { EmbedBuilder, ModalBuilder, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import type { VerificationSession } from '../../../lib/verification/verification.js';

const userId = '100000000000000001', reviewerId = '100000000000000002', guildId = '100000000000000003', ticketId = '100000000000000004';
const secret = 'private denial text';
let session: VerificationSession | null;
let updateGate: Promise<void> | undefined;
let permitted = true, failDM = false, failEdit = false, updateMissing = false, approvalSucceeds = false;
const updates: unknown[] = [], notifications: unknown[] = [], audits: unknown[] = [], credits: unknown[] = [], deleted: unknown[] = [], logs: unknown[] = [], approvals: unknown[] = [];
mock.module('../../../lib/verification/verification.js', { namedExports: {
    getSessionByUserId: async (id: string) => { assert.equal(id, userId); return session; },
    updateSession: async (guild: string, user: string, patch: Partial<VerificationSession>) => {
        updates.push({ guild, user, patch });
        await updateGate;
        if (updateMissing) return null;
        session = { ...session!, ...patch }; return session;
    },
    deleteSession: async (guild: string, user: string) => { deleted.push({ guild, user }); session = null; },
    logVerificationEvent: async (...args: unknown[]) => { audits.push(args); },
    applyVerification: async (...args: unknown[]) => {
        approvals.push(args);
        if (!approvalSucceeds) throw new Error('Approval must not execute during denial');
        return { success: true, roleApplied: true, nicknameSet: true, errors: [] };
    },
    createSuccessEmbed: () => new EmbedBuilder(), validateIGN: () => ({ valid: true }),
} });
mock.module('../../../lib/permissions/permissions.js', { namedExports: { hasInternalRole: async () => permitted } });
mock.module('../../../lib/verification/manual-verification-credit.js', { namedExports: {
    awardManualVerificationCredit: async (...args: unknown[]) => { credits.push(args); return { points_awarded: 1 }; },
} });
const { handleVerificationDeny, handleVerificationDenyModal, handleVerificationApprove, handleVerificationApproveModal } = await import('./approve-deny.js');
function interaction(modal = true) {
    const replies: unknown[] = [], modals: ModalBuilder[] = [], edits: unknown[] = [];
    const i = {
        customId: modal ? `verification:deny_modal:${userId}:${reviewerId}:${ticketId}` : `verification:deny:${userId}`,
        user: { id: reviewerId, username: 'reviewer' }, guildId, deferred: false, replied: false,
        guild: { id: guildId, name: 'Server', members: { fetch: async (id: string) => ({ id }) } },
        inGuild: () => true,
        message: { id: ticketId, embeds: [], edit: async (p: unknown) => { if (failEdit) throw { requestBody: secret }; edits.push(p); } },
        client: { users: { fetch: async (id: string) => { assert.equal(id, userId); return { createDM: async () => ({ send: async (p: unknown) => { if (failDM) throw { requestBody: secret }; notifications.push(p); } }) }; } } },
        fields: { getTextInputValue: (id: string) => id === 'reason' ? `  ${secret}  ` : 'Player' },
        showModal: async (m: ModalBuilder) => { modals.push(m); },
        reply: async (p: unknown) => { i.replied = true; replies.push(p); },
        deferReply: async () => { i.deferred = true; }, editReply: async (p: unknown) => { replies.push(p); },
    };
    return { i, replies, modals, edits };
}
beforeEach(() => {
    mock.restoreAll();
    for (const level of ['log', 'warn', 'error'] as const) mock.method(console, level, (...args: unknown[]) => { logs.push(args); });
    for (const list of [updates, notifications, audits, credits, deleted, logs, approvals]) list.length = 0;
    updateGate = undefined;
    permitted = true; failDM = failEdit = updateMissing = approvalSucceeds = false;
    session = { guild_id: guildId, user_id: userId, ticket_message_id: ticketId, status: 'pending_review', rotmg_ign: 'Player',
        verification_code: null, verification_method: 'manual', screenshot_url: null, reviewed_by_user_id: null, reviewed_at: null,
        denial_reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
});
it('Deny opens a required paragraph modal correlated to reviewer and request without deferring', async () => {
    const { i, modals } = interaction(false); await handleVerificationDeny(i as unknown as ButtonInteraction);
    const modal = modals[0].toJSON();
    assert.equal(modal.custom_id, `verification:deny_modal:${userId}:${reviewerId}:${ticketId}`);
    assert.ok(modal.custom_id.length <= 100); assert.equal(i.deferred, false);
    assert.match(JSON.stringify(modal.components), /"custom_id":"reason"/);
    assert.match(JSON.stringify(modal.components), /"required":true/); assert.equal(updates.length, 0);
});
it('uses submitted reason for the correct session, DM, ticket, audit and credit, then cleans up', async () => {
    const { i, edits } = interaction(); await handleVerificationDenyModal(i as unknown as ModalSubmitInteraction);
    assert.deepEqual(updates, [{ guild: guildId, user: userId, patch: { status: 'denied', reviewed_by_user_id: reviewerId, denial_reason: secret } }]);
    for (const value of [notifications, edits, audits]) assert.ok(JSON.stringify(value).includes(secret));
    assert.equal(credits.length, 1); assert.equal(deleted.length, 1);
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.match(JSON.stringify(audits), /redactErrorDetails/);
});
for (const scenario of ['permission', 'reviewer', 'missing', 'replaced', 'guild', 'non-pending expired', 'completed', 'denied', 'message', 'malformed'] as const) {
    it(`rejects ${scenario} submissions without side effects`, async () => {
        const { i, replies } = interaction();
        if (scenario === 'permission') permitted = false;
        if (scenario === 'reviewer') i.user.id = '100000000000000099';
        if (scenario === 'missing') session = null;
        if (scenario === 'replaced') session!.ticket_message_id = '100000000000000098';
        if (scenario === 'guild') session!.guild_id = '100000000000000097';
        if (scenario === 'non-pending expired') { session!.status = 'pending_screenshot'; session!.expires_at = '2000-01-01T00:00:00.000Z'; }
        if (scenario === 'completed') session!.status = 'verified';
        if (scenario === 'denied') session!.status = 'denied';
        if (scenario === 'message') i.message.id = '100000000000000096';
        if (scenario === 'malformed') i.customId += ':extra';
        await handleVerificationDenyModal(i as unknown as ModalSubmitInteraction);
        assert.equal(updates.length, 0); assert.equal(notifications.length, 0); assert.ok(replies.length);
    });
}
it('allows staff to open and submit denial after pending review expires', async () => {
    session!.expires_at = '2000-01-01T00:00:00.000Z';
    const button = interaction(false);
    await handleVerificationDeny(button.i as unknown as ButtonInteraction);
    assert.equal(button.modals.length, 1);
    await handleVerificationDenyModal(interaction().i as unknown as ModalSubmitInteraction);
    assert.equal(updates.length, 1);
    assert.equal(deleted.length, 1);
});
it('allows approval review before and after stored expiry, with reviewer-bound forms', async () => {
    approvalSucceeds = true;
    mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
        assert.equal(delay, 60000);
        return { unref() { return this; } } as NodeJS.Timeout;
    }) as typeof setTimeout);
    for (const expiresAt of [new Date(Date.now() + 60000).toISOString(), '2000-01-01T00:00:00.000Z']) {
        session!.expires_at = expiresAt;
        const button = interaction(false);
        button.i.customId = `verification:approve:${userId}`;
        await handleVerificationApprove(button.i as unknown as ButtonInteraction);
        assert.equal(button.modals.length, 1);
        assert.equal(button.modals[0].toJSON().custom_id, `verification:approve_confirm:${userId}:${reviewerId}:${ticketId}`);
        const form = interaction();
        form.i.customId = `verification:approve_confirm:${userId}:${reviewerId}:${ticketId}`;
        await handleVerificationApproveModal(form.i as unknown as ModalSubmitInteraction);
        assert.equal(session!.status, 'verified');
        session = { ...session!, status: 'pending_review' };
    }
    assert.equal(approvals.length, 2);
    assert.equal(updates.length, 2);
    assert.equal(credits.length, 2);
});
it('rejects invalid, completed, denied and unauthorized approval reviews', async () => {
    for (const scenario of ['non-pending expired', 'completed', 'denied', 'unauthorized', 'reviewer', 'message', 'guild'] as const) {
        const form = interaction();
        form.i.customId = `verification:approve_confirm:${userId}:${reviewerId}:${ticketId}`;
        if (scenario === 'non-pending expired') { session!.status = 'pending_screenshot'; session!.expires_at = '2000-01-01T00:00:00.000Z'; }
        if (scenario === 'completed') session!.status = 'verified';
        if (scenario === 'denied') session!.status = 'denied';
        if (scenario === 'unauthorized') permitted = false;
        if (scenario === 'reviewer') form.i.user.id = '100000000000000099';
        if (scenario === 'message') form.i.message.id = '100000000000000099';
        if (scenario === 'guild') session!.guild_id = '100000000000000099';
        await handleVerificationApproveModal(form.i as unknown as ModalSubmitInteraction);
        assert.equal(approvals.length, 0, scenario);
        permitted = true;
        session = { ...session!, status: 'pending_review', guild_id: guildId, expires_at: new Date(Date.now() + 60000).toISOString() };
    }
});
it('rejects unauthorized and stale buttons', async () => {
    const { i, modals, edits } = interaction(false); permitted = false;
    await handleVerificationDeny(i as unknown as ButtonInteraction); permitted = true; session = null;
    await handleVerificationDeny(i as unknown as ButtonInteraction); assert.equal(modals.length, 0); assert.match(JSON.stringify(edits), /Verification Canceled/);
});
it('serializes duplicate submissions and competing approval', async () => {
    const a = interaction(), b = interaction(), c = interaction();
    c.i.customId = `verification:approve_confirm:${userId}:${reviewerId}:${ticketId}`;
    let release!: () => void;
    updateGate = new Promise<void>(resolve => { release = resolve; });
    const first = handleVerificationDenyModal(a.i as unknown as ModalSubmitInteraction);
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.all([handleVerificationDenyModal(b.i as unknown as ModalSubmitInteraction), handleVerificationApproveModal(c.i as unknown as ModalSubmitInteraction)]);
    release(); await first;
    assert.equal(updates.length, 1); assert.equal(credits.length, 1);
});
it('does not notify when the session disappears during update', async () => {
    updateMissing = true; await handleVerificationDenyModal(interaction().i as unknown as ModalSubmitInteraction);
    assert.equal(notifications.length, 0); assert.equal(credits.length, 0);
});
it('omits reason-bearing Discord errors from logs', async () => {
    failDM = true; failEdit = true; await handleVerificationDenyModal(interaction().i as unknown as ModalSubmitInteraction);
    assert.ok(logs.length); assert.ok(!JSON.stringify(logs).includes(secret));
});
it('routes denial modals and has no ordinary-message collector', () => {
    const handler = readFileSync(new URL('./approve-deny.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(handler, /createMessageCollector|message\.content/);
    const router = readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8');
    assert.match(router, /startsWith\('verification:deny_modal:'\)/);
});

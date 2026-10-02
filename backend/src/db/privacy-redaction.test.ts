import Fastify from 'fastify';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ databaseQuery: vi.fn(), logError: vi.fn() }));
vi.mock('pg', () => ({ Pool: class { query = state.databaseQuery; on() { return this; } } }));
vi.mock('../config.js', () => ({ backendConfig: { DATABASE_URL: 'postgres://test:test@localhost/test' } }));
vi.mock('../lib/logging/logger.js', () => {
    const logger = { error: state.logError, debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    return { logger, createLogger: () => logger };
});
vi.mock('../lib/auth/authorization.js', () => ({ requireSecurity: vi.fn(), requireOfficer: vi.fn(), hasInternalRole: vi.fn(), hasRequiredRoleOrHigher: vi.fn() }));
vi.mock('../lib/database/database-helpers.js', () => ({ ensureGuildExists: vi.fn(), ensureMemberExists: vi.fn() }));

import verificationRoutes from '../routes/system/verification.js';
import customRoleVerificationRoutes from '../routes/system/custom-role-verification.js';
import modmailRoutes from '../routes/moderation/modmail.js';
import notesRoutes from '../routes/moderation/notes.js';
import punishmentRoutes from '../routes/moderation/punishments.js';
import commandLogRoutes from '../routes/admin/command-log.js';
import raiderRoutes from '../routes/raid/raiders.js';
import { query as executeQuery } from './pool.js';
import { logAudit } from '../lib/logging/audit.js';
import { createSavedEmbed, updateSavedEmbed } from '../lib/services/saved-embed-service.js';
import { enqueueTranscript, pendingTranscript, acknowledgeTranscript } from '../lib/services/ticket-service.js';
import { setDungeonImage } from '../lib/services/dungeon-image-service.js';

const guild = '100000000000000001', user = '100000000000000002';
const secret = 'SYNTHETIC_PRIVATE_INPUT_8f74';
const privateIgn = 'PrivateIGN8f74';
const privateUrl = `https://example.invalid/${secret}.png`;
const uuid = '00000000-0000-4000-8000-000000000001';
const failure = () => Object.assign(new Error(`invalid input: ${secret}`), {
    code: '22001', detail: `Failing row contains ${secret}`, where: privateUrl,
});
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
function assertPrivateLogs() {
    const logs = [state.logError.mock.calls, consoleError.mock.calls, consoleLog.mock.calls];
    expect(inspect(logs, { depth: null })).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(inspect(logs, { depth: null })).not.toContain(privateIgn);
    const sqlLog = state.logError.mock.calls.find(([, message]) => message === 'Query failed');
    expect(sqlLog?.[0]).toMatchObject({ params: '[redacted]', code: '22001' });
    expect(sqlLog?.[0].sql).toBeTruthy();
    expect(sqlLog?.[0].queryId).toBeTruthy();
}

beforeEach(() => {
    state.databaseQuery.mockReset(); state.logError.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    state.databaseQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (inspect(params).includes(secret) || inspect(params).includes(privateIgn)) throw failure();
        if (sql.includes('SELECT ticket_id')) return { rows: [], rowCount: 0 };
        return { rows: [{ ticket_id: 'MM-ABC123', guild_id: guild, user_id: user, active: true, type: 'warn' }], rowCount: 1 };
    });
});
afterEach(() => vi.restoreAllMocks());

describe('sensitive SQL failures', () => {
    const cases: Array<{ name: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
        { name: 'general denial', method: 'PATCH', url: `/verification/session/${guild}/${user}`, payload: { status: 'denied', denial_reason: secret } },
        { name: 'general screenshot', method: 'PATCH', url: `/verification/session/${guild}/${user}`, payload: { screenshot_url: privateUrl } },
        { name: 'custom-role denial', method: 'PATCH', url: '/custom-role-verification/session/1', payload: { status: 'denied', denial_reason: secret } },
        { name: 'custom-role screenshot', method: 'PATCH', url: '/custom-role-verification/session/1', payload: { screenshot_url: privateUrl } },
        { name: 'custom-role instructions', method: 'POST', url: '/custom-role-verification', payload: { guild_id: guild, role_id: user, role_channel_id: user, verification_channel_id: user, created_by_user_id: user, instructions: secret } },
        { name: 'initial modmail', method: 'POST', url: '/modmail/tickets', payload: { ticket_id: 'MM-ABC123', guild_id: guild, user_id: user, content: secret, attachments: [privateUrl] } },
        { name: 'modmail reply', method: 'POST', url: '/modmail/tickets/MM-ABC123/messages', payload: { author_id: user, content: secret, attachments: [privateUrl], is_staff_reply: true } },
        { name: 'modmail blacklist reason', method: 'POST', url: '/modmail/blacklist', payload: { actor_user_id: user, guild_id: guild, user_id: user, reason: secret } },
        { name: 'moderation note', method: 'POST', url: '/notes', payload: { actor_user_id: user, guild_id: guild, user_id: user, note_text: secret } },
        { name: 'moderation reason', method: 'POST', url: '/punishments', payload: { actor_user_id: user, guild_id: guild, user_id: user, type: 'warn', reason: secret } },
        { name: 'removal reason', method: 'DELETE', url: '/punishments/test-id', payload: { actor_user_id: user, removal_reason: secret } },
        { name: 'command options', method: 'POST', url: '/command-log', payload: { user_id: user, command_name: 'test', options: { text: secret, attachment: privateUrl } } },
    ];
    for (const testCase of cases) it(`redacts ${testCase.name}, including repeated error details and caller logs`, async () => {
        const app = Fastify({ logger: false });
        for (const routes of [verificationRoutes, customRoleVerificationRoutes, modmailRoutes, notesRoutes, punishmentRoutes, commandLogRoutes]) await app.register(routes);
        if (testCase.name === 'modmail reply') state.databaseQuery.mockResolvedValueOnce({ rows: [{ ticket_id: 'MM-ABC123' }], rowCount: 1 });
        try {
            const response = await app.inject(testCase);
            expect(response.statusCode).toBe(500);
            expect(state.databaseQuery.mock.calls.some(([, params]) => inspect(params).includes(secret))).toBe(true);
            assertPrivateLogs();
        } finally { await app.close(); }
    });

    it('does not print submitted verification names or repeat them on SQL failure', async () => {
        const app = Fastify({ logger: false });
        await app.register(raiderRoutes);
        try {
            const response = await app.inject({ method: 'POST', url: '/raiders/verify', payload: { actor_user_id: user, user_id: user, guild_id: guild, ign: privateIgn } });
            expect(response.statusCode).toBe(500);
            expect(inspect(state.databaseQuery.mock.calls)).toContain(privateIgn);
            assertPrivateLogs();
        } finally { await app.close(); }
    });

    const services: Array<[string, () => Promise<unknown>]> = [
        ['audit reasons', () => logAudit(guild, user, 'test', user, { reason: secret })],
        ['saved embed creation', () => createSavedEmbed(guild, 'test', { description: secret, image: { url: privateUrl }, fields: [] }, user)],
        ['saved embed update', () => updateSavedEmbed(guild, uuid, { description: secret, fields: [] }, 1)],
        ['ticket chunks', () => enqueueTranscript(guild, uuid, 'message:1', [secret, privateUrl])],
        ['dungeon image bytes', () => setDungeonImage({ guildId: guild, dungeonKey: 'test', data: Buffer.from(secret), filename: 'test.png', contentType: 'image/png' })],
    ];
    for (const [name, operation] of services) it(`redacts ${name} without discarding SQLSTATE`, async () => {
        state.databaseQuery.mockRejectedValueOnce(failure());
        await expect(operation()).rejects.toMatchObject({ name: 'DatabaseError', code: '22001' });
        assertPrivateLogs();
    });

    for (const operation of [() => pendingTranscript(guild, uuid), () => acknowledgeTranscript(guild, uuid, 'message:1', 1)]) {
        it('redacts ticket delivery failures that can repeat row content', async () => {
            state.databaseQuery.mockRejectedValueOnce(failure());
            await expect(operation()).rejects.toMatchObject({ code: '22001' });
            assertPrivateLogs();
        });
    }
    it('preserves unredacted diagnostics for non-sensitive queries', async () => {
        const error = Object.assign(new Error('synthetic connection failure'), { code: '08006' });
        state.databaseQuery.mockRejectedValueOnce(error);
        await expect(executeQuery('SELECT $1::bigint', [user])).rejects.toBe(error);
        expect(state.logError.mock.calls[0][0]).toMatchObject({ params: [user], error: error.message, code: '08006' });
    });

    for (const url of ['/notes', '/punishments']) it(`does not log invalid submitted bodies at ${url}`, async () => {
        const app = Fastify({ logger: false });
        await app.register(url === '/notes' ? notesRoutes : punishmentRoutes);
        try {
            const response = await app.inject({ method: 'POST', url, payload: { note_text: secret, reason: secret } });
            expect(response.statusCode).toBe(400);
            expect(state.databaseQuery).not.toHaveBeenCalled();
            expect(inspect(state.logError.mock.calls, { depth: null })).not.toContain(secret);
            expect(state.logError.mock.calls[0][0].issues.length).toBeGreaterThan(0);
        } finally { await app.close(); }
    });
});

import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    getAllQuotaRoleConfigs: vi.fn(),
    logQuotaEvent: vi.fn(),
    requireSecurity: vi.fn(),
    ensureGuildExists: vi.fn(),
    ensureMemberExists: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));

vi.mock('../../lib/auth/authorization.js', () => ({
    hasInternalRole: vi.fn(),
    hasRequiredRoleOrHigher: vi.fn(),
    requireSecurity: testState.requireSecurity,
    requireOfficer: vi.fn(),
    canManageGuildRoles: vi.fn(),
}));

vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureGuildExists: testState.ensureGuildExists,
    ensureMemberExists: testState.ensureMemberExists,
    ensureRaiderExists: vi.fn(),
}));

vi.mock('../../lib/quota/quota.js', () => ({
    logQuotaEvent: testState.logQuotaEvent,
    isRunAlreadyLogged: vi.fn(),
    getUserQuotaStats: vi.fn(),
    getQuotaRoleConfig: vi.fn(),
    getAllQuotaRoleConfigs: testState.getAllQuotaRoleConfigs,
    upsertQuotaRoleConfig: vi.fn(),
    getDungeonOverrides: vi.fn(),
    setDungeonOverride: vi.fn(),
    deleteDungeonOverride: vi.fn(),
    getPointsForDungeon: vi.fn(),
    getRaiderPointsConfig: vi.fn(),
    getRaiderPointsForDungeon: vi.fn(),
    setRaiderPointsForDungeon: vi.fn(),
    deleteRaiderPointsForDungeon: vi.fn(),
    getKeyPopPointsConfig: vi.fn(),
    getKeyPopPointsForDungeon: vi.fn(),
    setKeyPopPointsForDungeon: vi.fn(),
    deleteKeyPopPointsForDungeon: vi.fn(),
    getLeaderboard: vi.fn(),
    recalculateQuotaPoints: vi.fn(),
}));

vi.mock('../../lib/services/quota-service.js', () => ({ QuotaService: class {} }));
vi.mock('../../lib/database/transaction.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../../lib/dungeon-activity/activity-service.js', () => ({ recordManualRunActivity: vi.fn() }));
vi.mock('../../lib/services/quota-period-service.js', () => ({
    closeAndDeleteQuotaConfig: vi.fn(),
    finalizeDueQuotaPeriods: vi.fn(),
    getActiveQuotaLeaderboard: vi.fn(),
    getActiveQuotaPeriod: vi.fn(),
    getQuotaPeriodScanItems: vi.fn(),
    getQuotaPeriodHistory: vi.fn(),
    getUnpostedFinalizedQuotaPeriods: vi.fn(),
    manuallyResetQuotaPeriod: vi.fn(),
    markQuotaLogAttempt: vi.fn(),
}));
vi.mock('../../lib/runs/run-physical-key-logging.js', () => ({
    logRunPhysicalKeys: vi.fn(),
    RunPhysicalKeyLogError: class extends Error {},
}));

import quotaRoutes from './quota.js';

const guildId = '100000000000000001';
const reviewerId = '100000000000000002';
const quotaRoleId = '100000000000000003';

function quotaConfig(verifyPoints: number) {
    return {
        guild_id: guildId,
        discord_role_id: quotaRoleId,
        required_points: 10,
        reset_at: '2026-09-10T00:00:00.000Z',
        panel_message_id: null,
        period_start_at: '2026-09-03T00:00:00.000Z',
        reset_interval_days: 7,
        rollover_enabled: false,
        moderation_points: 0,
        base_exalt_points: 1,
        base_non_exalt_points: 0,
        misc_points_per_minute: 0,
        verify_points: verifyPoints,
        warn_points: 0,
        suspend_points: 0,
        modmail_reply_points: 0,
        editname_points: 0,
        addnote_points: 0,
    };
}

async function award(subjectId: string) {
    return app.inject({
        method: 'POST',
        url: `/quota/award-moderation-points/${guildId}/${reviewerId}`,
        payload: {
            actor_user_id: reviewerId,
            actor_roles: [quotaRoleId],
            command_type: 'verify',
            subject_id: subjectId,
        },
    });
}

let app: FastifyInstance;

describe('manual verification quota credit', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        app = Fastify();
        await app.register(quotaRoutes);
        testState.requireSecurity.mockResolvedValue(undefined);
        testState.ensureGuildExists.mockResolvedValue(undefined);
        testState.ensureMemberExists.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await app.close();
    });

    it.each([
        ['approval', 'manual_verification:target:approval'],
        ['rejection', 'manual_verification:target:rejection'],
    ])('awards the configured verify_points value for %s', async (_decision, subjectId) => {
        testState.getAllQuotaRoleConfigs.mockResolvedValue([quotaConfig(2.5)]);
        testState.logQuotaEvent.mockResolvedValue({ id: 1, points: 0, quota_points: 2.5 });

        const response = await award(subjectId);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ points_awarded: 2.5, quota_role_id: quotaRoleId });
        expect(testState.logQuotaEvent).toHaveBeenCalledWith(
            guildId,
            reviewerId,
            'verify_member',
            subjectId,
            undefined,
            2.5,
            quotaRoleId
        );
    });

    it.each([0, 4.25])('uses the same changed verify_points value (%s) for approval and rejection', async points => {
        testState.getAllQuotaRoleConfigs.mockResolvedValue([quotaConfig(points)]);
        testState.logQuotaEvent.mockImplementation(async (
            _guildId: string,
            _actorId: string,
            _actionType: string,
            _subjectId: string,
            _dungeonKey: string | undefined,
            quotaPoints: number
        ) => points > 0 ? { id: 1, points: 0, quota_points: quotaPoints } : null);

        const approval = await award(`manual_verification:target:approval:${points}`);
        const rejection = await award(`manual_verification:target:rejection:${points}`);

        expect(approval.json().points_awarded).toBe(points);
        expect(rejection.json().points_awarded).toBe(points);
        expect(testState.logQuotaEvent).toHaveBeenNthCalledWith(
            1, guildId, reviewerId, 'verify_member', expect.stringContaining(':approval:'), undefined, points,
            points > 0 ? quotaRoleId : undefined
        );
        expect(testState.logQuotaEvent).toHaveBeenNthCalledWith(
            2, guildId, reviewerId, 'verify_member', expect.stringContaining(':rejection:'), undefined, points,
            points > 0 ? quotaRoleId : undefined
        );
    });

    it('does not double-credit a retried rejection subject', async () => {
        const seenSubjects = new Set<string>();
        testState.getAllQuotaRoleConfigs.mockResolvedValue([quotaConfig(3)]);
        testState.logQuotaEvent.mockImplementation(async (
            _guildId: string,
            _actorId: string,
            _actionType: string,
            subjectId: string,
            _dungeonKey: string | undefined,
            quotaPoints: number
        ) => {
            if (seenSubjects.has(subjectId)) return null;
            seenSubjects.add(subjectId);
            return { id: 1, points: 0, quota_points: quotaPoints };
        });

        const subjectId = 'manual_verification:target:rejection:retry';
        const first = await award(subjectId);
        const retry = await award(subjectId);

        expect(first.json().points_awarded).toBe(3);
        expect(retry.json().points_awarded).toBe(0);
        expect(seenSubjects).toEqual(new Set([subjectId]));
    });

    it('defines one verification setting and a durable idempotency key without rejection-specific configuration', async () => {
        const quotaRouteSource = await readFile(new URL('./quota.ts', import.meta.url), 'utf8');
        const quotaConfigSource = await readFile(new URL('../../lib/quota/quota.ts', import.meta.url), 'utf8');
        const quotaUiSource = await readFile(
            new URL('../../../../bot/src/interactions/buttons/config/quota-config.ts', import.meta.url),
            'utf8'
        );
        const migrationSource = await readFile(
            new URL('../../db/migrations/071_verification_quota_idempotency.sql', import.meta.url),
            'utf8'
        );
        const separateSettingName = ['reject', 'verification', 'points'].join('_');

        expect(`${quotaRouteSource}\n${quotaConfigSource}\n${quotaUiSource}`).not.toContain(separateSettingName);
        expect(migrationSource).toContain('CREATE UNIQUE INDEX idx_quota_event_verification_idempotency');
        expect(migrationSource).toContain("WHERE action_type = 'verify_member' AND subject_id IS NOT NULL");
    });
});

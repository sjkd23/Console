import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    query: vi.fn(),
    createRunWithTransaction: vi.fn(),
    chainOryx3RunWithTransaction: vi.fn(),
    hasInternalRole: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
    query: testState.query,
}));

vi.mock('../../lib/auth/authorization.js', () => ({
    hasInternalRole: testState.hasInternalRole,
    authorizeRunActor: vi.fn(),
    buildRunActorContext: vi.fn(),
}));

vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureMemberExists: vi.fn(),
    getGuildRoles: vi.fn(),
}));

vi.mock('../../lib/services/run-service.js', () => ({
    createRunWithTransaction: testState.createRunWithTransaction,
    chainOryx3RunWithTransaction: testState.chainOryx3RunWithTransaction,
    endRunWithTransaction: vi.fn(),
    recordKeyPopWithTransaction: vi.fn(),
    Oryx3KeyPopError: class extends Error {},
}));

import runsRoutes from './runs.js';

const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const organizerRoleId = '100000000000000003';
const channelId = '100000000000000004';

describe('run ID HTTP contract', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = Fastify();
        app.addHook('preHandler', async request => {
            Object.assign(request, { guildContext: { guildId } });
        });
        await app.register(runsRoutes);
        testState.hasInternalRole.mockResolvedValue(true);
        testState.createRunWithTransaction.mockResolvedValue({
            // Deliberately mirror pg's BIGINT representation at the boundary.
            runId: '674',
            dungeonKey: 'NEST',
            dungeonLabel: 'Nest',
            runKind: 'single',
            activityKey: 'NEST',
            selectedDungeons: [
                { dungeonKey: 'NEST', dungeonLabel: 'Nest', selectionOrder: 1 },
            ],
        });
    });

    afterEach(async () => {
        await app.close();
    });

    it('serializes POST /runs runId as the canonical number when pg supplied a string BIGINT', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/runs',
            payload: {
                guildId,
                guildName: 'Test Guild',
                organizerId,
                organizerUsername: 'Organizer',
                organizerRoles: [organizerRoleId],
                channelId,
                selectedDungeonKeys: ['NEST'],
                autoEndMinutes: 120,
            },
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ runId: 674 });
        expect(typeof response.json().runId).toBe('number');
    });

    it('serializes GET /runs/:id id using the same numeric representation', async () => {
        testState.query.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: '675',
                guild_id: guildId,
                channel_id: channelId,
                post_message_id: null,
                dungeon_key: 'ICE_CITADEL',
                dungeon_label: 'Ice Citadel',
                run_kind: 'single',
                activity_key: 'ICE_CITADEL',
                selected_dungeons: [
                    { dungeonKey: 'ICE_CITADEL', dungeonLabel: 'Ice Citadel', selectionOrder: 1 },
                ],
                status: 'open',
                organizer_id: organizerId,
                finalization_kind: null,
                organizer_minute_quota: { eligible: false, snapshottedRate: null, quotaRoleId: null,
                    maxWholeMinutes: null, maxPoints: null, invalidReason: null },
                started_at: null,
                ended_at: null,
                created_at: '2026-08-29T00:00:00.000Z',
                auto_end_minutes: 120,
                key_window_ends_at: null,
                party: null,
                location: null,
                description: null,
                role_id: null,
                ping_message_id: null,
                key_pop_count: 0,
                chain_amount: null,
                screenshot_url: null,
                o3_stage: null,
                join_locked: false,
                chained_from_run_id: null,
            }],
        });

        const response = await app.inject({
            method: 'GET',
            url: '/runs/675',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: 675 });
        expect(typeof response.json().id).toBe('number');
    });

    it('normalizes run IDs in active and expired run list responses', async () => {
        testState.query
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    id: '676',
                    dungeon_label: 'Nest',
                    status: 'open',
                    created_at: '2026-08-29T00:00:00.000Z',
                    channel_id: channelId,
                    post_message_id: null,
                }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ id: '677', role_id: null }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    id: '678',
                    guild_id: guildId,
                    channel_id: channelId,
                    post_message_id: null,
                    dungeon_label: 'Nest',
                    organizer_id: organizerId,
                    created_at: '2026-08-29T00:00:00.000Z',
                    auto_end_minutes: 120,
                    role_id: null,
                    ping_message_id: null,
                }],
            });

        const organizerResponse = await app.inject({
            method: 'GET',
            url: `/runs/active-by-organizer/${organizerId}`,
        });
        const activeResponse = await app.inject({ method: 'GET', url: '/runs/active' });
        const expiredResponse = await app.inject({ method: 'GET', url: '/runs/expired' });

        expect(organizerResponse.json()).toMatchObject({ activeRuns: [{ id: 676 }] });
        expect(activeResponse.json()).toMatchObject({ runs: [{ id: 677 }] });
        expect(expiredResponse.json()).toMatchObject({ expired: [{ id: 678 }] });
    });

    it('creates a canonical new run ID through the O3 chain endpoint', async () => {
        testState.query.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                status: 'ended',
                organizer_id: organizerId,
                guild_id: guildId,
                run_kind: 'oryx_3',
            }],
        });
        testState.chainOryx3RunWithTransaction.mockResolvedValueOnce({
            runId: '701',
            dungeonKey: 'ORYX_3',
            dungeonLabel: 'Oryx 3',
            runKind: 'oryx_3',
            activityKey: 'ORYX_3',
            selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
        });

        const response = await app.inject({
            method: 'POST',
            url: '/runs/700/o3-chain',
            payload: {
                actorId: organizerId,
                actorRoles: [organizerRoleId],
                guildName: 'Test Guild',
                organizerUsername: 'Organizer',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ runId: 701, runKind: 'oryx_3' });
        expect(testState.chainOryx3RunWithTransaction).toHaveBeenCalledWith(expect.objectContaining({
            previousRunId: 700,
            guildId,
        }));
    });
});

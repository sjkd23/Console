import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('../../db/pool.js', () => ({
    pool: {
        connect: () => database.pool!.connect(),
        query: (sql: string, params?: unknown[]) => database.pool!.query(sql, params),
    },
    query: (sql: string, params?: unknown[]) => database.pool!.query(sql, params),
}));

import { createRunWithTransaction, startRunWithTransaction, endRunWithTransaction,
    cancelRunWithTransaction, recordKeyPopWithTransaction } from '../services/run-service.js';
import { getQuotaRoleConfig, upsertQuotaRoleConfig } from '../quota/quota.js';
import { getUserQuotaStats } from '../quota/quota.js';
import {
    cancelOrganizerMinuteSettlement,
    confirmOrganizerMinuteSettlement,
    getOrganizerMinuteSettlement,
    recoverOrganizerMinutes,
    modifyOrganizerMinuteSettlement,
} from '../services/organizer-minute-settlement-service.js';
import { ORGANIZER_MINUTE_QUOTA_SQL, OrganizerMinuteQuotaSchema, resolveMinuteQuotaRole, MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS, isMinuteOrganizerQuotaRun } from './minute-quota.js';
import { DUNGEONS } from '../../config/raid-config.js';
import quotaRoutes from '../../routes/raid/quota.js';
import runsRoutes from '../../routes/raid/runs.js';
import organizerMinuteSettlementRoutes from '../../routes/raid/organizer-minute-settlements.js';
import { manuallyResetQuotaPeriod } from '../services/quota-period-service.js';

const connectionString = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(connectionString));
const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const roleId = '100000000000000003';
const otherRoleId = '100000000000000004';
const raiderId = '100000000000000005';
const channelId = '100000000000000006';

integration('Phase E PostgreSQL lifecycle, configuration, and migration', () => {
    const schema = `phase_e_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    const app = Fastify();
    let migrationEvidence: { configs: unknown[]; runs: unknown[]; ledgersUnchanged: boolean };
    let revisionEvidence: { configs: unknown[]; runsUnchanged: boolean; ledgersUnchanged: boolean };

    beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        database.pool = new Pool({ connectionString, options: `-c search_path=${schema}`, application_name: schema });
        const client = await database.pool.connect();
        try {
            const directory = resolve(process.cwd(), 'src/db/migrations');
            for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && file < '066_').sort()) {
                await client.query(readFileSync(resolve(directory, file), 'utf8'));
            }
            await client.query('INSERT INTO guild (id, name) VALUES ($1, $2)', [guildId, 'Phase E test']);
            await client.query('INSERT INTO member (id) VALUES ($1), ($2)', [organizerId, raiderId]);
            await client.query(`INSERT INTO quota_role_config (guild_id, discord_role_id, base_exalt_points, base_non_exalt_points)
                                VALUES ($1, $2, 2.57, 0.29)`, [guildId, roleId]);
            for (const status of ['open', 'live', 'ended']) {
                await client.query(`INSERT INTO run (guild_id, organizer_id, dungeon_key, dungeon_label, run_kind, activity_key, status)
                                    VALUES ($1, $2, 'REALM_DUNGEON', 'Realm Clearing', 'realm_clearing', 'MISC_DUNGEONS', $3)`,
                [guildId, organizerId, status]);
            }
            await client.query(`INSERT INTO quota_event (guild_id, actor_user_id, action_type, subject_id, points, quota_points)
                                VALUES ($1, $2, 'run_completed', 'historical-test', 0, 1.23)`, [guildId, organizerId]);
            await client.query(`INSERT INTO dungeon_activity_event
                                (guild_id, user_id, role, dungeon_stats_key, subject_id, source, count, occurred_at)
                                VALUES ($1, $2, 'organizer', 'MISC_DUNGEONS', 'historical-test', 'key_pop', 3, now())`, [guildId, organizerId]);
            const before = await ledgers(client);
            await client.query(readFileSync(resolve(directory, '066_minute_organizer_quota.sql'), 'utf8'));
            migrationEvidence = {
                configs: (await client.query('SELECT misc_points_per_minute::text, base_exalt_points::text, base_non_exalt_points::text FROM quota_role_config')).rows,
                runs: (await client.query('SELECT status, organizer_minute_rate, organizer_minute_quota_role_id, finalization_kind FROM run')).rows,
                ledgersUnchanged: JSON.stringify(before) === JSON.stringify(await ledgers(client)),
            };
            // An old default of 1 cannot be distinguished from an administrator's chosen 1.
            await client.query('INSERT INTO quota_role_config (guild_id, discord_role_id) VALUES ($1, $2)', [guildId, otherRoleId]);
            const runsBefore = (await client.query('SELECT * FROM run ORDER BY id')).rows;
            await client.query(readFileSync(resolve(directory, '067_non_exalt_minute_quota.sql'), 'utf8'));
            revisionEvidence = {
                configs: (await client.query('SELECT base_non_exalt_points::text FROM quota_role_config ORDER BY discord_role_id')).rows,
                runsUnchanged: JSON.stringify(runsBefore) === JSON.stringify((await client.query('SELECT * FROM run ORDER BY id')).rows),
                ledgersUnchanged: JSON.stringify(before) === JSON.stringify(await ledgers(client)),
            };
            await client.query(readFileSync(resolve(directory, '068_manual_quota_adjustments.sql'), 'utf8'));
            await client.query(readFileSync(resolve(directory, '069_organizer_minute_settlements.sql'), 'utf8'));
            // The historical migration assertions above stay pinned; lifecycle tests below
            // exercise today's service and therefore need the rest of today's schema.
            for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && file >= '070_').sort()) {
                await client.query(readFileSync(resolve(directory, file), 'utf8'));
            }
        } finally {
            client.release();
        }
        app.addHook('onRequest', async request => {
            const header = request.headers['x-guild-id'];
            if (typeof header === 'string') request.guildContext = { guildId: header };
        });
        await app.register(quotaRoutes);
        await app.register(runsRoutes);
        await app.register(organizerMinuteSettlementRoutes);
    }, 30000);

    beforeEach(async () => {
        await database.pool!.query('DELETE FROM quota_role_config WHERE guild_id = $1', [guildId]);
        await database.pool!.query(`INSERT INTO quota_role_config (guild_id, discord_role_id, base_exalt_points, base_non_exalt_points)
                                   VALUES ($1, $2, 2, 0.5)`, [guildId, roleId]);
    });

    afterAll(async () => {
        await app.close();
        await database.pool?.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
    });

    async function ledgers(client: PoolClient) {
        return {
            quota: (await client.query('SELECT * FROM quota_event ORDER BY id')).rows,
            activity: (await client.query('SELECT * FROM dungeon_activity_event ORDER BY id')).rows,
            adjustments: (await client.query('SELECT * FROM dungeon_activity_adjustment ORDER BY id')).rows,
        };
    }

    async function create(keys = ['REALM_DUNGEON']) {
        return (await createRunWithTransaction({ guildId, guildName: 'Phase E test', organizerId,
            organizerUsername: 'Organizer', channelId, selectedDungeonKeys: keys, party: 'Party', location: 'USW', autoEndMinutes: 120 })).runId;
    }
    async function start(runId: number, roles = [roleId], positions: Record<string, number> = {}) {
        await startRunWithTransaction({ runId, guildId, organizerRoles: roles, organizerRolePositions: positions });
    }
    async function row(runId: number) {
        return (await database.pool!.query(`SELECT status, started_at::text, ended_at::text, organizer_minute_rate::text,
            organizer_minute_quota_role_id::text, finalization_kind, key_pop_count FROM run WHERE id = $1`, [runId])).rows[0];
    }
    async function basis(runId: number) {
        const result = await database.pool!.query(`SELECT ${ORGANIZER_MINUTE_QUOTA_SQL} AS basis FROM run WHERE id = $1`, [runId, MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS]);
        return OrganizerMinuteQuotaSchema.parse(result.rows[0].basis);
    }
    async function config(rate: number, id = roleId) {
        await upsertQuotaRoleConfig(guildId, id, { misc_points_per_minute: rate });
    }
    async function entries(runId: number, count: number) {
        await database.pool!.query(`INSERT INTO reaction (run_id, user_id, state) VALUES ($1, $2, 'join')`, [runId, raiderId]);
        for (let i = 0; i < count; i++) {
            await recordKeyPopWithTransaction({ runId, guildId, expectedKeyPopCount: i, keyWindowSeconds: 25, organizerRoles: [roleId] });
        }
    }
    async function payable(keys = ['REALM_DUNGEON'], minutes = 5, rate = 0.29) {
        await config(rate);
        const runId = await create(keys);
        await start(runId);
        await database.pool!.query(
            "UPDATE run SET started_at = statement_timestamp() - $2 * interval '1 minute' WHERE id = $1",
            [runId, minutes]
        );
        const ended = await endRunWithTransaction({ runId, guildId });
        return { runId, settlement: ended.organizerMinuteSettlement! };
    }

    it('adds defaults without changing historical run evidence or either ledger', () => {
        expect(migrationEvidence.configs).toEqual([{ misc_points_per_minute: '0.10', base_exalt_points: '2.57', base_non_exalt_points: '0.29' }]);
        expect(migrationEvidence.runs).toHaveLength(3);
        for (const run of migrationEvidence.runs) expect(run).toMatchObject({ organizer_minute_rate: null, organizer_minute_quota_role_id: null, finalization_kind: null });
        expect(migrationEvidence.ledgersUnchanged).toBe(true);
    });

    it('changes future SQL and API defaults without resetting existing config values or history', async () => {
        expect(revisionEvidence).toEqual({ configs: [{ base_non_exalt_points: '0.29' }, { base_non_exalt_points: '1.00' }], runsUnchanged: true, ledgersUnchanged: true });
        await database.pool!.query('INSERT INTO quota_role_config (guild_id, discord_role_id) VALUES ($1, $2)', [guildId, otherRoleId]);
        expect(await getQuotaRoleConfig(guildId, otherRoleId)).toMatchObject({ base_non_exalt_points: 0, misc_points_per_minute: 0.1 });
        await database.pool!.query('DELETE FROM quota_role_config WHERE guild_id = $1 AND discord_role_id = $2', [guildId, otherRoleId]);
        const saved = await app.inject({ method: 'PUT', url: `/quota/config/${guildId}/${otherRoleId}`, payload: { actor_user_id: organizerId, actor_has_admin_permission: true } });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().config).toMatchObject({ base_non_exalt_points: 0, misc_points_per_minute: 0.1 });
    });

    it.each(['0', '0.1', '0.10', '0.29', '0.57', '1.10'])('round-trips %s through the config API and preserves partial updates', async value => {
        const saved = await app.inject({ method: 'PUT', url: `/quota/config/${guildId}/${roleId}`, payload: {
            actor_user_id: organizerId, actor_has_admin_permission: true, misc_points_per_minute: value,
        } });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().config.misc_points_per_minute).toBe(Number(value));
        await upsertQuotaRoleConfig(guildId, roleId, { base_exalt_points: 3 });
        const loaded = await app.inject({ method: 'GET', url: `/quota/config/${guildId}/${roleId}` });
        expect(loaded.json().config).toMatchObject({ misc_points_per_minute: Number(value), base_exalt_points: 3, base_non_exalt_points: 0.5 });
    });

    it.each(['-0.1', 'NaN', 'Infinity', '0.1abc', '0.001', '100000000'])('rejects invalid API rate %s without updating configuration', async value => {
        const saved = await app.inject({ method: 'PUT', url: `/quota/config/${guildId}/${roleId}`, payload: {
            actor_user_id: organizerId, actor_has_admin_permission: true, misc_points_per_minute: value,
        } });
        expect(saved.statusCode).toBe(400);
        expect((await getQuotaRoleConfig(guildId, roleId))?.misc_points_per_minute).toBe(0.1);
    });

    it.each(['-0.1', 'NaN', '100000000'])('database constraint rejects rate %s', async value => {
        await expect(database.pool!.query('UPDATE quota_role_config SET misc_points_per_minute = $1 WHERE discord_role_id = $2', [value, roleId])).rejects.toThrow();
    });

    it('preserves existing config fields and the panel ID when updating only the new rate', async () => {
        const existing = { base_exalt_points: 0.29, base_non_exalt_points: 0.57, moderation_points: 2,
            verify_points: 3, warn_points: 4, suspend_points: 5, modmail_reply_points: 6,
            editname_points: 7, addnote_points: 8, reset_interval_days: 14, rollover_enabled: true,
            panel_message_id: channelId };
        await upsertQuotaRoleConfig(guildId, roleId, existing);
        await config(0);
        expect(await getQuotaRoleConfig(guildId, roleId)).toMatchObject({ ...existing, misc_points_per_minute: 0 });
    });

    it('rejects contradictory snapshot and finalization evidence in the database', async () => {
        const exalt = await create(['NEST', 'FUNGAL_CAVERN']);
        await expect(database.pool!.query('UPDATE run SET organizer_minute_rate = 0 WHERE id = $1', [exalt])).rejects.toThrow(/run_minute_snapshot_check/);
        const minute = await create();
        await expect(database.pool!.query('UPDATE run SET organizer_minute_rate = 0.1 WHERE id = $1', [minute])).rejects.toThrow(/run_minute_snapshot_check/);
        await expect(database.pool!.query('UPDATE run SET organizer_minute_quota_role_id = $2 WHERE id = $1', [minute, roleId])).rejects.toThrow(/run_minute_snapshot_check/);
        await expect(database.pool!.query("UPDATE run SET finalization_kind = 'completed' WHERE id = $1", [minute])).rejects.toThrow(/run_finalization_kind_check/);
        await expect(database.pool!.query("UPDATE run SET finalization_kind = 'unknown' WHERE id = $1", [minute])).rejects.toThrow(/run_finalization_kind_check/);
    });

    it('resolves only matching roles by rate, position, then numeric ID, including zero', async () => {
        const client = await database.pool!.connect();
        try {
            await config(0.29);
            await config(0.57, otherRoleId);
            expect(await resolveMinuteQuotaRole(client, guildId, [roleId])).toEqual({ roleId, rate: '0.29' });
            expect(await resolveMinuteQuotaRole(client, guildId, [roleId, otherRoleId], { [roleId]: 99 })).toEqual({ roleId: otherRoleId, rate: '0.57' });
            await config(0.57);
            expect(await resolveMinuteQuotaRole(client, guildId, [otherRoleId, roleId], { [otherRoleId]: 10 })).toEqual({ roleId: otherRoleId, rate: '0.57' });
            expect(await resolveMinuteQuotaRole(client, guildId, [otherRoleId, roleId], { [otherRoleId]: 10, [roleId]: 10 })).toEqual({ roleId, rate: '0.57' });
            await config(0);
            expect(await resolveMinuteQuotaRole(client, guildId, [roleId])).toEqual({ roleId, rate: '0.00' });
            expect(await resolveMinuteQuotaRole(client, guildId, [raiderId])).toBeNull();
            expect(await resolveMinuteQuotaRole(client, guildId, [])).toBeNull();
        } finally { client.release(); }
    });

    it.each([['SNAKE_PIT'], ['ABYSS_OF_DEMONS'], ['REALM_DUNGEON'], ['SNAKE_PIT', 'MAGIC_WOODS'], ['REALM_DUNGEON', 'SNAKE_PIT', 'ABYSS_OF_DEMONS']])('snapshots and freezes minute run %j', async (...keys) => {
        await config(0.29);
        const runId = await create(keys);
        expect(await basis(runId)).toMatchObject({ eligible: false, snapshottedRate: null, maxWholeMinutes: null });
        await start(runId);
        const started = await row(runId);
        expect(started).toMatchObject({ status: 'live', organizer_minute_rate: '0.29', organizer_minute_quota_role_id: roleId });
        expect(await basis(runId)).toMatchObject({ eligible: false, snapshottedRate: 0.29, maxWholeMinutes: null });
        await config(2);
        await config(9, otherRoleId);
        await expect(start(runId, [otherRoleId])).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
        await database.pool!.query('DELETE FROM quota_role_config WHERE guild_id = $1', [guildId]);
        expect(await row(runId)).toEqual(started);
        await endRunWithTransaction({ runId, guildId });
        expect(await basis(runId)).toMatchObject({ eligible: true, snapshottedRate: 0.29, quotaRoleId: roleId });
    });

    it.each([['NEST'], ['NEST', 'FUNGAL_CAVERN'], ['ORYX_3']])('does not snapshot non-minute kind %j', async (...keys) => {
        const runId = await create(keys);
        if (keys[0] === 'ORYX_3') await database.pool!.query("UPDATE run SET screenshot_url = 'https://example.test/screenshot' WHERE id = $1", [runId]);
        await start(runId);
        expect(await row(runId)).toMatchObject({ organizer_minute_rate: null, organizer_minute_quota_role_id: null });
        expect(await basis(runId)).toMatchObject({ eligible: false, snapshottedRate: null });
    });

    it('keeps Start, the domain predicate, and SQL reads consistent across authoritative dungeon metadata', async () => {
        for (const dungeon of DUNGEONS) {
            const expected = dungeon.selectionClass === 'non_exalt' || dungeon.selectionClass === 'realm_clearing';
            const runId = await create([dungeon.code]);
            // Labels deliberately contradict the classification and must never affect compensation.
            await database.pool!.query('UPDATE run SET dungeon_label = $2, screenshot_url = $3 WHERE id = $1',
                [runId, expected ? 'Nest Exaltation' : 'Snake Pit', 'https://example.test/proof']);
            await start(runId);
            await endRunWithTransaction({ runId, guildId });
            expect((await basis(runId)).eligible, dungeon.code).toBe(expected);
            expect((await row(runId)).organizer_minute_rate, dungeon.code).toBe(expected ? '0.10' : null);
            const persisted = (await database.pool!.query('SELECT run_kind, activity_key FROM run WHERE id = $1', [runId])).rows[0];
            expect(isMinuteOrganizerQuotaRun(persisted), dungeon.code).toBe(expected);
        }
        expect(isMinuteOrganizerQuotaRun({ run_kind: 'single', activity_key: 'UNKNOWN' })).toBe(false);
        expect(isMinuteOrganizerQuotaRun({ run_kind: 'single', activity_key: 'ORYX_3' })).toBe(false);
    });

    it('distinguishes no matching role, configured zero, and unavailable context', async () => {
        const noMatch = await create();
        await start(noMatch, [raiderId]);
        expect(await row(noMatch)).toMatchObject({ organizer_minute_rate: '0.00', organizer_minute_quota_role_id: null });
        await config(0);
        const zero = await create();
        await start(zero);
        expect(await row(zero)).toMatchObject({ organizer_minute_rate: '0.00', organizer_minute_quota_role_id: roleId });
        const unavailable = await create();
        await expect(startRunWithTransaction({ runId: unavailable, guildId })).rejects.toMatchObject({ code: 'ORGANIZER_ROLE_CONTEXT_REQUIRED' });
        expect(await row(unavailable)).toMatchObject({ status: 'open', started_at: null, organizer_minute_rate: null });
    });

    it('rechecks party/location and O3 screenshot under the Start lock', async () => {
        const runId = await create();
        await database.pool!.query('UPDATE run SET party = NULL WHERE id = $1', [runId]);
        await expect(start(runId)).rejects.toMatchObject({ code: 'MISSING_PARTY_LOCATION' });
        const o3 = await create(['ORYX_3']);
        await expect(start(o3)).rejects.toMatchObject({ code: 'MISSING_SCREENSHOT' });
    });

    it('never substitutes an acting staff role for missing or nonmatching organizer context', async () => {
        await database.pool!.query(`INSERT INTO guild_role (guild_id, role_key, discord_role_id)
            VALUES ($1, 'organizer', $2) ON CONFLICT (guild_id, role_key) DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id`, [guildId, otherRoleId]);
        await config(9, otherRoleId);
        const runId = await create();
        const payload = { actorId: raiderId, actorRoles: [otherRoleId], status: 'live' };
        const missing = await app.inject({ method: 'PATCH', url: `/runs/${runId}`, payload });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().error.code).toBe('ORGANIZER_ROLE_CONTEXT_REQUIRED');
        expect(await row(runId)).toMatchObject({ status: 'open', started_at: null, organizer_minute_rate: null });
        const started = await app.inject({ method: 'PATCH', url: `/runs/${runId}`, payload: { ...payload, organizerRoles: [raiderId] } });
        expect(started.statusCode).toBe(200);
        expect(await row(runId)).toMatchObject({ status: 'live', organizer_minute_rate: '0.00', organizer_minute_quota_role_id: null });
    });

    it('starts historical open runs normally but never retroactively snapshots live or ended runs', async () => {
        const legacy = await database.pool!.query('SELECT id::int, status FROM run WHERE id IN (1, 2, 3) ORDER BY id');
        const open = legacy.rows.find(run => run.status === 'open').id;
        const live = legacy.rows.find(run => run.status === 'live').id;
        const ended = legacy.rows.find(run => run.status === 'ended').id;
        await database.pool!.query('UPDATE run SET party = $1, location = $2 WHERE id = $3', ['Party', 'USW', open]);
        await start(open);
        expect(await row(open)).toMatchObject({ organizer_minute_rate: '0.10', organizer_minute_quota_role_id: roleId });
        await expect(start(live)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
        await endRunWithTransaction({ runId: live, guildId });
        expect(await row(live)).toMatchObject({ organizer_minute_rate: null, finalization_kind: 'completed' });
        expect((await basis(live)).eligible).toBe(false);
        await endRunWithTransaction({ runId: ended, guildId, isAutoEnd: true });
        await cancelRunWithTransaction({ runId: ended, guildId });
        expect(await row(ended)).toMatchObject({ organizer_minute_rate: null, finalization_kind: null });
        expect((await basis(ended)).eligible).toBe(false);
    });

    it.each([['SNAKE_PIT'], ['REALM_DUNGEON'], ['SNAKE_PIT', 'MAGIC_WOODS']])('preserves three entries and raider awards without organizer quota at base zero for %j', async (...keys) => {
        await upsertQuotaRoleConfig(guildId, roleId, { base_non_exalt_points: 0 });
        const runId = await create(keys);
        await start(runId);
        await database.pool!.query(`INSERT INTO raider_points_config (guild_id, dungeon_key, points) VALUES ($1, 'REALM_DUNGEON', 0.57)
                                   ON CONFLICT (guild_id, dungeon_key) DO UPDATE SET points = EXCLUDED.points`, [guildId]);
        await entries(runId, 3);
        await endRunWithTransaction({ runId, guildId });
        const activity = await database.pool!.query('SELECT role, dungeon_stats_key, sum(count)::int AS count FROM dungeon_activity_event WHERE run_id = $1 GROUP BY role, dungeon_stats_key ORDER BY role', [runId]);
        expect(activity.rows).toEqual([
            { role: 'organizer', dungeon_stats_key: keys.length === 1 && keys[0] === 'SNAKE_PIT' ? 'SNAKE_PIT' : 'MISC_DUNGEONS', count: 3 },
            { role: 'raider', dungeon_stats_key: keys.length === 1 && keys[0] === 'SNAKE_PIT' ? 'SNAKE_PIT' : 'MISC_DUNGEONS', count: 3 },
        ]);
        const quota = await database.pool!.query('SELECT actor_user_id::text, points::text, quota_points::text FROM quota_event WHERE subject_id LIKE $1 OR subject_id LIKE $2', [`run:${runId}%`, `raider:${runId}:%`]);
        expect(quota.rows).toHaveLength(3);
        for (const event of quota.rows) expect(event).toEqual({ actor_user_id: raiderId, quota_points: '0.00', points: keys[0] === 'REALM_DUNGEON' ? '0.57' : '1.00' });
        expect((await database.pool!.query('SELECT * FROM key_pop_snapshot WHERE run_id = $1 AND awarded_completion = TRUE', [runId])).rowCount).toBe(3);
    });

    it.each([['REALM_DUNGEON'], ['SNAKE_PIT', 'MAGIC_WOODS'], ['NEST', 'FUNGAL_CAVERN']])('does not fabricate zero-entry aggregate activity for %j', async (...keys) => {
        const runId = await create(keys); await start(runId);
        await endRunWithTransaction({ runId, guildId });
        expect((await database.pool!.query('SELECT * FROM dungeon_activity_event WHERE run_id = $1', [runId])).rowCount).toBe(0);
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id = $1', [`run:${runId}`])).rowCount).toBe(0);
    });

    it.each([
        [['NEST'], true, '9.00'], [['NEST'], false, '2.00'], [['NEST', 'FUNGAL_CAVERN'], true, '2.00'],
    ] as const)('retains exact/base organizer routing for %j (override %s)', async (keys, override, expected) => {
        if (override) await database.pool!.query('INSERT INTO quota_dungeon_override (guild_id, discord_role_id, dungeon_key, points) VALUES ($1, $2, $3, 9)', [guildId, roleId, 'NEST']);
        const runId = await create([...keys]); await start(runId); await entries(runId, 1);
        const quota = await database.pool!.query('SELECT quota_points::text FROM quota_event WHERE subject_id = $1', [`run:${runId}:keypop:1`]);
        expect(quota.rows).toEqual([{ quota_points: expected }]);
    });

    it.each([
        [['SNAKE_PIT'], false, '1.00'], [['SNAKE_PIT'], true, '2.00'],
        [['REALM_DUNGEON'], false, '1.00'], [['REALM_DUNGEON'], true, '1.00'],
        [['SNAKE_PIT', 'ABYSS_OF_DEMONS'], false, '1.00'], [['SNAKE_PIT', 'ABYSS_OF_DEMONS'], true, '1.00'],
        [['REALM_DUNGEON', 'SNAKE_PIT'], true, '1.00'],
        [['NEST'], true, '2.00'], [['NEST', 'FUNGAL_CAVERN'], true, '1.00'],
    ] as const)('awards additive per-log points using exact/base routing for %j (overrides %s)', async (keys, overrides, expected) => {
        await upsertQuotaRoleConfig(guildId, roleId, { base_non_exalt_points: 1, base_exalt_points: 1 });
        if (overrides) {
            for (const key of ['SNAKE_PIT', 'ABYSS_OF_DEMONS', 'REALM_DUNGEON', 'NEST', 'FUNGAL_CAVERN']) {
                await database.pool!.query('INSERT INTO quota_dungeon_override (guild_id, discord_role_id, dungeon_key, points) VALUES ($1, $2, $3, 2)', [guildId, roleId, key]);
            }
        }
        const runId = await create([...keys]); await start(runId); await entries(runId, 3);
        await endRunWithTransaction({ runId, guildId });
        const events = await database.pool!.query('SELECT quota_points::text FROM quota_event WHERE subject_id LIKE $1 AND actor_user_id = $2', [`run:${runId}:keypop:%`, organizerId]);
        expect(events.rows).toEqual([{ quota_points: expected }, { quota_points: expected }, { quota_points: expected }]);
        expect((await basis(runId)).eligible).toBe(keys[0] !== 'NEST');
    });

    it.each([['SNAKE_PIT'], ['REALM_DUNGEON'], ['SNAKE_PIT', 'ABYSS_OF_DEMONS']])('does not replace an effective zero with unrelated guild role points for %j', async (...keys) => {
        await upsertQuotaRoleConfig(guildId, roleId, { base_non_exalt_points: 0 });
        await upsertQuotaRoleConfig(guildId, otherRoleId, { base_non_exalt_points: 9 });
        const runId = await create(keys); await start(runId); await entries(runId, 1);
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id = $1', [`run:${runId}:keypop:1`])).rowCount).toBe(0);
        expect((await database.pool!.query("SELECT * FROM dungeon_activity_event WHERE run_id = $1 AND role = 'organizer'", [runId])).rowCount).toBe(1);
    });

    it('honors a zero single-dungeon override even when its base is positive', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { base_non_exalt_points: 1 });
        await upsertQuotaRoleConfig(guildId, otherRoleId, { base_non_exalt_points: 9 });
        await database.pool!.query("INSERT INTO quota_dungeon_override (guild_id, discord_role_id, dungeon_key, points) VALUES ($1, $2, 'SNAKE_PIT', 0)", [guildId, roleId]);
        const runId = await create(['SNAKE_PIT']); await start(runId); await entries(runId, 1);
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id = $1', [`run:${runId}:keypop:1`])).rowCount).toBe(0);
    });

    it('exposes a one-minute 20/min Realm basis without awarding minute quota', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { base_non_exalt_points: 0, misc_points_per_minute: 20 });
        const runId = await create(); await start(runId);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '1 minute' WHERE id = $1", [runId]);
        await endRunWithTransaction({ runId, guildId });
        const response = await app.inject({ method: 'GET', url: `/runs/${runId}` });
        expect(response.statusCode).toBe(200);
        expect(response.json().organizerMinuteQuota).toMatchObject({ eligible: true, snapshottedRate: 20, maxWholeMinutes: 1, maxPoints: 20 });
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id LIKE $1', [`run:${runId}%`])).rowCount).toBe(0);
    });

    it('retains successful O3 accounting exactly once with completed outcome', async () => {
        const runId = await create(['ORYX_3']);
        await database.pool!.query("UPDATE run SET screenshot_url = 'https://example.test/proof' WHERE id = $1", [runId]);
        await start(runId);
        const endInput = { runId, guildId, organizerRoles: [roleId] };
        await endRunWithTransaction(endInput); const first = await row(runId);
        await endRunWithTransaction(endInput);
        expect(await row(runId)).toEqual(first);
        expect(first.finalization_kind).toBe('completed');
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id = $1', [`run:${runId}`])).rowCount).toBe(1);
        expect((await database.pool!.query('SELECT * FROM dungeon_activity_event WHERE run_id = $1', [runId])).rowCount).toBe(1);
    });

    it.each([false, true])('normal End is completed and stable (automatic=%s)', async isAutoEnd => {
        await config(0.29);
        const runId = await create(); await start(runId);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '3 minutes' WHERE id = $1", [runId]);
        await endRunWithTransaction({ runId, guildId, isAutoEnd });
        const first = await row(runId);
        await endRunWithTransaction({ runId, guildId, isAutoEnd });
        await cancelRunWithTransaction({ runId, guildId });
        expect(await row(runId)).toEqual(first);
        expect(first.finalization_kind).toBe('completed');
        expect(await basis(runId)).toMatchObject({ eligible: true, maxWholeMinutes: 3, maxPoints: 0.87 });
    });

    it('cancellation/cleanup wins permanently and an open timeout has no payable basis', async () => {
        const runId = await create(); await start(runId); await cancelRunWithTransaction({ runId, guildId });
        const first = await row(runId);
        await cancelRunWithTransaction({ runId, guildId }); await endRunWithTransaction({ runId, guildId, isAutoEnd: true });
        await expect(start(runId)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
        expect(await row(runId)).toEqual(first);
        expect(first.finalization_kind).toBe('cancelled'); expect((await basis(runId)).eligible).toBe(false);
        const open = await create(); await endRunWithTransaction({ runId: open, guildId, isAutoEnd: true });
        expect(await row(open)).toMatchObject({ finalization_kind: 'completed', organizer_minute_rate: null, started_at: null });
        expect((await basis(open)).eligible).toBe(false);
    });

    it('rolls back End and its outcome if final raider processing fails', async () => {
        const runId = await create(); await start(runId); await entries(runId, 1);
        // A conflicting canonical identity must abort the same transaction as the terminal update.
        await database.pool!.query(`INSERT INTO dungeon_activity_event
            (guild_id, user_id, run_id, role, dungeon_stats_key, subject_id, source, count, occurred_at)
            VALUES ($1, $2, $3, 'raider', 'WRONG', $4, 'key_pop', 1, now())`,
        [guildId, raiderId, runId, `run:${runId}:keypop:1:raider:${raiderId}`]);
        await expect(endRunWithTransaction({ runId, guildId })).rejects.toThrow(/already exists/);
        expect(await row(runId)).toMatchObject({ status: 'live', ended_at: null, finalization_kind: null });
    });

    async function waitForBlocked(count: number) {
        for (let attempt = 0; attempt < 200; attempt++) {
            const result = await admin.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [schema]);
            if (result.rows[0].count >= count) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Expected lifecycle calls to wait on the held run lock');
    }

    it('concurrent Starts serialize, and Start time is after the held lock is released', async () => {
        const runId = await create(); const blocker = await database.pool!.connect();
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM run WHERE id = $1 FOR UPDATE', [runId]);
        const pending = Promise.allSettled([start(runId), start(runId)]);
        let releasedAt: string;
        try {
            await waitForBlocked(2);
            releasedAt = (await blocker.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
        } finally { await blocker.query('COMMIT'); blocker.release(); }
        const results = await pending;
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect((await database.pool!.query('SELECT started_at >= $2::timestamptz AS after_lock FROM run WHERE id = $1', [runId, releasedAt])).rows[0].after_lock).toBe(true);
    });

    it.each(['end', 'cancel'] as const)('Start racing %s cannot restore a terminal run', async terminal => {
        const runId = await create();
        const results = await Promise.allSettled([start(runId), terminal === 'end'
            ? endRunWithTransaction({ runId, guildId, isAutoEnd: true }) : cancelRunWithTransaction({ runId, guildId })]);
        expect(results[1].status).toBe('fulfilled');
        const persisted = await row(runId);
        expect(persisted.status).toBe('ended');
        expect(persisted.finalization_kind).toBe(terminal === 'end' ? 'completed' : 'cancelled');
        await expect(start(runId)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
        expect(await row(runId)).toEqual(persisted);
    });

    it.each(['completed', 'cancelled'] as const)('preserves the first %s outcome when End and Cancel compete', async first => {
        const runId = await create(); await start(runId);
        const blocker = await database.pool!.connect();
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM run WHERE id = $1 FOR UPDATE', [runId]);
        const complete = () => endRunWithTransaction({ runId, guildId });
        const cancel = () => cancelRunWithTransaction({ runId, guildId });
        const firstCall = first === 'completed' ? complete() : cancel();
        let secondCall: Promise<unknown> | undefined;
        try {
            await waitForBlocked(1);
            secondCall = first === 'completed' ? cancel() : complete();
            await waitForBlocked(2);
        } finally { await blocker.query('COMMIT'); blocker.release(); }
        await Promise.all([firstCall, secondCall]);
        const terminal = await row(runId);
        expect(terminal.finalization_kind).toBe(first);
        await complete(); await cancel();
        expect(await row(runId)).toEqual(terminal);
    });

    async function calculate(started: string | null, ended: string | null, rate = '0.10') {
        // A virtual run permits corrupt/legacy timestamps without weakening production constraints.
        const result = await database.pool!.query(`WITH run AS (SELECT 'realm_clearing'::text AS run_kind,
            'MISC_DUNGEONS'::text AS activity_key, 'ended'::text AS status, 'completed'::text AS finalization_kind,
            $1::timestamptz AS started_at, $3::timestamptz AS ended_at,
            $4::numeric AS organizer_minute_rate, $5::bigint AS organizer_minute_quota_role_id)
            SELECT ${ORGANIZER_MINUTE_QUOTA_SQL} AS basis FROM run`, [started, MINUTE_ORGANIZER_SINGLE_DUNGEON_KEYS, ended, rate, roleId]);
        return OrganizerMinuteQuotaSchema.parse(result.rows[0].basis);
    }

    it.each([[0, 0], [59, 0], [60, 1], [119, 1], [120, 2]])('floors %s seconds to %s whole minutes in Postgres', async (seconds, minutes) => {
        const end = (await database.pool!.query("SELECT ('2026-08-01 00:00:00+00'::timestamptz + $1 * interval '1 second')::text AS end", [seconds])).rows[0].end;
        expect(await calculate('2026-08-01 00:00:00+00', end)).toMatchObject({ eligible: true, maxWholeMinutes: minutes, maxPoints: Number((minutes / 10).toFixed(2)) });
    });

    it('preserves sub-millisecond precision and exact numeric multiplication', async () => {
        expect(await calculate('2026-08-01 00:00:00.000999+00', '2026-08-01 00:01:00.000001+00')).toMatchObject({ maxWholeMinutes: 0, maxPoints: 0 });
        expect(await calculate('2026-08-01 00:00:00.000999+00', '2026-08-01 00:01:00.000999+00')).toMatchObject({ maxWholeMinutes: 1, maxPoints: 0.1 });
        expect(await calculate('2026-08-01 00:00:00+00', '2026-08-01 00:03:00+00')).toMatchObject({ maxWholeMinutes: 3, maxPoints: 0.3 });
        expect(await calculate('2026-08-01 00:00:00+00', '2026-08-01 00:03:00+00', '0.29')).toMatchObject({ maxPoints: 0.87 });
        expect(await calculate('2026-08-01 00:00:00+00', '2026-08-01 00:03:00+00', '0')).toMatchObject({ eligible: true, maxPoints: 0 });
    });

    it('handles missing/invalid timestamps, long runs, timezone offsets, and overflow explicitly', async () => {
        for (const pair of [[null, '2026-08-01'], ['2026-08-01', null]] as const) {
            expect(await calculate(pair[0], pair[1])).toMatchObject({ eligible: false, maxWholeMinutes: null, maxPoints: null });
        }
        expect(await calculate('2026-08-02', '2026-08-01')).toMatchObject({ eligible: false, invalidReason: 'invalid_timestamps' });
        expect(await calculate('2026-08-01', 'infinity')).toMatchObject({ eligible: false, invalidReason: 'invalid_timestamps' });
        expect(await calculate('2026-08-01', '2026-08-11')).toMatchObject({ maxWholeMinutes: 14400, maxPoints: 1440 });
        expect(await calculate('2026-08-01 00:00:00-04', '2026-08-01 04:01:00+00')).toMatchObject({ maxWholeMinutes: 1 });
        expect(await calculate('2026-08-01 00:00:00+00', '2026-08-01 00:02:00+00', '99999999.99')).toMatchObject({ eligible: false, maxWholeMinutes: null, maxPoints: null, invalidReason: 'out_of_range' });
        expect(await calculate('4710-01-01 BC', '294000-01-01')).toMatchObject({ eligible: false, maxPoints: null, invalidReason: 'out_of_range' });
    });

    it('exposes the same computed basis on GET /runs without creating settlement/event state', async () => {
        const runId = await create(); await start(runId); await endRunWithTransaction({ runId, guildId });
        const response = await app.inject({ method: 'GET', url: `/runs/${runId}` });
        expect(response.statusCode).toBe(200);
        expect(response.json().finalizationKind).toBe('completed');
        expect(response.json().organizerMinuteQuota).toEqual(await basis(runId));
        expect((await database.pool!.query('SELECT * FROM quota_event WHERE subject_id LIKE $1', [`run:${runId}%`])).rowCount).toBe(0);
    });

    it.each([
        [['SNAKE_PIT'], 'single'],
        [['REALM_DUNGEON'], 'realm_clearing'],
        [['SNAKE_PIT', 'MAGIC_WOODS'], 'multi_non_exalt'],
    ] as const)('creates one snapshotted pending minute row for payable %j', async (keys, runKind) => {
        const { runId, settlement } = await payable([...keys], 7, 0.29);
        expect(settlement).toMatchObject({
            runId, organizerId, runKind, quotaRoleId: roleId, rate: 0.29,
            maxMinutes: 7, selectedMinutes: 7, selectedPoints: 2.03,
            status: 'pending', revision: 0, quotaEventId: null,
        });
        await endRunWithTransaction({ runId, guildId });
        expect((await database.pool!.query('SELECT count(*)::int AS count FROM organizer_minute_settlement WHERE run_id = $1', [runId])).rows[0].count).toBe(1);
    });

    it.each([
        ['single exalt', ['NEST']],
        ['multi exalt', ['NEST', 'FUNGAL_CAVERN']],
        ['O3', ['ORYX_3']],
    ] as const)('creates no minute row for %s', async (_label, keys) => {
        const runId = await create([...keys]);
        if (keys[0] === 'ORYX_3') {
            await database.pool!.query("UPDATE run SET screenshot_url = 'https://example.test/proof' WHERE id = $1", [runId]);
        }
        await start(runId);
        const ended = await endRunWithTransaction({ runId, guildId });
        expect(ended.organizerMinuteSettlement).toBeNull();
        expect(await getOrganizerMinuteSettlement({ runId, guildId })).toBeNull();
    });

    it('creates no actionable row for zero duration, zero rate, no role, or cancellation', async () => {
        const zeroDuration = await create(); await start(zeroDuration);
        expect((await endRunWithTransaction({ runId: zeroDuration, guildId })).organizerMinuteSettlement).toBeNull();

        await config(0);
        const zeroRate = await create(); await start(zeroRate);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '2 minutes' WHERE id = $1", [zeroRate]);
        expect((await endRunWithTransaction({ runId: zeroRate, guildId })).organizerMinuteSettlement).toBeNull();

        await config(0.1);
        const noRole = await create(); await start(noRole, [raiderId]);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '2 minutes' WHERE id = $1", [noRole]);
        expect((await endRunWithTransaction({ runId: noRole, guildId })).organizerMinuteSettlement).toBeNull();

        const cancelled = await create(); await start(cancelled);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '2 minutes' WHERE id = $1", [cancelled]);
        await cancelRunWithTransaction({ runId: cancelled, guildId });
        expect(await getOrganizerMinuteSettlement({ runId: cancelled, guildId })).toBeNull();
    });

    it('books the snapshot exactly once at confirmation time without changing activity', async () => {
        const { runId, settlement } = await payable(['SNAKE_PIT'], 5, 0.29);
        const activityBefore = await database.pool!.query('SELECT count(*)::int AS count FROM dungeon_activity_event');
        await config(9);
        await database.pool!.query('DELETE FROM quota_role_config WHERE guild_id = $1', [guildId]);
        const confirmed = await confirmOrganizerMinuteSettlement({
            runId, guildId, actorId: organizerId, expectedRevision: settlement.revision,
        });
        expect(confirmed).toMatchObject({ status: 'confirmed', selectedMinutes: 5, selectedPoints: 1.45, rate: 0.29, quotaRoleId: roleId });
        const repeated = await confirmOrganizerMinuteSettlement({ runId, guildId, actorId: organizerId, expectedRevision: 0 });
        expect(repeated.quotaEventId).toBe(confirmed.quotaEventId);
        const events = await database.pool!.query(
            `SELECT actor_user_id::text, action_type, subject_id, dungeon_key,
                    points::text, quota_points::text, quota_role_id::text,
                    created_at >= (SELECT ended_at FROM run WHERE id = $1) AS booked_after_end
             FROM quota_event WHERE subject_id = $2`,
            [runId, `run:${runId}:organizer_minutes`]
        );
        expect(events.rows).toEqual([{
            actor_user_id: organizerId,
            action_type: 'organizer_minutes',
            subject_id: `run:${runId}:organizer_minutes`,
            dungeon_key: null,
            points: '0.00',
            quota_points: '1.45',
            quota_role_id: roleId,
            booked_after_end: true,
        }]);
        expect((await database.pool!.query('SELECT count(*)::int AS count FROM dungeon_activity_event')).rows[0].count)
            .toBe(activityBefore.rows[0].count);
    });

    it('enforces integer-minute bounds, revisions, terminal states, and terminal cancellation', async () => {
        const first = await payable(['REALM_DUNGEON'], 6, 0.1);
        await expect(confirmOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: raiderId,
            expectedRevision: 0 })).rejects.toMatchObject({ code: 'NOT_ORIGINAL_ORGANIZER' });
        await expect(modifyOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId,
            expectedRevision: 0, selectedMinutes: 0 })).rejects.toMatchObject({ code: 'INVALID_MINUTES' });
        const modified = await modifyOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId,
            expectedRevision: 0, selectedMinutes: 1 });
        expect(modified).toMatchObject({ selectedMinutes: 1, selectedPoints: 0.1, revision: 1, status: 'pending' });
        await expect(confirmOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId,
            expectedRevision: 0 })).rejects.toMatchObject({ code: 'STALE_REVISION' });
        const cancelled = await cancelOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId });
        expect(cancelled.status).toBe('cancelled');
        expect((await cancelOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId })).status).toBe('cancelled');
        await expect(confirmOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId,
            expectedRevision: cancelled.revision })).rejects.toMatchObject({ code: 'SETTLEMENT_CANCELLED' });
        await expect(recoverOrganizerMinutes({ runId: first.runId, guildId,
            actorId: organizerId, selectedMinutes: 4 })).rejects.toMatchObject({ code: 'SETTLEMENT_CANCELLED' });
        await expect(modifyOrganizerMinuteSettlement({ runId: first.runId, guildId, actorId: organizerId,
            expectedRevision: cancelled.revision, selectedMinutes: 2 })).rejects.toMatchObject({ code: 'SETTLEMENT_TERMINAL' });
    });

    it('serializes Confirm and organizer recovery races to one accounting event', async () => {
        const confirmRace = await payable(['REALM_DUNGEON'], 5, 0.1);
        const confirms = await Promise.all([
            confirmOrganizerMinuteSettlement({ runId: confirmRace.runId, guildId, actorId: organizerId, expectedRevision: 0 }),
            confirmOrganizerMinuteSettlement({ runId: confirmRace.runId, guildId, actorId: organizerId, expectedRevision: 0 }),
        ]);
        expect(new Set(confirms.map(value => value.quotaEventId)).size).toBe(1);

        const mixedRace = await payable(['SNAKE_PIT'], 5, 0.1);
        const mixed = await Promise.all([
            confirmOrganizerMinuteSettlement({ runId: mixedRace.runId, guildId, actorId: organizerId, expectedRevision: 0 }),
            recoverOrganizerMinutes({ runId: mixedRace.runId, guildId, actorId: organizerId, selectedMinutes: 3 })
                .then(result => result.settlement),
        ]);
        expect(new Set(mixed.map(value => value.quotaEventId)).size).toBe(1);

        const recoveryRace = await payable(['SNAKE_PIT', 'MAGIC_WOODS'], 5, 0.1);
        const recoveries = await Promise.all([
            recoverOrganizerMinutes({ runId: recoveryRace.runId, guildId, actorId: organizerId, selectedMinutes: 2 }),
            recoverOrganizerMinutes({ runId: recoveryRace.runId, guildId, actorId: organizerId, selectedMinutes: 4 }),
        ]);
        expect(new Set(recoveries.map(value => value.settlement.quotaEventId)).size).toBe(1);
        expect(recoveries.filter(value => value.alreadyConfirmed)).toHaveLength(1);
        for (const runId of [confirmRace.runId, mixedRace.runId, recoveryRace.runId]) {
            expect((await database.pool!.query("SELECT count(*)::int AS count FROM quota_event WHERE action_type = 'organizer_minutes' AND subject_id = $1", [`run:${runId}:organizer_minutes`])).rows[0].count).toBe(1);
        }
    });

    it('shares receipts and event identity across sequential Confirm and organizer recovery calls', async () => {
        const confirmFirst = await payable(['REALM_DUNGEON'], 5, 0.1);
        const confirmed = await confirmOrganizerMinuteSettlement({
            runId: confirmFirst.runId, guildId, actorId: organizerId, expectedRevision: 0,
        });
        const recoveredAfterConfirm = await recoverOrganizerMinutes({
            runId: confirmFirst.runId, guildId, actorId: organizerId, selectedMinutes: 2,
        });
        expect(recoveredAfterConfirm.alreadyConfirmed).toBe(true);
        expect(recoveredAfterConfirm.settlement.quotaEventId).toBe(confirmed.quotaEventId);
        expect(recoveredAfterConfirm.settlement.selectedMinutes).toBe(confirmed.selectedMinutes);

        const recoveryFirst = await payable(['SNAKE_PIT'], 5, 0.1);
        const recovered = await recoverOrganizerMinutes({
            runId: recoveryFirst.runId, guildId, actorId: organizerId, selectedMinutes: 3,
        });
        const confirmedAfterRecovery = await confirmOrganizerMinuteSettlement({
            runId: recoveryFirst.runId, guildId, actorId: organizerId, expectedRevision: 0,
        });
        expect(confirmedAfterRecovery.quotaEventId).toBe(recovered.settlement.quotaEventId);
        expect(confirmedAfterRecovery.selectedMinutes).toBe(3);

        for (const runId of [confirmFirst.runId, recoveryFirst.runId]) {
            const count = await database.pool!.query(
                "SELECT count(*)::int AS count FROM quota_event WHERE action_type = 'organizer_minutes' AND subject_id = $1",
                [`run:${runId}:organizer_minutes`]
            );
            expect(count.rows[0].count).toBe(1);
        }
    });

    it('serializes terminal and revision races on the settlement row', async () => {
        const terminal = await payable(['REALM_DUNGEON'], 5, 0.1);
        const terminalRace = await Promise.allSettled([
            confirmOrganizerMinuteSettlement({ runId: terminal.runId, guildId, actorId: organizerId, expectedRevision: 0 }),
            cancelOrganizerMinuteSettlement({ runId: terminal.runId, guildId, actorId: organizerId }),
        ]);
        expect(terminalRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const terminalState = (await getOrganizerMinuteSettlement({ runId: terminal.runId, guildId }))!;
        expect((await database.pool!.query("SELECT count(*)::int AS count FROM quota_event WHERE action_type = 'organizer_minutes' AND subject_id = $1", [`run:${terminal.runId}:organizer_minutes`])).rows[0].count)
            .toBe(terminalState.status === 'confirmed' ? 1 : 0);

        const modifyConfirm = await payable(['SNAKE_PIT'], 5, 0.1);
        const mixed = await Promise.allSettled([
            modifyOrganizerMinuteSettlement({ runId: modifyConfirm.runId, guildId, actorId: organizerId, expectedRevision: 0, selectedMinutes: 2 }),
            confirmOrganizerMinuteSettlement({ runId: modifyConfirm.runId, guildId, actorId: organizerId, expectedRevision: 0 }),
        ]);
        expect(mixed.filter(result => result.status === 'fulfilled')).toHaveLength(1);

        const modifies = await payable(['SNAKE_PIT', 'MAGIC_WOODS'], 5, 0.1);
        const modifyRace = await Promise.allSettled([
            modifyOrganizerMinuteSettlement({ runId: modifies.runId, guildId, actorId: organizerId, expectedRevision: 0, selectedMinutes: 2 }),
            modifyOrganizerMinuteSettlement({ runId: modifies.runId, guildId, actorId: organizerId, expectedRevision: 0, selectedMinutes: 4 }),
        ]);
        expect(modifyRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect((await getOrganizerMinuteSettlement({ runId: modifies.runId, guildId }))?.revision).toBe(1);
    });

    it('coordinates confirmation booking with quota-period finalization on the snapshotted role', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { required_points: 1, reset_interval_days: 7 });
        const { runId } = await payable(['REALM_DUNGEON'], 5, 0.1);
        const blocker = await database.pool!.connect();
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM quota_role_config WHERE guild_id = $1 AND discord_role_id = $2 FOR UPDATE', [guildId, roleId]);
        const finalizing = manuallyResetQuotaPeriod(guildId, roleId, [organizerId]);
        await waitForBlocked(1);
        const confirming = confirmOrganizerMinuteSettlement({ runId, guildId, actorId: organizerId, expectedRevision: 0 });
        try {
            await waitForBlocked(2);
        } finally {
            await blocker.query('COMMIT');
            blocker.release();
        }
        await Promise.all([finalizing, confirming]);
        const coverage = await database.pool!.query(
            `SELECT period.id::text, period.status,
                    result.earned_points::text,
                    event.quota_points::text AS event_points
             FROM quota_event event
             JOIN quota_period period
               ON period.guild_id = event.guild_id
              AND period.quota_role_id = event.quota_role_id
              AND event.created_at >= period.starts_at
              AND event.created_at < period.ends_at
             LEFT JOIN quota_period_member_result result
               ON result.period_id = period.id AND result.user_id = event.actor_user_id
             WHERE event.subject_id = $1`,
            [`run:${runId}:organizer_minutes`]
        );
        expect(coverage.rows).toHaveLength(1);
        expect(coverage.rows[0].event_points).toBe('0.50');
        if (coverage.rows[0].status === 'finalized') expect(coverage.rows[0].earned_points).toBe('0.50');
    });

    it('keeps actual non-exalt time independent from selected, cancelled, and missing payouts', async () => {
        const baseline = (await getUserQuotaStats(guildId, organizerId)).non_exalt_run_minutes;
        const snake = await payable(['SNAKE_PIT'], 2, 0.1);
        await modifyOrganizerMinuteSettlement({ runId: snake.runId, guildId, actorId: organizerId, expectedRevision: 0, selectedMinutes: 1 });
        await confirmOrganizerMinuteSettlement({ runId: snake.runId, guildId, actorId: organizerId, expectedRevision: 1 });
        const realm = await payable(['REALM_DUNGEON'], 3, 0.1);
        await cancelOrganizerMinuteSettlement({ runId: realm.runId, guildId, actorId: organizerId });
        await payable(['SNAKE_PIT', 'MAGIC_WOODS'], 4, 0.1);
        const exalt = await create(['NEST']); await start(exalt);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '8 minutes' WHERE id = $1", [exalt]);
        await endRunWithTransaction({ runId: exalt, guildId });
        const cancelledRun = await create(['REALM_DUNGEON']); await start(cancelledRun);
        await database.pool!.query("UPDATE run SET started_at = statement_timestamp() - interval '9 minutes' WHERE id = $1", [cancelledRun]);
        await cancelRunWithTransaction({ runId: cancelledRun, guildId });
        const after = await getUserQuotaStats(guildId, organizerId);
        expect(after.non_exalt_run_minutes - baseline).toBe(9);
    });

    it('allows only the persisted original organizer to recover and derives payout data from the run', async () => {
        const { runId } = await payable(['REALM_DUNGEON'], 5, 0.29);
        await database.pool!.query('DELETE FROM organizer_minute_settlement WHERE run_id = $1', [runId]);
        const headers = { 'x-guild-id': guildId };
        const denied = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`, headers,
            payload: { actorId: raiderId, selectedMinutes: 3, points: 999, organizerId: raiderId } });
        expect(denied.statusCode).toBe(403);
        await database.pool!.query(`INSERT INTO guild_role (guild_id, role_key, discord_role_id)
            VALUES ($1, 'moderator', $2) ON CONFLICT (guild_id, role_key) DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id`,
        [guildId, otherRoleId]);
        const staffDenied = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`, headers,
            payload: { actorId: raiderId, actorRoles: [otherRoleId], actorHasAdminPermission: true, selectedMinutes: 3 } });
        expect(staffDenied.statusCode).toBe(403);
        const allowed = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`, headers,
            payload: { actorId: organizerId, selectedMinutes: 3, points: 999, organizerId: raiderId } });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().settlement).toMatchObject({ organizerId, quotaRoleId: roleId, rate: 0.29, selectedMinutes: 3, selectedPoints: 0.87 });
        expect(allowed.json().alreadyConfirmed).toBe(false);
        const repeated = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`, headers,
            payload: { actorId: organizerId, selectedMinutes: 5 } });
        expect(repeated.statusCode).toBe(200);
        expect(repeated.json()).toMatchObject({ alreadyConfirmed: true,
            settlement: { selectedMinutes: 3, selectedPoints: 0.87 } });
        const invalidConfirmed = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`, headers,
            payload: { actorId: organizerId, selectedMinutes: 6 } });
        expect(invalidConfirmed.statusCode).toBe(400);
        const wrongGuild = await app.inject({ method: 'POST', url: `/runs/${runId}/minute-settlement/recover`,
            headers: { 'x-guild-id': '999999999999999999' }, payload: { actorId: organizerId, selectedMinutes: 3 } });
        expect(wrongGuild.statusCode).toBe(404);
    });

    it('clamps append-only manual corrections within the selected role without activity semantics', async () => {
        const manualUserId = '100000000000000099';
        await upsertQuotaRoleConfig(guildId, otherRoleId, {});
        const activityBefore = (await database.pool!.query('SELECT count(*)::int AS count FROM dungeon_activity_event')).rows[0].count;
        const addOtherRole = await app.inject({ method: 'POST', url: `/quota/adjust-quota-points/${guildId}/${manualUserId}`,
            payload: { actor_user_id: raiderId, actor_has_admin_permission: true, amount: 1, quota_role_id: otherRoleId } });
        expect(addOtherRole.statusCode).toBe(200);
        const add = await app.inject({ method: 'POST', url: `/quota/adjust-quota-points/${guildId}/${manualUserId}`,
            payload: { actor_user_id: raiderId, actor_has_admin_permission: true, amount: 0.29, quota_role_id: roleId } });
        expect(add.statusCode).toBe(200);
        expect(add.json()).toMatchObject({ amount_adjusted: 0.29, new_total: 0.29, quota_role_id: roleId });
        const clamped = await app.inject({ method: 'POST', url: `/quota/adjust-quota-points/${guildId}/${manualUserId}`,
            payload: { actor_user_id: raiderId, actor_has_admin_permission: true, amount: -1, quota_role_id: roleId } });
        expect(clamped.statusCode).toBe(200);
        expect(clamped.json()).toMatchObject({ amount_adjusted: -0.29, new_total: 0, quota_role_id: roleId });
        const repeated = await app.inject({ method: 'POST', url: `/quota/adjust-quota-points/${guildId}/${manualUserId}`,
            payload: { actor_user_id: raiderId, actor_has_admin_permission: true, amount: 0.1, quota_role_id: roleId } });
        expect(repeated.statusCode).toBe(200);
        expect(repeated.json()).toMatchObject({ amount_adjusted: 0.1, new_total: 0.1, quota_role_id: roleId });
        const event = await database.pool!.query(
            `SELECT action_type, dungeon_key, points::text, quota_points::text, quota_role_id::text
             FROM quota_event
             WHERE action_type = 'manual_quota_adjustment' AND actor_user_id = $1::bigint
             ORDER BY id`,
            [manualUserId]
        );
        expect(event.rows).toEqual([
            { action_type: 'manual_quota_adjustment', dungeon_key: null,
                points: '0.00', quota_points: '1.00', quota_role_id: otherRoleId },
            { action_type: 'manual_quota_adjustment', dungeon_key: null,
                points: '0.00', quota_points: '0.29', quota_role_id: roleId },
            { action_type: 'manual_quota_adjustment', dungeon_key: null,
                points: '0.00', quota_points: '-0.29', quota_role_id: roleId },
            { action_type: 'manual_quota_adjustment', dungeon_key: null,
                points: '0.00', quota_points: '0.10', quota_role_id: roleId },
        ]);
        expect((await database.pool!.query('SELECT count(*)::int AS count FROM dungeon_activity_event')).rows[0].count).toBe(activityBefore);
    });
});

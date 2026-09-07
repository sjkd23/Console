import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('../../db/pool.js', () => ({
    pool: {
        connect: () => database.pool!.connect(),
        query: (sql: string, params?: unknown[]) => database.pool!.query(sql, params),
    },
    query: (sql: string, params?: unknown[]) => database.pool!.query(sql, params),
}));
import { getQuotaRoleConfig, upsertQuotaRoleConfig } from '../quota/quota.js';
import { getActiveQuotaPeriod, getActiveQuotaLeaderboard, finalizeDueQuotaPeriods, manuallyResetQuotaPeriod } from './quota-period-service.js';

const connectionString = process.env.TEST_DATABASE_URL;
const guildId = '100000000000000001';
const organizerId = '100000000000000002';
const roleId = '100000000000000003';
const channelId = '100000000000000006';

describe.runIf(Boolean(connectionString))('quota configuration and persisted active periods', () => {
    const schema = `quota_config_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        database.pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
        const directory = resolve(process.cwd(), 'src/db/migrations');
        for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && file < '075_').sort()) {
            await database.pool.query(readFileSync(resolve(directory, file), 'utf8'));
        }
        await database.pool.query('INSERT INTO guild (id, name) VALUES ($1, $2)', [guildId, 'Quota configuration test']);
        await database.pool.query('INSERT INTO member (id) VALUES ($1)', [organizerId]);
    }, 30000);
    beforeEach(async () => {
        await database.pool!.query('TRUNCATE quota_period_member_result, quota_period CASCADE');
        await database.pool!.query('DELETE FROM quota_role_config WHERE guild_id = $1', [guildId]);
        await database.pool!.query('DELETE FROM quota_event WHERE guild_id = $1', [guildId]);
    });
    afterAll(async () => {
        await database.pool?.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
    });

    it('resizes the current interval atomically without changing snapshots, events, or totals', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { required_points: 10, reset_interval_days: 7, rollover_enabled: true });
        await database.pool!.query(`INSERT INTO quota_event
            (guild_id, actor_user_id, action_type, subject_id, quota_role_id, points, quota_points)
            VALUES ($1, $2, 'run_completed', 'carry-seed', $3, 15, 15)`, [guildId, organizerId, roleId]);
        await manuallyResetQuotaPeriod(guildId, roleId, [organizerId]);
        const before = await getActiveQuotaPeriod(guildId, roleId);
        await database.pool!.query(`INSERT INTO quota_event
            (guild_id, actor_user_id, action_type, subject_id, quota_role_id, points, quota_points)
            VALUES ($1, $2, 'run_completed', 'interval-test', $3, 20, 20)`, [guildId, organizerId, roleId]);
        const stats = await getActiveQuotaLeaderboard(guildId, roleId, [organizerId]);
        expect(stats.leaderboard[0]).toMatchObject({ earned_points: 20, carry_in: 5, effective_total: 25 });
        const results = (await database.pool!.query('SELECT * FROM quota_period_member_result ORDER BY period_id, user_id')).rows;
        const events = (await database.pool!.query('SELECT * FROM quota_event ORDER BY id')).rows;
        for (const days of [14, 7]) {
            await upsertQuotaRoleConfig(guildId, roleId, { reset_interval_days: days, required_points: 15, rollover_enabled: false });
            const after = await getActiveQuotaPeriod(guildId, roleId);
            expect(after).toEqual({ ...before, ends_at: new Date(new Date(before!.starts_at).getTime() + days * 86400000) });
            expect((await getActiveQuotaLeaderboard(guildId, roleId, [organizerId])).leaderboard).toEqual(stats.leaderboard);
            expect((await database.pool!.query('SELECT * FROM quota_event ORDER BY id')).rows).toEqual(events);
            expect((await database.pool!.query('SELECT * FROM quota_period_member_result ORDER BY period_id, user_id')).rows).toEqual(results);
        }
    });

    it('keeps a shortened overdue boundary and catches up through canonical finalization', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { required_points: 10, reset_interval_days: 14 });
        await database.pool!.query(`UPDATE quota_period SET starts_at = NOW() - INTERVAL '8 days',
            ends_at = NOW() + INTERVAL '6 days' WHERE guild_id = $1 AND quota_role_id = $2 AND status = 'active'`, [guildId, roleId]);
        const before = await getActiveQuotaPeriod(guildId, roleId);
        await upsertQuotaRoleConfig(guildId, roleId, { reset_interval_days: 7 });
        const resized = await getActiveQuotaPeriod(guildId, roleId);
        expect(resized!.id).toBe(before!.id);
        expect(new Date(resized!.ends_at).getTime()).toBe(new Date(before!.starts_at).getTime() + 7 * 86400000);
        const finalized = await finalizeDueQuotaPeriods(guildId, roleId, [organizerId]);
        expect(finalized.periods).toHaveLength(1);
        expect(finalized.periods[0].ends_at).toEqual(resized!.ends_at);
        expect((await getActiveQuotaPeriod(guildId, roleId))!.starts_at).toEqual(resized!.ends_at);
    });

    it('rolls back config when the boundary update fails and tracking never activates periods', async () => {
        await upsertQuotaRoleConfig(guildId, roleId, { required_points: 10, reset_interval_days: 7 });
        const before = await getActiveQuotaPeriod(guildId, roleId);
        // Test-only constraint forces failure after config has been written.
        await database.pool!.query(`ALTER TABLE quota_period ADD CONSTRAINT test_interval_limit
            CHECK (ends_at <= starts_at + INTERVAL '7 days') NOT VALID`);
        try {
            await expect(upsertQuotaRoleConfig(guildId, roleId, { reset_interval_days: 14 })).rejects.toThrow();
            expect((await getQuotaRoleConfig(guildId, roleId))!.reset_interval_days).toBe(7);
            expect(await getActiveQuotaPeriod(guildId, roleId)).toEqual(before);
        } finally {
            await database.pool!.query('ALTER TABLE quota_period DROP CONSTRAINT test_interval_limit');
        }
        await upsertQuotaRoleConfig(guildId, roleId, { panel_message_id: channelId });
        expect(await getActiveQuotaPeriod(guildId, roleId)).toEqual(before);
        await database.pool!.query('DELETE FROM quota_period WHERE guild_id = $1 AND quota_role_id = $2', [guildId, roleId]);
        await upsertQuotaRoleConfig(guildId, roleId, { panel_message_id: organizerId });
        expect(await getActiveQuotaPeriod(guildId, roleId)).toBeNull();
        expect((await getQuotaRoleConfig(guildId, roleId))!.panel_message_id).toBe(organizerId);
    });

});

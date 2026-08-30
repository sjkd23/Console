import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillDungeonActivityBatch } from './backfill.js';
import { analyzeDungeonActivityParity, analyzeHistoricalZeroPointGaps } from './parity.js';
import { recordDungeonActivity, recordManualRunActivity, DungeonActivityConflictError } from './activity-service.js';
import { getCanonicalActivityLeaderboard, getCanonicalActivityRows, summarizeCanonicalActivity } from './stats-service.js';
import { recoverHistoricalActivityCorrections, recoverHistoricalZeroPointActivity } from './recovery.js';
import {
    organizerKeyPopActivitySubjectId,
    raiderKeyPopActivitySubjectId,
} from './activity-subject.js';
import { QuotaService } from '../services/quota-service.js';

const connectionString = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(connectionString));

integration('dungeon_activity_event PostgreSQL integration', () => {
    const client = new Client({ connectionString });
    const schema = `phase_a_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(
        resolve(process.cwd(), 'src/db/migrations/062_dungeon_activity_events.sql'),
        'utf8'
    );
    const liveSourcesMigration = readFileSync(
        resolve(process.cwd(), 'src/db/migrations/063_dungeon_activity_live_sources.sql'),
        'utf8'
    );
    const adjustmentsMigration = readFileSync(
        resolve(process.cwd(), 'src/db/migrations/064_dungeon_activity_adjustments.sql'),
        'utf8'
    );
    const quotaService = new QuotaService();

    beforeAll(async () => {
        await client.connect();
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
        await client.query(`
            CREATE TABLE run (
                id BIGSERIAL PRIMARY KEY,
                guild_id BIGINT NOT NULL,
                organizer_id BIGINT,
                dungeon_key TEXT NOT NULL,
                run_kind TEXT GENERATED ALWAYS AS (
                    CASE
                        WHEN dungeon_key = 'ORYX_3' THEN 'oryx_3'
                        WHEN dungeon_key = 'REALM_DUNGEON' THEN 'realm_clearing'
                        WHEN dungeon_key = 'MISC_DUNGEONS' THEN 'multi_non_exalt'
                        WHEN dungeon_key = 'EXALTATION_DUNGEONS' THEN 'multi_exalt'
                        ELSE 'single'
                    END
                ) STORED,
                activity_key TEXT GENERATED ALWAYS AS (
                    CASE
                        WHEN dungeon_key IN ('REALM_DUNGEON', 'MISC_DUNGEONS') THEN 'MISC_DUNGEONS'
                        ELSE dungeon_key
                    END
                ) STORED,
                status TEXT NOT NULL,
                key_pop_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                started_at TIMESTAMPTZ,
                ended_at TIMESTAMPTZ
            );
            CREATE TABLE quota_event (
                id BIGSERIAL PRIMARY KEY,
                guild_id BIGINT NOT NULL,
                actor_user_id BIGINT NOT NULL,
                action_type TEXT NOT NULL,
                subject_id TEXT,
                dungeon_key TEXT,
                points NUMERIC NOT NULL DEFAULT 0,
                quota_points NUMERIC NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE UNIQUE INDEX quota_event_run_subject_unique
                ON quota_event(guild_id, subject_id)
                WHERE action_type = 'run_completed' AND subject_id IS NOT NULL;
            CREATE TABLE key_pop_snapshot (
                run_id BIGINT NOT NULL,
                key_pop_number INTEGER NOT NULL,
                user_id BIGINT NOT NULL,
                snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                awarded_completion BOOLEAN NOT NULL DEFAULT FALSE,
                awarded_at TIMESTAMPTZ
            );
            CREATE TABLE reaction (
                run_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL,
                state TEXT NOT NULL
            );
            CREATE TABLE raider_points_config (
                guild_id BIGINT NOT NULL,
                dungeon_key TEXT NOT NULL,
                points NUMERIC NOT NULL,
                PRIMARY KEY (guild_id, dungeon_key)
            );
        `);
        await client.query(migration);
        await client.query(liveSourcesMigration);
        await client.query(adjustmentsMigration);
    });

    beforeEach(async () => {
        await client.query('TRUNCATE dungeon_activity_adjustment, dungeon_activity_event, key_pop_snapshot, reaction, quota_event, raider_points_config, run RESTART IDENTITY');
    });

    afterAll(async () => {
        await client.query('SET search_path TO public');
        await client.query(`DROP SCHEMA ${schema} CASCADE`);
        await client.end();
    });

    it('enforces roles, counts, idempotency, and non-destructive run retention', async () => {
        await client.query(`INSERT INTO run (id, guild_id, dungeon_key, status) VALUES (10, 1437327222863040614, 'NEST', 'ended')`);
        await client.query(`
            INSERT INTO dungeon_activity_event
                (guild_id, user_id, run_id, role, dungeon_stats_key, subject_id, source, occurred_at)
            VALUES
                (1437327222863040614, 218823980524634112, 10, 'organizer', 'NEST', 'test:organizer', 'historical_run', NOW()),
                (1437327222863040614, 333333333333333333, 10, 'raider', 'NEST', 'test:raider', 'historical_snapshot', NOW())
        `);

        await expect(client.query(`
            INSERT INTO dungeon_activity_event
                (guild_id, user_id, role, dungeon_stats_key, subject_id, source, occurred_at)
            VALUES (1437327222863040614, 218823980524634112, 'viewer', 'NEST', 'test:bad-role', 'historical_run', NOW())
        `)).rejects.toThrow();
        await expect(client.query(`
            INSERT INTO dungeon_activity_event
                (guild_id, user_id, role, dungeon_stats_key, subject_id, source, count, occurred_at)
            VALUES (1437327222863040614, 218823980524634112, 'organizer', 'NEST', 'test:bad-count', 'historical_run', 0, NOW())
        `)).rejects.toThrow();
        await expect(client.query(`
            INSERT INTO dungeon_activity_event
                (guild_id, user_id, role, dungeon_stats_key, subject_id, source, occurred_at)
            VALUES (1437327222863040614, 218823980524634112, 'organizer', 'NEST', 'test:organizer', 'historical_run', NOW())
        `)).rejects.toThrow();

        await client.query('DELETE FROM run WHERE id = 10');
        const retained = await client.query<{ role: string; run_id: string | null }>(
            'SELECT role, run_id::text FROM dungeon_activity_event ORDER BY role'
        );
        expect(retained.rows).toEqual([
            { role: 'organizer', run_id: null },
            { role: 'raider', run_id: null },
        ]);
    });

    it('backfills standard, O3, manual aggregate, and historical manual events idempotently', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raider = '333333333333333333';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status, ended_at) VALUES
                (10, $1, $2, 'NEST', 'ended', NOW()),
                (11, $1, $2, 'ORYX_3', 'ended', NOW()),
                (12, $1, $2, 'FUNGAL_CAVERN', 'ended', NOW())`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO quota_event
                (id, guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points, created_at)
             VALUES
                (1, $1::bigint, $2::bigint, 'run_completed', 'run:10:keypop:1', 'NEST', 0, 2, NOW()),
                (2, $1::bigint, $3::bigint, 'run_completed', 'raider:10:1:' || $3::text, 'NEST', 3, 0, NOW()),
                (3, $1::bigint, $2::bigint, 'run_completed', 'run:11', 'ORYX_3', 0, 4, NOW()),
                (4, $1::bigint, $2::bigint, 'run_completed', 'manual_log_run:1700000000000:' || $2::text || ':5', 'CULTIST_HIDEOUT', 0, 10, NOW()),
                (5, $1::bigint, $2::bigint, 'run_completed', 'manual_adjust:1:' || $2::text, NULL, 0, 3, NOW()),
                (6, $1::bigint, $3::bigint, 'run_completed', 'key_pop:1:' || $3::text || ':2', 'NEST', 4, 0, NOW()),
                (7, $1::bigint, $2::bigint, 'run_completed', 'run:12', 'FUNGAL_CAVERN', 0, 0, NOW()),
                (8, $1::bigint, $2::bigint, 'run_completed', 'manual_log_run:1700000000001:' || $2::text || ':2', 'NEST', 0, -4, NOW()),
                (9, $1::bigint, $2::bigint, 'run_completed', NULL, 'THE_VOID', 0, 1, NOW())`,
            [guild, organizer, raider]
        );

        const first = await backfillDungeonActivityBatch(client, {
            afterId: '0', highWaterId: '9', limit: 20, apply: true,
        });
        const second = await backfillDungeonActivityBatch(client, {
            afterId: '0', highWaterId: '9', limit: 20, apply: true,
        });

        expect(first).toMatchObject({ scanned: 9, inserted: 6, duplicates: 0 });
        expect(second).toMatchObject({ scanned: 9, inserted: 0, duplicates: 6 });
        const rows = await client.query<{
            role: string;
            dungeon_stats_key: string;
            count: number;
            run_id: string | null;
        }>(`SELECT role, dungeon_stats_key, count, run_id::text FROM dungeon_activity_event ORDER BY subject_id`);
        expect(rows.rows).toEqual(expect.arrayContaining([
            { role: 'organizer', dungeon_stats_key: 'NEST', count: 1, run_id: '10' },
            { role: 'raider', dungeon_stats_key: 'NEST', count: 1, run_id: '10' },
            { role: 'organizer', dungeon_stats_key: 'ORYX_3', count: 1, run_id: '11' },
            { role: 'organizer', dungeon_stats_key: 'CULTIST_HIDEOUT', count: 5, run_id: null },
            { role: 'organizer', dungeon_stats_key: 'FUNGAL_CAVERN', count: 1, run_id: '12' },
            { role: 'organizer', dungeon_stats_key: 'THE_VOID', count: 1, run_id: null },
        ]));
        const subjectIds = (await client.query<{ subject_id: string }>(
            'SELECT subject_id FROM dungeon_activity_event ORDER BY subject_id'
        )).rows.map(row => row.subject_id);
        expect(subjectIds).toEqual(expect.arrayContaining([
            'run:10:keypop:1:organizer',
            `run:10:keypop:1:raider:${raider}`,
            'run:11:o3:organizer',
            `manual_log_run:1700000000000:${organizer}:5:organizer`,
        ]));

        const parity = await analyzeDungeonActivityParity(client, guild);
        expect(parity.summary.unexpected_mismatches).toBe(0);
        expect(parity.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                dungeon_stats_key: 'FUNGAL_CAVERN',
                legacy_count: 0,
                activity_count: 1,
                status: 'explained_mismatch',
                reasons: ['canonical_activity_has_zero_legacy_points'],
            }),
            expect.objectContaining({
                dungeon_stats_key: null,
                status: 'explained_mismatch',
                reasons: ['manual_quota_adjustment_not_activity'],
            }),
        ]));
    });

    it('pages quota event IDs numerically rather than by their text projection', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        await client.query(
            `INSERT INTO quota_event
                (id, guild_id, actor_user_id, action_type, subject_id, dungeon_key, quota_points)
             VALUES
                (2, $1, $2, 'run_completed', NULL, 'NEST', 1),
                (10, $1, $2, 'run_completed', NULL, 'NEST', 1),
                (100, $1, $2, 'run_completed', NULL, 'NEST', 1)`,
            [guild, organizer]
        );

        const first = await backfillDungeonActivityBatch(client, {
            afterId: '0', highWaterId: '100', limit: 2, apply: false,
        });
        const second = await backfillDungeonActivityBatch(client, {
            afterId: first.lastEventId!, highWaterId: '100', limit: 2, apply: false,
        });

        expect(first.lastEventId).toBe('10');
        expect(second.lastEventId).toBe('100');
        expect(first.scanned + second.scanned).toBe(3);
    });

    it('reports absent zero-point evidence without speculatively backfilling it', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raider = '333333333333333333';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status, key_pop_count, ended_at) VALUES
                (20, $1, $2, 'NEST', 'ended', 1, NOW()),
                (21, $1, $2, 'FUNGAL_CAVERN', 'ended', 0, NOW()),
                (22, $1, $2, 'ORYX_3', 'ended', 0, NOW())`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO key_pop_snapshot (run_id, key_pop_number, user_id, awarded_completion)
             VALUES (20, 1, $1, FALSE)`,
            [raider]
        );
        await client.query(
            `INSERT INTO reaction (run_id, user_id, state) VALUES (21, $1, 'join')`,
            [raider]
        );

        const gaps = await analyzeHistoricalZeroPointGaps(client, guild);
        expect(gaps).toMatchObject({
            organizer_key_pop_candidates: 1,
            o3_organizer_candidates: 1,
            snapshot_raider_candidates: 1,
            participant_raider_candidates: 1,
            classifications: {
                organizer_key_pop_candidates: 'partially_recoverable',
                o3_organizer_candidates: 'partially_recoverable',
                snapshot_raider_candidates: 'partially_recoverable',
                participant_raider_candidates: 'not_recoverable',
            },
        });
        expect((await client.query('SELECT 1 FROM dungeon_activity_event')).rowCount).toBe(0);
    });

    it('keeps catch-up backfill and Phase B live writes on one canonical identity', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status)
             VALUES (30, $1, $2, 'NEST', 'live')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO quota_event
                (id, guild_id, actor_user_id, action_type, subject_id, dungeon_key, quota_points, created_at)
             VALUES (1, $1, $2, 'run_completed', 'run:30:keypop:1', 'NEST', 2, '2026-08-28T20:10:00Z')`,
            [guild, organizer]
        );

        const initial = await backfillDungeonActivityBatch(client, {
            afterId: '0', highWaterId: '1', limit: 10, apply: true,
        });
        expect(initial).toMatchObject({ inserted: 1, duplicates: 0 });

        await recordDungeonActivity({
            guildId: guild,
            userId: organizer,
            runId: 30,
            role: 'organizer',
            dungeonStatsKey: 'NEST',
            subjectId: organizerKeyPopActivitySubjectId(30, 2),
            source: 'key_pop',
            count: 1,
            occurredAt: new Date('2026-08-28T20:15:00Z'),
        }, client);
        await client.query(
            `INSERT INTO quota_event
                (id, guild_id, actor_user_id, action_type, subject_id, dungeon_key, quota_points, created_at)
             VALUES (2, $1, $2, 'run_completed', 'run:30:keypop:2', 'NEST', 2, '2026-08-28T20:15:01Z')`,
            [guild, organizer]
        );

        const catchUp = await backfillDungeonActivityBatch(client, {
            afterId: '0', highWaterId: '2', limit: 10, apply: true,
        });
        expect(catchUp).toMatchObject({ inserted: 0, duplicates: 2 });
        expect((await client.query(
            `SELECT 1 FROM dungeon_activity_event
             WHERE guild_id = $1 AND user_id = $2 AND dungeon_stats_key = 'NEST'`,
            [guild, organizer]
        )).rowCount).toBe(2);
    });

    it('rejects a duplicate activity identity with conflicting semantics', async () => {
        const base = {
            guildId: '1437327222863040614',
            userId: '218823980524634112',
            runId: null,
            role: 'organizer' as const,
            dungeonStatsKey: 'NEST',
            subjectId: 'test:conflict',
            source: 'manual_log' as const,
            count: 1,
            occurredAt: new Date(),
        };
        await recordDungeonActivity(base, client);

        await expect(recordDungeonActivity({ ...base, dungeonStatsKey: 'SHATTERS' }, client))
            .rejects.toBeInstanceOf(DungeonActivityConflictError);
    });

    it('dual-writes snapshot raiders for nonzero points and remains idempotent on retry', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raiders = ['333333333333333333', '444444444444444444'];
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status)
             VALUES (40, $1, $2, 'NEST', 'live')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO raider_points_config (guild_id, dungeon_key, points) VALUES ($1, 'NEST', 2)`,
            [guild]
        );
        await client.query(
            `INSERT INTO key_pop_snapshot (run_id, key_pop_number, user_id, snapshot_time)
             VALUES (40, 1, $1, '2026-08-28T20:15:00Z'),
                    (40, 1, $2, '2026-08-28T20:15:00Z')`,
            raiders
        );

        const first = await quotaService.awardRaidersQuotaFromSnapshot({
            guildId: guild, dungeonKey: 'NEST', runId: 40, keyPopNumber: 1,
        }, client as unknown as PoolClient);
        const retry = await quotaService.awardRaidersQuotaFromSnapshot({
            guildId: guild, dungeonKey: 'NEST', runId: 40, keyPopNumber: 1,
        }, client as unknown as PoolClient);

        expect(first).toBe(2);
        expect(retry).toBe(0);
        expect((await client.query('SELECT 1 FROM quota_event')).rowCount).toBe(2);
        const activity = await client.query<{ subject_id: string; occurred_at: Date }>(
            'SELECT subject_id, occurred_at FROM dungeon_activity_event ORDER BY subject_id'
        );
        expect(activity.rows.map(row => row.subject_id)).toEqual([
            raiderKeyPopActivitySubjectId(40, 1, raiders[0]),
            raiderKeyPopActivitySubjectId(40, 1, raiders[1]),
        ]);
        expect(activity.rows.every(row => row.occurred_at.toISOString() === '2026-08-28T20:15:00.000Z')).toBe(true);
    });

    it('records zero-point snapshot activity and distinct activities for later key pops', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raider = '333333333333333333';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status)
             VALUES (41, $1, $2, 'NEST', 'live')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO raider_points_config (guild_id, dungeon_key, points) VALUES ($1, 'NEST', 0)`,
            [guild]
        );
        await client.query(
            `INSERT INTO key_pop_snapshot (run_id, key_pop_number, user_id, snapshot_time)
             VALUES (41, 1, $1, '2026-08-28T20:15:00Z'),
                    (41, 2, $1, '2026-08-28T20:30:00Z')`,
            [raider]
        );

        expect(await quotaService.awardRaidersQuotaFromSnapshot({
            guildId: guild, dungeonKey: 'NEST', runId: 41, keyPopNumber: 1,
        }, client as unknown as PoolClient)).toBe(0);
        expect(await quotaService.awardRaidersQuotaFromSnapshot({
            guildId: guild, dungeonKey: 'NEST', runId: 41, keyPopNumber: 2,
        }, client as unknown as PoolClient)).toBe(0);

        expect((await client.query('SELECT 1 FROM quota_event')).rowCount).toBe(0);
        const subjects = (await client.query<{ subject_id: string }>(
            'SELECT subject_id FROM dungeon_activity_event ORDER BY subject_id'
        )).rows.map(row => row.subject_id);
        expect(subjects).toEqual([
            raiderKeyPopActivitySubjectId(41, 1, raider),
            raiderKeyPopActivitySubjectId(41, 2, raider),
        ]);
    });

    it('preserves participant fallback eligibility and records activity when points are zero', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const joined = '333333333333333333';
        const left = '444444444444444444';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status, ended_at)
             VALUES (42, $1, $2, 'NEST', 'ended', '2026-08-28T20:48:00Z')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO raider_points_config (guild_id, dungeon_key, points) VALUES ($1, 'NEST', 0)`,
            [guild]
        );
        await client.query(
            `INSERT INTO reaction (run_id, user_id, state)
             VALUES (42, $1, 'join'), (42, $2, 'leave')`,
            [joined, left]
        );

        expect(await quotaService.awardRaidersQuotaFromParticipants({
            guildId: guild, dungeonKey: 'NEST', runId: 42,
        }, client as unknown as PoolClient)).toBe(0);

        expect((await client.query('SELECT 1 FROM quota_event')).rowCount).toBe(0);
        const activity = await client.query<{ user_id: string; source: string }>(
            'SELECT user_id::text, source FROM dungeon_activity_event'
        );
        expect(activity.rows).toEqual([{ user_id: joined, source: 'participant_fallback' }]);

        await client.query(
            `UPDATE raider_points_config SET points = 3 WHERE guild_id = $1 AND dungeon_key = 'NEST'`,
            [guild]
        );
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status, ended_at)
             VALUES (43, $1, $2, 'NEST', 'ended', '2026-08-28T21:00:00Z')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO reaction (run_id, user_id, state) VALUES (43, $1, 'join')`,
            [joined]
        );
        expect(await quotaService.awardRaidersQuotaFromParticipants({
            guildId: guild, dungeonKey: 'NEST', runId: 43,
        }, client as unknown as PoolClient)).toBe(1);
        const awarded = await client.query<{ points: string }>(
            `SELECT points::text FROM quota_event WHERE subject_id = $1`,
            [`raider:43:${joined}`]
        );
        expect(awarded.rows).toEqual([{ points: '3' }]);
    });

    it('keeps positive manual activity and idempotent negative corrections in separate ledgers', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        expect(await recordManualRunActivity({
            guildId: guild,
            userId: organizer,
            dungeonStatsKey: 'NEST',
            quotaSubjectId: `manual_log_run:1700000000000:${organizer}:5`,
            count: 5,
            occurredAt: new Date('2026-08-28T20:00:00Z'),
        }, client)).toBe('inserted');
        const correction = {
            guildId: guild,
            userId: organizer,
            dungeonStatsKey: 'NEST',
            quotaSubjectId: `manual_log_run:1700000000001:${organizer}:2`,
            count: -2,
            occurredAt: new Date('2026-08-28T20:01:00Z'),
        };
        expect(await recordManualRunActivity(correction, client)).toBe('inserted');
        expect(await recordManualRunActivity(correction, client)).toBe('existing');

        await client.query(
            `INSERT INTO quota_event
                (guild_id, actor_user_id, action_type, subject_id, dungeon_key, quota_points)
             VALUES ($1, $2, 'run_completed', 'manual_adjust:test', 'NEST', 100)`,
            [guild, organizer]
        );

        const activity = await client.query<{ count: number; subject_id: string }>(
            'SELECT count, subject_id FROM dungeon_activity_event'
        );
        expect(activity.rows).toEqual([{
            count: 5,
            subject_id: `manual_log_run:1700000000000:${organizer}:5:organizer`,
        }]);
        expect((await client.query<{ delta: number }>(
            'SELECT delta FROM dungeon_activity_adjustment'
        )).rows).toEqual([{ delta: -2 }]);

        const canonical = summarizeCanonicalActivity(await getCanonicalActivityRows(
            { guildId: guild, userId: organizer }, client
        ));
        expect(canonical.total_runs_organized).toBe(3);
        expect(canonical.dungeons.get('NEST')).toEqual({ completed: 0, organized: 3 });
        expect(await getCanonicalActivityLeaderboard({ guildId: guild, role: 'organizer' }, client))
            .toEqual([{ user_id: organizer, count: 3 }]);
    });

    it('does not turn manual point currency into activity and still counts zero-point completions', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raider = '333333333333333333';
        await recordDungeonActivity({
            guildId: guild,
            userId: organizer,
            runId: null,
            role: 'organizer',
            dungeonStatsKey: 'NEST',
            subjectId: 'test:zero-point-organizer',
            source: 'historical_run',
            count: 1,
            occurredAt: new Date('2026-08-01T00:00:00Z'),
        }, client);
        await recordDungeonActivity({
            guildId: guild,
            userId: raider,
            runId: null,
            role: 'raider',
            dungeonStatsKey: 'NEST',
            subjectId: 'test:zero-point-raider',
            source: 'historical_snapshot',
            count: 1,
            occurredAt: new Date('2026-08-01T00:00:00Z'),
        }, client);
        await client.query(
            `INSERT INTO quota_event
                (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
             VALUES
                ($1, $2, 'run_completed', 'manual_adjust:test', 'NEST', 0, 100),
                ($1, $3, 'run_completed', 'key_pop:test', 'NEST', 100, 0)`,
            [guild, organizer, raider]
        );

        expect(await getCanonicalActivityLeaderboard({ guildId: guild, role: 'organizer' }, client))
            .toEqual([{ user_id: organizer, count: 1 }]);
        expect(await getCanonicalActivityLeaderboard({ guildId: guild, role: 'raider' }, client))
            .toEqual([{ user_id: raider, count: 1 }]);
        const currency = await client.query<{ points: string; quota_points: string }>(
            `SELECT SUM(points)::text AS points, SUM(quota_points)::text AS quota_points
             FROM quota_event`
        );
        expect(currency.rows).toEqual([{ points: '100', quota_points: '100' }]);
    });

    it('recovers only proven zero-point evidence and is idempotent', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        const raider = '333333333333333333';
        await client.query(
            `INSERT INTO run (id, guild_id, organizer_id, dungeon_key, status, key_pop_count, ended_at) VALUES
                (50, $1, $2, 'NEST', 'ended', 1, '2026-08-01T01:00:00Z'),
                (51, $1, $2, 'ORYX_3', 'ended', 0, '2026-08-01T02:00:00Z'),
                (52, $1, $2, 'FUNGAL_CAVERN', 'ended', 0, '2026-08-01T03:00:00Z')`,
            [guild, organizer]
        );
        await client.query(
            `INSERT INTO key_pop_snapshot
                (run_id, key_pop_number, user_id, snapshot_time, awarded_completion)
             VALUES (50, 1, $1, '2026-08-01T00:55:00Z', FALSE)`,
            [raider]
        );
        await client.query(
            `INSERT INTO reaction (run_id, user_id, state) VALUES (52, $1, 'join')`,
            [raider]
        );

        const dryRun = await recoverHistoricalZeroPointActivity(client, false);
        expect(dryRun).toMatchObject({
            organizer_key_pop: { total_candidates: 1, proven: 1, inserted: 0 },
            o3_organizer: { total_candidates: 1, proven: 1, inserted: 0 },
            snapshot_raider: { total_candidates: 1, proven: 1, inserted: 0 },
            participant_raider: { total_candidates: 1, unrecoverable: 1, inserted: 0 },
        });
        const first = await recoverHistoricalZeroPointActivity(client, true);
        const retry = await recoverHistoricalZeroPointActivity(client, true);
        expect(first.organizer_key_pop.inserted).toBe(1);
        expect(first.o3_organizer.inserted).toBe(1);
        expect(first.snapshot_raider.inserted).toBe(1);
        expect(first.participant_raider.inserted).toBe(0);
        expect(retry.organizer_key_pop.existing).toBe(1);
        expect(retry.o3_organizer.existing).toBe(1);
        expect(retry.snapshot_raider.existing).toBe(1);
        expect((await client.query('SELECT 1 FROM dungeon_activity_event')).rowCount).toBe(3);
    });

    it('backfills historical aggregate and original manual corrections idempotently', async () => {
        const guild = '1437327222863040614';
        const organizer = '218823980524634112';
        await client.query(
            `INSERT INTO quota_event
                (id, guild_id, actor_user_id, action_type, subject_id, dungeon_key, quota_points, created_at)
             VALUES
                (60, $1::bigint, $2::bigint, 'run_completed', 'manual_log_run:1700000000001:' || $2::text || ':2', 'NEST', -4, NOW()),
                (61, $1::bigint, $2::bigint, 'run_completed', NULL, 'NEST', -2, NOW()),
                (62, $1::bigint, $2::bigint, 'run_completed', 'manual_adjust:62:' || $2::text, 'NEST', -5, NOW())`,
            [guild, organizer]
        );

        const first = await recoverHistoricalActivityCorrections(client, true);
        const retry = await recoverHistoricalActivityCorrections(client, true);
        expect(first).toEqual({ total_candidates: 2, net_delta: -3, inserted: 2, existing: 0 });
        expect(retry).toEqual({ total_candidates: 2, net_delta: -3, inserted: 0, existing: 2 });
    });
});

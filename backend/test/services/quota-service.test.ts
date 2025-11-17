/**
 * QuotaService Tests
 * 
 * Integration tests for backend/src/services/quota-service.ts using a real PostgreSQL database.
 * These tests verify quota/points awarding logic with actual DB transactions.
 * 
 * Prerequisites:
 * - A test PostgreSQL database must be available
 * - Set DATABASE_URL or TEST_DATABASE_URL environment variable
 * - Run migrations on the test database before running tests
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { QuotaService } from '../../src/services/quota-service.js';
import { query } from '../../src/db/pool.js';
import {
  cleanDatabase,
  closeDatabase,
  createTestGuild,
  createTestMember,
  createTestRun,
  addParticipant,
  addKeyPopSnapshot,
  setRaiderPoints,
  setQuotaDungeonOverride,
} from '../helpers/test-db.js';

describe('QuotaService (real DB)', () => {
  const quotaService = new QuotaService();
  
  // Test data
  const guildId = '999999999999999999';
  const organizerId = '111111111111111111';
  const raider1Id = '222222222222222222';
  const raider2Id = '333333333333333333';
  const dungeonKey = 'FUNGAL_CAVERN';
  const organizerRoleId = '777777777777777777';

  beforeEach(async () => {
    // Clean database before each test for isolation
    await cleanDatabase();

    // Setup basic test data
    await createTestGuild(guildId, 'Test Guild');
    await createTestMember(organizerId, 'Organizer');
    await createTestMember(raider1Id, 'Raider1');
    await createTestMember(raider2Id, 'Raider2');
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('awardOrganizerQuota', () => {
    it('should award default 1 quota point when no override exists', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      const points = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId,
        organizerDiscordId: organizerId,
      });

      expect(points).toBe(1);

      // Verify event was logged
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND actor_user_id = $2::bigint 
           AND action_type = 'run_completed'
           AND subject_id = $3`,
        [guildId, organizerId, `run:${runId}`]
      );

      expect(events.rowCount).toBe(1);
      expect(events.rows[0].quota_points).toBe('1.00');
      expect(events.rows[0].dungeon_key).toBe(dungeonKey);
    });

    it('should award custom points based on role override', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      // Set custom points for organizer role
      await setQuotaDungeonOverride(guildId, organizerRoleId, dungeonKey, 5);

      const points = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId,
        organizerDiscordId: organizerId,
        organizerRoles: [organizerRoleId],
      });

      expect(points).toBe(5);

      // Verify event was logged with correct points
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
        [guildId, organizerId]
      );

      expect(events.rowCount).toBe(1);
      expect(events.rows[0].quota_points).toBe('5.00');
    });

    it('should be idempotent - calling twice does not double-award', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      // First call - should award
      const points1 = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId,
        organizerDiscordId: organizerId,
      });
      expect(points1).toBe(1);

      // Second call - should return 0 (idempotent no-op)
      const points2 = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId,
        organizerDiscordId: organizerId,
      });
      expect(points2).toBe(0);

      // Verify only one event exists
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
        [guildId, organizerId]
      );
      expect(events.rowCount).toBe(1);
    });

    it('should handle multiple runs independently', async () => {
      const run1 = await createTestRun(guildId, organizerId, dungeonKey);
      const run2 = await createTestRun(guildId, organizerId, dungeonKey);

      // Award for both runs
      const points1 = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId: run1,
        organizerDiscordId: organizerId,
      });

      const points2 = await quotaService.awardOrganizerQuota({
        guildId,
        dungeonKey,
        runId: run2,
        organizerDiscordId: organizerId,
      });

      expect(points1).toBe(1);
      expect(points2).toBe(1);

      // Verify two separate events
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint AND actor_user_id = $2::bigint`,
        [guildId, organizerId]
      );
      expect(events.rowCount).toBe(2);
    });
  });

  describe('awardRaidersQuotaFromParticipants', () => {
    it('should award default 1 point to all joined raiders', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      // Add participants
      await addParticipant(runId, raider1Id, 'join');
      await addParticipant(runId, raider2Id, 'join');

      const awardedCount = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });

      expect(awardedCount).toBe(2);

      // Verify events for both raiders
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND action_type = 'run_completed' 
           AND dungeon_key = $2
         ORDER BY actor_user_id`,
        [guildId, dungeonKey]
      );

      expect(events.rowCount).toBe(2);
      expect(events.rows[0].actor_user_id).toBe(raider1Id);
      expect(events.rows[0].points).toBe('1.00');
      expect(events.rows[1].actor_user_id).toBe(raider2Id);
      expect(events.rows[1].points).toBe('1.00');
    });

    it('should award custom raider points when configured', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      // Configure custom raider points
      await setRaiderPoints(guildId, dungeonKey, 3);

      await addParticipant(runId, raider1Id, 'join');

      const awardedCount = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });

      expect(awardedCount).toBe(1);

      // Verify custom points
      const events = await query(
        `SELECT * FROM quota_event WHERE actor_user_id = $1::bigint`,
        [raider1Id]
      );

      expect(events.rows[0].points).toBe('3.00');
    });

    it('should skip non-join participants', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      await addParticipant(runId, raider1Id, 'join');
      await addParticipant(runId, raider2Id, 'bench'); // Not joined (benched)

      const awardedCount = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });

      expect(awardedCount).toBe(1); // Only raider1

      const events = await query(
        `SELECT * FROM quota_event WHERE guild_id = $1::bigint`,
        [guildId]
      );

      expect(events.rowCount).toBe(1);
      expect(events.rows[0].actor_user_id).toBe(raider1Id);
    });

    it('should be idempotent - calling twice does not double-award', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      await addParticipant(runId, raider1Id, 'join');

      // First call
      const count1 = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });
      expect(count1).toBe(1);

      // Second call
      const count2 = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });
      expect(count2).toBe(0); // No new awards

      // Verify only one event
      const events = await query(
        `SELECT * FROM quota_event WHERE actor_user_id = $1::bigint`,
        [raider1Id]
      );
      expect(events.rowCount).toBe(1);
    });

    it('should return 0 when no participants exist', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      const awardedCount = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });

      expect(awardedCount).toBe(0);
    });

    it('should skip when raider points are configured as 0', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      await addParticipant(runId, raider1Id, 'join');

      // Set raider points to 0
      await setRaiderPoints(guildId, dungeonKey, 0);

      const awardedCount = await quotaService.awardRaidersQuotaFromParticipants({
        guildId,
        dungeonKey,
        runId,
      });

      expect(awardedCount).toBe(0);

      // Verify no events were created
      const events = await query(
        `SELECT * FROM quota_event WHERE guild_id = $1::bigint`,
        [guildId]
      );
      expect(events.rowCount).toBe(0);
    });
  });

  describe('awardRaidersQuotaFromSnapshot', () => {
    it('should award points to all snapshot raiders', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      const keyPopNumber = 1;

      // Add snapshot entries
      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);
      await addKeyPopSnapshot(runId, keyPopNumber, raider2Id);

      const awardedCount = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });

      expect(awardedCount).toBe(2);

      // Verify events
      const events = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND action_type = 'run_completed'
         ORDER BY actor_user_id`,
        [guildId]
      );

      expect(events.rowCount).toBe(2);
      expect(events.rows[0].actor_user_id).toBe(raider1Id);
      expect(events.rows[1].actor_user_id).toBe(raider2Id);
    });

    it('should mark snapshot entries as awarded', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      const keyPopNumber = 1;

      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);

      await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });

      // Verify snapshot was marked as awarded
      const snapshot = await query(
        `SELECT * FROM key_pop_snapshot 
         WHERE run_id = $1::bigint AND user_id = $2::bigint`,
        [runId, raider1Id]
      );

      expect(snapshot.rows[0].awarded_completion).toBe(true);
      expect(snapshot.rows[0].awarded_at).not.toBeNull();
    });

    it('should be idempotent - calling twice does not double-award', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      const keyPopNumber = 1;

      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);

      // First call
      const count1 = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });
      expect(count1).toBe(1);

      // Second call - snapshot is already marked as awarded
      const count2 = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });
      expect(count2).toBe(0);

      // Verify only one event
      const events = await query(
        `SELECT * FROM quota_event WHERE actor_user_id = $1::bigint`,
        [raider1Id]
      );
      expect(events.rowCount).toBe(1);
    });

    it('should use custom raider points when configured', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      const keyPopNumber = 1;

      await setRaiderPoints(guildId, dungeonKey, 5);
      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);

      await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });

      // Verify custom points
      const events = await query(
        `SELECT * FROM quota_event WHERE actor_user_id = $1::bigint`,
        [raider1Id]
      );

      expect(events.rows[0].points).toBe('5.00');
    });

    it('should return 0 when no snapshot exists', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      const awardedCount = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber: 1,
      });

      expect(awardedCount).toBe(0);
    });

    it('should skip when raider points are configured as 0', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);
      const keyPopNumber = 1;

      await setRaiderPoints(guildId, dungeonKey, 0);
      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);

      const awardedCount = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber,
      });

      expect(awardedCount).toBe(0);
    });

    it('should handle multiple key pops independently', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey);

      // Two separate key pops
      await addKeyPopSnapshot(runId, 1, raider1Id);
      await addKeyPopSnapshot(runId, 2, raider1Id);

      // Award from first key pop
      const count1 = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber: 1,
      });

      // Award from second key pop
      const count2 = await quotaService.awardRaidersQuotaFromSnapshot({
        guildId,
        dungeonKey,
        runId,
        keyPopNumber: 2,
      });

      expect(count1).toBe(1);
      expect(count2).toBe(1);

      // Verify two separate events with different subject_ids
      const events = await query(
        `SELECT * FROM quota_event WHERE actor_user_id = $1::bigint ORDER BY subject_id`,
        [raider1Id]
      );

      expect(events.rowCount).toBe(2);
      expect(events.rows[0].subject_id).toBe(`raider:${runId}:1:${raider1Id}`);
      expect(events.rows[1].subject_id).toBe(`raider:${runId}:2:${raider1Id}`);
    });
  });
});

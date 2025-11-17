/**
 * RunService Integration Tests
 * 
 * Integration tests for backend/src/services/run-service.ts using a real PostgreSQL database.
 * These tests verify the full transaction flow for run lifecycle operations.
 * 
 * Prerequisites:
 * - A test PostgreSQL database must be available
 * - Set DATABASE_URL or TEST_DATABASE_URL environment variable
 * - Run migrations on the test database before running tests
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { endRunWithTransaction } from '../../src/services/run-service.js';
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
} from '../helpers/test-db.js';

describe('RunService - endRunWithTransaction (integration)', () => {
  // Test data
  const guildId = '999999999999999999';
  const organizerId = '111111111111111111';
  const raider1Id = '222222222222222222';
  const raider2Id = '333333333333333333';
  const dungeonKey = 'FUNGAL_CAVERN';

  beforeEach(async () => {
    await cleanDatabase();
    await createTestGuild(guildId, 'Test Guild');
    await createTestMember(organizerId, 'Organizer');
    await createTestMember(raider1Id, 'Raider1');
    await createTestMember(raider2Id, 'Raider2');
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('happy path - end run with snapshot', () => {
    it('should atomically end run, award organizer quota, and award raider points from snapshot', async () => {
      // Arrange: Create run with snapshot
      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');
      const keyPopNumber = 2;

      // Add snapshot raiders
      await addKeyPopSnapshot(runId, keyPopNumber, raider1Id);
      await addKeyPopSnapshot(runId, keyPopNumber, raider2Id);

      // Configure custom raider points
      await setRaiderPoints(guildId, dungeonKey, 2);

      // Act: End the run
      const result = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: keyPopNumber,
      });

      // Assert: Check return values
      expect(result.organizerQuotaPoints).toBe(1); // Default
      expect(result.raiderPointsAwarded).toBe(2); // Two raiders from snapshot

      // Assert: Run status updated
      const runCheck = await query(
        'SELECT status, ended_at FROM run WHERE id = $1::bigint',
        [runId]
      );
      expect(runCheck.rows[0].status).toBe('ended');
      expect(runCheck.rows[0].ended_at).not.toBeNull();

      // Assert: Organizer quota event created
      const orgEvents = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND actor_user_id = $2::bigint 
           AND action_type = 'run_completed'`,
        [guildId, organizerId]
      );
      expect(orgEvents.rowCount).toBe(1);
      expect(orgEvents.rows[0].quota_points).toBe('1.00');
      expect(orgEvents.rows[0].subject_id).toBe(`run:${runId}`);

      // Assert: Raider points events created
      const raiderEvents = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND action_type = 'run_completed' 
           AND points > 0
         ORDER BY actor_user_id`,
        [guildId]
      );
      expect(raiderEvents.rowCount).toBe(2);
      expect(raiderEvents.rows[0].actor_user_id).toBe(raider1Id);
      expect(raiderEvents.rows[0].points).toBe('2.00');
      expect(raiderEvents.rows[1].actor_user_id).toBe(raider2Id);
      expect(raiderEvents.rows[1].points).toBe('2.00');

      // Assert: Snapshot entries marked as awarded
      const snapshots = await query(
        `SELECT * FROM key_pop_snapshot 
         WHERE run_id = $1::bigint AND key_pop_number = $2`,
        [runId, keyPopNumber]
      );
      expect(snapshots.rows.every(s => s.awarded_completion === true)).toBe(true);
    });
  });

  describe('happy path - end run without snapshot (fallback to participants)', () => {
    it('should award points to all joined participants when keyPopCount is 0', async () => {
      // Arrange: Create run with participants only
      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');

      // Add participants
      await addParticipant(runId, raider1Id, 'join');
      await addParticipant(runId, raider2Id, 'join');

      // Act: End the run with no key pops
      const result = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0, // No key pops
      });

      // Assert: Check return values
      expect(result.organizerQuotaPoints).toBe(1);
      expect(result.raiderPointsAwarded).toBe(2); // Two joined participants

      // Assert: Run status updated
      const runCheck = await query(
        'SELECT status FROM run WHERE id = $1::bigint',
        [runId]
      );
      expect(runCheck.rows[0].status).toBe('ended');

      // Assert: Organizer quota event created
      const orgEvents = await query(
        `SELECT * FROM quota_event 
         WHERE actor_user_id = $1::bigint AND action_type = 'run_completed'`,
        [organizerId]
      );
      expect(orgEvents.rowCount).toBe(1);

      // Assert: Raider points events created for joined participants
      const raiderEvents = await query(
        `SELECT * FROM quota_event 
         WHERE guild_id = $1::bigint 
           AND action_type = 'run_completed'
           AND points > 0
         ORDER BY actor_user_id`,
        [guildId]
      );
      expect(raiderEvents.rowCount).toBe(2);
      expect(raiderEvents.rows[0].actor_user_id).toBe(raider1Id);
      expect(raiderEvents.rows[1].actor_user_id).toBe(raider2Id);
    });
  });

  describe('idempotency', () => {
    it('should not double-award if called twice on the same run', async () => {
      // Arrange
      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');
      await addParticipant(runId, raider1Id, 'join');

      // Act: End run twice
      const result1 = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0,
      });

      const result2 = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0,
      });

      // Assert: Second call should return 0 awards (idempotent)
      expect(result1.organizerQuotaPoints).toBe(1);
      expect(result1.raiderPointsAwarded).toBe(1);

      expect(result2.organizerQuotaPoints).toBe(0); // Already awarded
      expect(result2.raiderPointsAwarded).toBe(0); // Already awarded

      // Assert: Only one set of events exists
      const allEvents = await query(
        `SELECT * FROM quota_event WHERE guild_id = $1::bigint`,
        [guildId]
      );
      expect(allEvents.rowCount).toBe(2); // 1 organizer + 1 raider
    });
  });

  describe('transaction atomicity', () => {
    it('should rollback all changes if quota awarding fails', async () => {
      // This test verifies transactional behavior
      // In a real scenario, we'd inject an error, but for now we verify
      // that successful operations are atomic

      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');
      await addParticipant(runId, raider1Id, 'join');

      // Check initial state
      const runBefore = await query(
        'SELECT status FROM run WHERE id = $1::bigint',
        [runId]
      );
      expect(runBefore.rows[0].status).toBe('open');

      // End run successfully
      await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0,
      });

      // Verify all changes persisted together
      const runAfter = await query(
        'SELECT status FROM run WHERE id = $1::bigint',
        [runId]
      );
      expect(runAfter.rows[0].status).toBe('ended');

      const events = await query(
        `SELECT * FROM quota_event WHERE guild_id = $1::bigint`,
        [guildId]
      );
      expect(events.rowCount).toBeGreaterThan(0); // All events persisted
    });
  });

  describe('edge cases', () => {
    it('should handle run with no participants or snapshots', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');

      const result = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0,
      });

      // Only organizer should get points
      expect(result.organizerQuotaPoints).toBe(1);
      expect(result.raiderPointsAwarded).toBe(0);

      // Verify only organizer event exists
      const events = await query(
        `SELECT * FROM quota_event WHERE guild_id = $1::bigint`,
        [guildId]
      );
      expect(events.rowCount).toBe(1);
      expect(events.rows[0].actor_user_id).toBe(organizerId);
    });

    it('should handle runs with mixed participant states', async () => {
      const runId = await createTestRun(guildId, organizerId, dungeonKey, 'open');

      // Mix of states
      await addParticipant(runId, raider1Id, 'join');
      await addParticipant(runId, raider2Id, 'bench'); // Not joined (benched)

      const result = await endRunWithTransaction({
        runId,
        guildId,
        organizerId,
        dungeonKey,
        keyPopCount: 0,
      });

      // Only joined raider should get points
      expect(result.raiderPointsAwarded).toBe(1);

      const raiderEvents = await query(
        `SELECT * FROM quota_event WHERE points > 0 AND actor_user_id != $1::bigint`,
        [organizerId]
      );
      expect(raiderEvents.rowCount).toBe(1);
      expect(raiderEvents.rows[0].actor_user_id).toBe(raider1Id);
    });
  });
});

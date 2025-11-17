/**
 * Test Database Utilities
 * 
 * Helpers for setting up and tearing down test data in a real PostgreSQL database.
 * Tests should use a dedicated test database (set via TEST_DATABASE_URL or DATABASE_URL env var).
 */

import { pool, query } from '../../src/db/pool.js';

/**
 * Clean all test data from the database.
 * Call this in beforeEach/afterEach to ensure test isolation.
 * 
 * ⚠️ WARNING: This deletes ALL data in the database!
 * Only use with a dedicated test database!
 */
export async function cleanDatabase(): Promise<void> {
  await query('TRUNCATE TABLE quota_event CASCADE');
  await query('TRUNCATE TABLE quota_dungeon_override CASCADE');
  await query('TRUNCATE TABLE quota_role_config CASCADE');
  await query('TRUNCATE TABLE key_pop_snapshot CASCADE');
  await query('TRUNCATE TABLE reaction CASCADE');
  await query('TRUNCATE TABLE run CASCADE');
  await query('TRUNCATE TABLE guild_role CASCADE');
  await query('TRUNCATE TABLE guild_channel CASCADE');
  await query('TRUNCATE TABLE raider_points_config CASCADE');
  await query('TRUNCATE TABLE member CASCADE');
  await query('TRUNCATE TABLE guild CASCADE');
}

/**
 * Close the database pool.
 * Call this in afterAll to cleanly shut down tests.
 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/**
 * Setup a test guild with role mappings.
 */
export async function createTestGuild(guildId: string, guildName = 'Test Guild'): Promise<void> {
  await query(
    'INSERT INTO guild (id, name) VALUES ($1::bigint, $2) ON CONFLICT (id) DO NOTHING',
    [guildId, guildName]
  );
}

/**
 * Setup a test member.
 */
export async function createTestMember(userId: string, username = 'TestUser'): Promise<void> {
  await query(
    'INSERT INTO member (id, username) VALUES ($1::bigint, $2) ON CONFLICT (id) DO NOTHING',
    [userId, username]
  );
}

/**
 * Setup a guild role mapping (maps internal role to Discord role).
 */
export async function createGuildRoleMapping(
  guildId: string,
  roleKey: string,
  discordRoleId: string
): Promise<void> {
  await query(
    `INSERT INTO guild_role (guild_id, role_key, discord_role_id)
     VALUES ($1::bigint, $2, $3::bigint)
     ON CONFLICT (guild_id, role_key) DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id`,
    [guildId, roleKey, discordRoleId]
  );
}

/**
 * Create a test run.
 * Uses valid Discord snowflake-like IDs (15-22 digits) for channel_id.
 */
export async function createTestRun(
  guildId: string,
  organizerId: string,
  dungeonKey: string,
  status = 'open'
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO run (guild_id, organizer_id, dungeon_key, dungeon_label, channel_id, status)
     VALUES ($1::bigint, $2::bigint, $3, $4, $5::bigint, $6)
     RETURNING id`,
    [guildId, organizerId, dungeonKey, dungeonKey, '888888888888888888', status]
  );
  return res.rows[0].id;
}

/**
 * Add a participant reaction to a run.
 */
export async function addParticipant(runId: number, userId: string, state = 'join'): Promise<void> {
  await query(
    `INSERT INTO reaction (run_id, user_id, state)
     VALUES ($1::bigint, $2::bigint, $3)`,
    [runId, userId, state]
  );
}

/**
 * Add a key pop snapshot entry.
 */
export async function addKeyPopSnapshot(
  runId: number,
  keyPopNumber: number,
  userId: string
): Promise<void> {
  await query(
    `INSERT INTO key_pop_snapshot (run_id, key_pop_number, user_id, awarded_completion)
     VALUES ($1::bigint, $2, $3::bigint, FALSE)`,
    [runId, keyPopNumber, userId]
  );
}

/**
 * Configure raider points for a dungeon.
 */
export async function setRaiderPoints(
  guildId: string,
  dungeonKey: string,
  points: number
): Promise<void> {
  await query(
    `INSERT INTO raider_points_config (guild_id, dungeon_key, points)
     VALUES ($1::bigint, $2, $3)
     ON CONFLICT (guild_id, dungeon_key) DO UPDATE SET points = EXCLUDED.points`,
    [guildId, dungeonKey, points]
  );
}

/**
 * Configure organizer quota points for a role (required before setting dungeon overrides).
 */
export async function setQuotaRoleConfig(
  guildId: string,
  discordRoleId: string,
  requiredPoints = 0
): Promise<void> {
  await query(
    `INSERT INTO quota_role_config (guild_id, discord_role_id, required_points)
     VALUES ($1::bigint, $2::bigint, $3)
     ON CONFLICT (guild_id, discord_role_id) DO UPDATE SET required_points = EXCLUDED.required_points`,
    [guildId, discordRoleId, requiredPoints]
  );
}

/**
 * Configure organizer quota points override for a dungeon and role.
 * Note: Must call setQuotaRoleConfig first to satisfy foreign key constraint.
 */
export async function setQuotaDungeonOverride(
  guildId: string,
  discordRoleId: string,
  dungeonKey: string,
  points: number
): Promise<void> {
  // Ensure quota_role_config entry exists first
  await setQuotaRoleConfig(guildId, discordRoleId);
  
  await query(
    `INSERT INTO quota_dungeon_override (guild_id, discord_role_id, dungeon_key, points)
     VALUES ($1::bigint, $2::bigint, $3, $4)
     ON CONFLICT (guild_id, discord_role_id, dungeon_key) DO UPDATE SET points = EXCLUDED.points`,
    [guildId, discordRoleId, dungeonKey, points]
  );
}

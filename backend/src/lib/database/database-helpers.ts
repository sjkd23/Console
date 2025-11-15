import { query } from '../../db/pool.js';

/**
 * Ensures a guild exists in the database.
 * Upserts with default name if not exists.
 * 
 * @param guildId - Discord guild ID
 * @param guildName - Optional guild name (defaults to 'Unknown')
 */
export async function ensureGuildExists(guildId: string, guildName = 'Unknown'): Promise<void> {
    await query(
        `INSERT INTO guild (id, name) VALUES ($1::bigint, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [guildId, guildName]
    );
}

/**
 * Ensures a member exists in the database.
 * Upserts with optional username.
 * 
 * @param userId - Discord user ID
 * @param username - Optional username (defaults to null)
 */
export async function ensureMemberExists(userId: string, username: string | null = null): Promise<void> {
    await query(
        `INSERT INTO member (id, username) VALUES ($1::bigint, $2)
         ON CONFLICT (id) DO UPDATE SET username = COALESCE(EXCLUDED.username, member.username)`,
        [userId, username]
    );
}

/**
 * Get all guild role mappings from DB.
 * Returns Record<role_key, discord_role_id | null>
 * 
 * @param guildId - Discord guild ID
 * @returns Map of role keys to Discord role IDs
 */
export async function getGuildRoles(guildId: string): Promise<Record<string, string | null>> {
    const res = await query<{ role_key: string; discord_role_id: string }>(
        `SELECT role_key, discord_role_id FROM guild_role WHERE guild_id = $1::bigint`,
        [guildId]
    );

    const mapping: Record<string, string | null> = {};
    for (const row of res.rows) {
        mapping[row.role_key] = row.discord_role_id;
    }
    return mapping;
}

/**
 * Get all guild channel mappings from DB.
 * Returns Record<channel_key, discord_channel_id | null>
 * 
 * @param guildId - Discord guild ID
 * @returns Map of channel keys to Discord channel IDs
 */
export async function getGuildChannels(guildId: string): Promise<Record<string, string | null>> {
    const res = await query<{ channel_key: string; discord_channel_id: string }>(
        `SELECT channel_key, discord_channel_id FROM guild_channel WHERE guild_id = $1::bigint`,
        [guildId]
    );

    const mapping: Record<string, string | null> = {};
    for (const row of res.rows) {
        mapping[row.channel_key] = row.discord_channel_id;
    }
    return mapping;
}

/**
 * Get all dungeon role ping mappings from DB.
 * Returns Record<dungeon_key, discord_role_id>
 * 
 * @param guildId - Discord guild ID
 * @returns Map of dungeon keys to Discord role IDs
 */
export async function getDungeonRolePings(guildId: string): Promise<Record<string, string>> {
    const res = await query<{ dungeon_key: string; discord_role_id: string }>(
        `SELECT dungeon_key, discord_role_id FROM dungeon_role_ping WHERE guild_id = $1::bigint`,
        [guildId]
    );

    const mapping: Record<string, string> = {};
    for (const row of res.rows) {
        mapping[row.dungeon_key] = row.discord_role_id;
    }
    return mapping;
}

/**
 * Get the role ID for a specific dungeon ping configuration.
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon key (e.g., 'FUNGAL_CAVERN')
 * @returns Discord role ID or null if not configured
 */
export async function getDungeonRolePing(guildId: string, dungeonKey: string): Promise<string | null> {
    const res = await query<{ discord_role_id: string }>(
        `SELECT discord_role_id FROM dungeon_role_ping WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );

    return res.rows.length > 0 ? res.rows[0].discord_role_id : null;
}

/**
 * Set or update a dungeon role ping configuration.
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon key
 * @param discordRoleId - Discord role ID to ping
 */
export async function setDungeonRolePing(guildId: string, dungeonKey: string, discordRoleId: string): Promise<void> {
    await query(
        `INSERT INTO dungeon_role_ping (guild_id, dungeon_key, discord_role_id, updated_at)
         VALUES ($1::bigint, $2, $3::bigint, NOW())
         ON CONFLICT (guild_id, dungeon_key)
         DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id, updated_at = NOW()`,
        [guildId, dungeonKey, discordRoleId]
    );
}

/**
 * Delete a dungeon role ping configuration.
 * 
 * @param guildId - Discord guild ID
 * @param dungeonKey - Dungeon key
 */
export async function deleteDungeonRolePing(guildId: string, dungeonKey: string): Promise<void> {
    await query(
        `DELETE FROM dungeon_role_ping WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );
}

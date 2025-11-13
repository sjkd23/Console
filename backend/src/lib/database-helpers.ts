import { query } from '../db/pool.js';

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

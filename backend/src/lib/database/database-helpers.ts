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
 * Ensures a raider exists in the database for a guild.
 * If the raider doesn't exist, creates them with status based on whether they have the verified_raider role.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param username - Optional username (defaults to null)
 * @param userRoleIds - Optional array of Discord role IDs the user has
 */
export async function ensureRaiderExists(
    guildId: string, 
    userId: string, 
    username: string | null = null, 
    userRoleIds?: string[]
): Promise<void> {
    // First ensure the member exists in the member table
    await ensureMemberExists(userId, username);
    
    // Check if raider already exists
    const existing = await query(
        `SELECT 1 FROM raider WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
        [guildId, userId]
    );
    
    if (existing.rowCount && existing.rowCount > 0) {
        // Raider already exists, nothing to do
        return;
    }
    
    // Raider doesn't exist - need to create them
    // Determine if they should be auto-verified based on having the verified_raider role
    let status = 'pending';
    let verifiedAt: Date | null = null;
    
    if (userRoleIds && userRoleIds.length > 0) {
        // Get the verified_raider role mapping for this guild
        const roleMapping = await getGuildRoles(guildId);
        const verifiedRaiderRoleId = roleMapping['verified_raider'];
        
        // If the guild has a verified_raider role configured and the user has it
        if (verifiedRaiderRoleId && userRoleIds.includes(verifiedRaiderRoleId)) {
            status = 'approved';
            verifiedAt = new Date();
        }
    }
    
    // Insert the new raider
    await query(
        `INSERT INTO raider (guild_id, user_id, nickname, status, verified_at, notes)
         VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId, username, status, verifiedAt, null]
    );
    
    console.log(`[Database] Created raider ${userId} in guild ${guildId} with status: ${status}`);
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

import { query } from '../db/pool.js';

/**
 * Check if actor has moderator permission (administrator or moderator role).
 * Used for moderation commands like punishments and notes.
 * 
 * @param guildId - Discord guild ID
 * @param actorRoles - Array of Discord role IDs the actor has
 * @returns true if actor has moderator permission
 */
export async function hasModerator(guildId: string, actorRoles?: string[]): Promise<boolean> {
    if (!actorRoles || actorRoles.length === 0) return false;

    const res = await query<{ role_key: string }>(
        `SELECT role_key FROM guild_role 
         WHERE guild_id = $1::bigint 
         AND discord_role_id = ANY($2::bigint[])
         AND role_key IN ('administrator', 'moderator')`,
        [guildId, actorRoles]
    );

    return res.rows.length > 0;
}

/**
 * Check if actor has security permission (administrator, moderator, or security role).
 * Used for verification and IGN management commands.
 * 
 * @param guildId - Discord guild ID
 * @param actorRoles - Array of Discord role IDs the actor has
 * @returns true if actor has security permission
 */
export async function hasSecurity(guildId: string, actorRoles?: string[]): Promise<boolean> {
    if (!actorRoles || actorRoles.length === 0) return false;

    const res = await query<{ role_key: string }>(
        `SELECT role_key FROM guild_role 
         WHERE guild_id = $1::bigint 
         AND discord_role_id = ANY($2::bigint[])
         AND role_key IN ('administrator', 'moderator', 'security')`,
        [guildId, actorRoles]
    );

    return res.rows.length > 0;
}

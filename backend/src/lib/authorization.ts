// backend/src/lib/authorization.ts
import { query } from '../db/pool.js';
import { getGuildRoles as getGuildRoleMappings } from './database-helpers.js';

/**
 * Internal role keys (must match role_catalog entries)
 */
export type RoleKey =
    | 'administrator'
    | 'moderator'
    | 'head_organizer'
    | 'officer'
    | 'security'
    | 'organizer'
    | 'verified_raider';

/**
 * Check if a user has a specific internal role in a guild.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param roleKey - Internal role key to check
 * @param userRoleIds - Optional array of Discord role IDs the user has
 * @returns true if the user has the role, false otherwise
 * 
 * This checks if any of the user's Discord roles are mapped to the internal role.
 * If userRoleIds is not provided, returns false.
 */
export async function hasInternalRole(
    guildId: string,
    userId: string,
    roleKey: RoleKey,
    userRoleIds?: string[]
): Promise<boolean> {
    if (!userRoleIds || userRoleIds.length === 0) {
        console.log(`[Auth] User ${userId} in guild ${guildId} has no roles provided - denying ${roleKey}`);
        return false;
    }

    // Get guild's role mapping
    const mapping = await getGuildRoleMappings(guildId);
    const discordRoleId = mapping[roleKey];

    if (!discordRoleId) {
        console.log(`[Auth] Guild ${guildId} has no mapping for ${roleKey} - denying access for user ${userId}`);
        return false; // No mapping configured for this role
    }

    // Check if user has the mapped Discord role
    const hasRole = userRoleIds.includes(discordRoleId);
    console.log(`[Auth] User ${userId} in guild ${guildId} ${hasRole ? 'HAS' : 'MISSING'} ${roleKey} role (needs Discord role ${discordRoleId})`);
    return hasRole;
}

/**
 * Check if a user has any of the specified internal roles in a guild.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param roleKeys - Array of internal role keys to check
 * @param userRoleIds - Optional array of Discord role IDs the user has
 * @returns true if the user has any of the roles, false otherwise
 */
export async function hasAnyInternalRole(
    guildId: string,
    userId: string,
    roleKeys: RoleKey[],
    userRoleIds?: string[]
): Promise<boolean> {
    if (!userRoleIds || userRoleIds.length === 0) {
        return false;
    }

    // Get guild's role mapping
    const mapping = await getGuildRoleMappings(guildId);

    // Check if user has any of the mapped Discord roles
    for (const roleKey of roleKeys) {
        const discordRoleId = mapping[roleKey];
        if (discordRoleId && userRoleIds.includes(discordRoleId)) {
            return true;
        }
    }

    return false;
}

/**
 * Authorization helper: Check if actor is authorized to modify guild roles.
 * Authorized if:
 * - actor has the mapped 'administrator' role in this guild
 * 
 * @param guildId - Discord guild ID
 * @param actorUserId - Discord user ID of the actor
 * @param actorRoles - Optional array of Discord role IDs the actor has
 * @returns true if authorized, false otherwise
 */
export async function canManageGuildRoles(
    guildId: string,
    actorUserId: string,
    actorRoles?: string[]
): Promise<boolean> {
    return hasInternalRole(guildId, actorUserId, 'administrator', actorRoles);
}

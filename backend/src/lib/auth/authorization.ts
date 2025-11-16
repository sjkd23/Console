// backend/src/lib/authorization.ts
import { query } from '../../db/pool.js';
import { getGuildRoles as getGuildRoleMappings } from '../database/database-helpers.js';

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
 * Role hierarchy (higher index = higher authority)
 * Used to determine if one role outranks another
 */
const ROLE_HIERARCHY: RoleKey[] = [
    'verified_raider',
    'organizer',
    'security',
    'officer',
    'head_organizer',
    'moderator',
    'administrator',
];

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
 * Check if a user has the required role OR any role higher in the hierarchy.
 * This is the primary function for permission checking as it respects role hierarchy.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param requiredRole - The minimum role required
 * @param userRoleIds - Optional array of Discord role IDs the user has
 * @returns true if the user has the required role or higher, false otherwise
 * 
 * Examples:
 * - hasRequiredRoleOrHigher(..., 'security', ...) returns true for security, officer, head_organizer, moderator, or administrator
 * - hasRequiredRoleOrHigher(..., 'officer', ...) returns true for officer, head_organizer, moderator, or administrator
 */
export async function hasRequiredRoleOrHigher(
    guildId: string,
    userId: string,
    requiredRole: RoleKey,
    userRoleIds?: string[]
): Promise<boolean> {
    if (!userRoleIds || userRoleIds.length === 0) {
        console.log(`[Auth] User ${userId} in guild ${guildId} has no roles provided - denying ${requiredRole}+`);
        return false;
    }

    // Find the required role's position in hierarchy
    const requiredRoleIndex = ROLE_HIERARCHY.indexOf(requiredRole);
    if (requiredRoleIndex === -1) {
        console.log(`[Auth] Invalid role key: ${requiredRole}`);
        return false;
    }

    // Get guild's role mapping
    const mapping = await getGuildRoleMappings(guildId);

    // Check if user has the required role or any role higher in the hierarchy
    // Iterate from highest to lowest, starting from roles at or above the required level
    for (let i = ROLE_HIERARCHY.length - 1; i >= requiredRoleIndex; i--) {
        const roleKey = ROLE_HIERARCHY[i];
        const discordRoleId = mapping[roleKey];
        
        // If this role is configured and user has it, they pass
        if (discordRoleId && userRoleIds.includes(discordRoleId)) {
            console.log(`[Auth] User ${userId} in guild ${guildId} HAS ${roleKey} role (required ${requiredRole}+) - access granted`);
            return true;
        }
    }

    console.log(`[Auth] User ${userId} in guild ${guildId} MISSING ${requiredRole}+ role - access denied`);
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

/**
 * Helper function to verify a user has the required role or higher.
 * Throws an error with consistent messaging if the check fails.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param requiredRole - The minimum role required
 * @param userRoles - Optional array of Discord role IDs the user has
 * @throws Error with code property if user doesn't have required role
 * 
 * Usage in routes:
 * ```
 * await requireRole(guild_id, actor_user_id, 'security', actor_roles);
 * ```
 */
export async function requireRole(
    guildId: string,
    userId: string,
    requiredRole: RoleKey,
    userRoles?: string[]
): Promise<void> {
    const hasRole = await hasRequiredRoleOrHigher(guildId, userId, requiredRole, userRoles);
    
    if (!hasRole) {
        // Format role name for display (e.g., 'security' -> 'Security', 'head_organizer' -> 'Head Organizer')
        const roleDisplay = requiredRole
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        
        const error: any = new Error(`You need the ${roleDisplay} role or higher to use this command`);
        error.code = 'INSUFFICIENT_PERMISSIONS';
        error.statusCode = 403;
        error.requiredRole = requiredRole;
        throw error;
    }
}

/**
 * Convenience helper: Require Security role or higher
 */
export async function requireSecurity(
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<void> {
    return requireRole(guildId, userId, 'security', userRoles);
}

/**
 * Convenience helper: Require Officer role or higher
 */
export async function requireOfficer(
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<void> {
    return requireRole(guildId, userId, 'officer', userRoles);
}

/**
 * Convenience helper: Require Moderator role or higher
 */
export async function requireModerator(
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<void> {
    return requireRole(guildId, userId, 'moderator', userRoles);
}

/**
 * Convenience helper: Require Administrator role
 */
export async function requireAdministrator(
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<void> {
    return requireRole(guildId, userId, 'administrator', userRoles);
}

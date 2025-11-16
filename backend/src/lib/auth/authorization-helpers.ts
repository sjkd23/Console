/**
 * Authorization helpers with admin permission fallback pattern
 * Reduces duplication in guilds.ts where admin permission check precedes role check
 */

import { FastifyReply } from 'fastify';
import { canManageGuildRoles, requireSecurity, requireOfficer } from '../auth/authorization.js';
import { Errors } from '../errors/errors.js';

/**
 * Result of authorization check
 */
export interface AuthCheckResult {
    authorized: boolean;
    reason?: string;
}

/**
 * Checks if user has Discord admin permission OR the required internal role
 * This pattern appears 3+ times in guilds.ts
 * @param guildId - The guild ID
 * @param actorUserId - The user ID to check
 * @param hasAdminPermission - Whether user has Discord Administrator permission
 * @param actorRoles - Optional array of user's Discord role IDs
 * @param requiredRoleCheck - Function to check internal role (default: canManageGuildRoles)
 * @returns Authorization result
 */
export async function checkAdminOrRole(
    guildId: string,
    actorUserId: string,
    hasAdminPermission: boolean | undefined,
    actorRoles: string[] | undefined,
    requiredRoleCheck: (guildId: string, userId: string, roles?: string[]) => Promise<boolean> = canManageGuildRoles
): Promise<AuthCheckResult> {
    // First check Discord Administrator permission
    if (hasAdminPermission) {
        console.log(`[Auth] User ${actorUserId} authorized via Discord Administrator permission`);
        return { authorized: true, reason: 'Discord Administrator permission' };
    }
    
    // Fall back to internal role check
    const hasRole = await requiredRoleCheck(guildId, actorUserId, actorRoles);
    if (hasRole) {
        console.log(`[Auth] User ${actorUserId} authorized via mapped role`);
        return { authorized: true, reason: 'Mapped role' };
    }
    
    console.log(`[Auth] User ${actorUserId} in guild ${guildId} denied - no admin permission or required role`);
    return { authorized: false };
}

/**
 * Checks admin OR role authorization and returns error if unauthorized
 * Convenience wrapper that handles the error response
 * @returns True if authorized, false if not (with error sent)
 */
export async function requireAdminOrRole(
    reply: FastifyReply,
    guildId: string,
    actorUserId: string,
    hasAdminPermission: boolean | undefined,
    actorRoles: string[] | undefined,
    requiredRoleCheck?: (guildId: string, userId: string, roles?: string[]) => Promise<boolean>
): Promise<boolean> {
    const result = await checkAdminOrRole(
        guildId,
        actorUserId,
        hasAdminPermission,
        actorRoles,
        requiredRoleCheck
    );
    
    if (!result.authorized) {
        Errors.notAuthorized(reply);
        return false;
    }
    
    return true;
}

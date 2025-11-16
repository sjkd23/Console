import { FastifyReply } from 'fastify';
import { requireSecurity, requireOfficer, requireModerator, requireAdministrator, requireRole, RoleKey } from '../auth/authorization.js';

/**
 * Authorization error wrapper that catches permission errors and sends appropriate responses.
 * 
 * @param reply - Fastify reply object
 * @param checkFn - Async function that performs authorization check
 * @returns True if authorized, false if not (error response sent)
 * 
 * @example
 * if (!await withAuthCheck(reply, () => requireSecurity(guildId, userId, roles))) return;
 */
export async function withAuthCheck(
    reply: FastifyReply,
    checkFn: () => Promise<void>
): Promise<boolean> {
    try {
        await checkFn();
        return true;
    } catch (err: any) {
        const code = err.code || 'NOT_AUTHORIZED';
        const status = err.statusCode || 403;
        const message = err.message || 'You are not authorized to perform this action';
        
        reply.code(status).send({
            error: { code, message },
        });
        return false;
    }
}

/**
 * Shorthand for security role check with automatic error response.
 */
export async function requireSecurityOrReply(
    reply: FastifyReply,
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<boolean> {
    return withAuthCheck(reply, () => requireSecurity(guildId, userId, userRoles));
}

/**
 * Shorthand for officer role check with automatic error response.
 */
export async function requireOfficerOrReply(
    reply: FastifyReply,
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<boolean> {
    return withAuthCheck(reply, () => requireOfficer(guildId, userId, userRoles));
}

/**
 * Shorthand for moderator role check with automatic error response.
 */
export async function requireModeratorOrReply(
    reply: FastifyReply,
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<boolean> {
    return withAuthCheck(reply, () => requireModerator(guildId, userId, userRoles));
}

/**
 * Shorthand for administrator role check with automatic error response.
 */
export async function requireAdministratorOrReply(
    reply: FastifyReply,
    guildId: string,
    userId: string,
    userRoles?: string[]
): Promise<boolean> {
    return withAuthCheck(reply, () => requireAdministrator(guildId, userId, userRoles));
}

/**
 * Generic role check with automatic error response.
 */
export async function requireRoleOrReply(
    reply: FastifyReply,
    guildId: string,
    userId: string,
    requiredRole: RoleKey,
    userRoles?: string[]
): Promise<boolean> {
    return withAuthCheck(reply, () => requireRole(guildId, userId, requiredRole, userRoles));
}

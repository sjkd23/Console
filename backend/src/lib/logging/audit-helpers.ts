/**
 * Backend audit logging helpers to reduce code duplication
 */

import { ensureMemberExists } from '../database/database-helpers.js';
import { logAudit } from '../logging/audit.js';

/**
 * Ensures member exists in database and logs audit event
 * Combines two common operations that always occur together
 * @param guildId - The guild ID
 * @param actorUserId - The user ID of the actor
 * @param eventType - The audit event type
 * @param targetId - The target entity ID (user, guild, etc.)
 * @param data - Additional audit data
 */
export async function ensureMemberAndLogAudit(
    guildId: string,
    actorUserId: string,
    eventType: string,
    targetId: string,
    data?: Record<string, any>
): Promise<void> {
    // Ensure actor exists in member table before audit logging
    // This prevents foreign key constraint violations
    await ensureMemberExists(actorUserId);
    
    // Log audit event
    await logAudit(guildId, actorUserId, eventType, targetId, data);
}

/**
 * Ensures multiple members exist in database then logs audit event
 * Used when both actor and target must exist (e.g., moderation actions)
 * @param guildId - The guild ID
 * @param actorUserId - The user ID of the actor
 * @param targetUserId - The user ID of the target
 * @param eventType - The audit event type
 * @param data - Additional audit data
 */
export async function ensureMembersAndLogAudit(
    guildId: string,
    actorUserId: string,
    targetUserId: string,
    eventType: string,
    data?: Record<string, any>
): Promise<void> {
    // Ensure both actor and target exist in member table
    await ensureMemberExists(actorUserId);
    await ensureMemberExists(targetUserId);
    
    // Log audit event
    await logAudit(guildId, actorUserId, eventType, targetUserId, data);
}

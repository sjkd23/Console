import { query } from '../db/pool.js';

/**
 * Helper to log audit events.
 * Centralized audit logging to avoid duplication across routes.
 * 
 * @param guildId - Discord guild ID
 * @param actorId - User ID of the actor, or null for system-initiated actions
 * @param action - Action identifier (e.g., 'raider.verify', 'punishment.suspend')
 * @param subject - Subject ID (typically user ID being acted upon)
 * @param meta - Optional metadata object to store additional context
 */
export async function logAudit(
    guildId: string,
    actorId: string | null,
    action: string,
    subject: string,
    meta?: Record<string, unknown>
): Promise<void> {
    await query(
        `INSERT INTO audit (guild_id, actor_id, action, subject, meta)
         VALUES ($1::bigint, $2::bigint, $3, $4, $5)`,
        [guildId, actorId, action, subject, meta ? JSON.stringify(meta) : null]
    );
}

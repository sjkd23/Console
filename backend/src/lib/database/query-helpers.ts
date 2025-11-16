import { FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { Errors } from '../errors/errors.js';
import { ensureMemberExists } from './database-helpers.js';

/**
 * Checks if an IGN is already in use by another user in the guild.
 * Returns the conflicting user ID if found, null otherwise.
 * 
 * @param guildId - Discord guild ID
 * @param ign - In-game name to check
 * @param excludeUserId - User ID to exclude from check (for updates)
 * @returns Conflicting user ID or null
 */
export async function checkIgnConflict(
    guildId: string,
    ign: string,
    excludeUserId?: string
): Promise<string | null> {
    const sql = excludeUserId
        ? `SELECT user_id FROM raider 
           WHERE guild_id = $1::bigint 
           AND LOWER(ign) = LOWER($2) 
           AND user_id != $3::bigint`
        : `SELECT user_id FROM raider 
           WHERE guild_id = $1::bigint 
           AND LOWER(ign) = LOWER($2)`;
    
    const params = excludeUserId ? [guildId, ign, excludeUserId] : [guildId, ign];
    
    const result = await query<{ user_id: string }>(sql, params);
    
    return result.rowCount && result.rowCount > 0 ? result.rows[0].user_id : null;
}

/**
 * Checks if an IGN conflicts with main or alt IGN of another user.
 * Sends error response if conflict found.
 * 
 * @param guildId - Discord guild ID
 * @param ign - In-game name to check
 * @param excludeUserId - User ID to exclude from check
 * @param reply - Fastify reply object
 * @param ignType - Type of IGN being checked ('main' or 'alt')
 * @returns True if no conflict, false if conflict found (error sent)
 */
export async function checkIgnConflictOrReply(
    guildId: string,
    ign: string,
    excludeUserId: string,
    reply: FastifyReply,
    ignType: 'main' | 'alt' = 'main'
): Promise<boolean> {
    const conflictUserId = await checkIgnConflict(guildId, ign, excludeUserId);
    
    if (conflictUserId) {
        reply.code(409).send({
            error: {
                code: 'IGN_ALREADY_IN_USE',
                message: `The IGN "${ign}" is already in use by another member in this server`,
                conflictUserId,
            },
        });
        return false;
    }
    
    return true;
}

/**
 * Checks if an alt IGN conflicts with any IGN (main or alt) of other users.
 * 
 * @param guildId - Discord guild ID
 * @param altIgn - Alt IGN to check
 * @param userId - User ID to exclude from check
 * @returns Conflicting user ID or null, and whether it's a main IGN
 */
export async function checkAltIgnConflict(
    guildId: string,
    altIgn: string,
    userId: string
): Promise<{ conflictUserId: string | null; isMainIgn: boolean }> {
    const result = await query<{ user_id: string; ign: string; alt_ign: string | null }>(
        `SELECT user_id, ign, alt_ign FROM raider 
         WHERE guild_id = $1::bigint 
         AND user_id != $2::bigint
         AND (LOWER(ign) = LOWER($3) OR LOWER(alt_ign) = LOWER($3))`,
        [guildId, userId, altIgn]
    );
    
    if (result.rowCount && result.rowCount > 0) {
        const row = result.rows[0];
        const isMainIgn = row.ign.toLowerCase() === altIgn.toLowerCase();
        return { conflictUserId: row.user_id, isMainIgn };
    }
    
    return { conflictUserId: null, isMainIgn: false };
}

/**
 * Gets a run's status and validates it exists.
 * Sends error response if run not found.
 * 
 * @param runId - Run ID
 * @param reply - Fastify reply object
 * @returns Run status or null if not found (error sent)
 */
export async function getRunStatusOrReply(
    runId: number,
    reply: FastifyReply
): Promise<string | null> {
    const result = await query<{ status: string }>(
        `SELECT status FROM run WHERE id = $1::bigint`,
        [runId]
    );
    
    if (result.rowCount === 0) {
        Errors.runNotFound(reply, runId);
        return null;
    }
    
    return result.rows[0].status;
}

/**
 * Checks if a run is closed (ended) and sends error if so.
 * 
 * @param runId - Run ID
 * @param reply - Fastify reply object
 * @returns True if run is open, false if closed (error sent)
 */
export async function checkRunNotClosedOrReply(
    runId: number,
    reply: FastifyReply
): Promise<boolean> {
    const status = await getRunStatusOrReply(runId, reply);
    if (!status) return false; // Error already sent
    
    if (status === 'ended') {
        Errors.runClosed(reply);
        return false;
    }
    
    return true;
}

/**
 * Ensures multiple members exist in the database.
 * Convenience wrapper for ensuring actor and target members exist.
 * 
 * @param userIds - Array of [userId, username?] tuples
 */
export async function ensureMultipleMembersExist(
    ...userIds: Array<[string, string?]>
): Promise<void> {
    await Promise.all(
        userIds.map(([id, name]) => ensureMemberExists(id, name || null))
    );
}

/**
 * Gets a raider's data or sends 404 error.
 * 
 * @param guildId - Discord guild ID
 * @param userId - Discord user ID
 * @param reply - Fastify reply object
 * @returns Raider data or null if not found (error sent)
 */
export async function getRaiderOrReply(
    guildId: string,
    userId: string,
    reply: FastifyReply
): Promise<{ ign: string; alt_ign: string | null; status: string } | null> {
    const result = await query<{ ign: string; alt_ign: string | null; status: string }>(
        `SELECT ign, alt_ign, status FROM raider 
         WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
        [guildId, userId]
    );
    
    if (!result.rowCount || result.rowCount === 0) {
        reply.code(404).send({
            error: {
                code: 'RAIDER_NOT_FOUND',
                message: 'This user is not verified in this server',
            },
        });
        return null;
    }
    
    return result.rows[0];
}

/**
 * Gets a punishment by ID or sends 404 error.
 * 
 * @param punishmentId - Punishment ID
 * @param reply - Fastify reply object
 * @returns Punishment data or null if not found (error sent)
 */
export async function getPunishmentOrReply(
    punishmentId: string,
    reply: FastifyReply
): Promise<{ guild_id: string; user_id: string; type: string; active: boolean } | null> {
    const result = await query<{ guild_id: string; user_id: string; type: string; active: boolean }>(
        `SELECT guild_id, user_id, type, active FROM punishment WHERE id = $1`,
        [punishmentId]
    );
    
    if (result.rows.length === 0) {
        Errors.punishmentNotFound(reply);
        return null;
    }
    
    return result.rows[0];
}

// backend/src/routes/raid/sync.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { requireAdministrator } from '../../lib/auth/authorization.js';
import { logAudit } from '../../lib/logging/audit.js';
import { ensureGuildExists, ensureMemberExists } from '../../lib/database/database-helpers.js';

/**
 * Schema for a single member to sync
 */
const SyncMemberSchema = z.object({
    user_id: zSnowflake,
    main_ign: z.string().trim().min(1).max(16),
    alt_ign: z.string().trim().min(1).max(16).optional(),
});

/**
 * Body schema for bulk sync endpoint
 */
const BulkSyncBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(),
    // Flag to indicate if actor has Discord Administrator permission
    actor_has_admin_permission: z.boolean().optional(),
    guild_id: zSnowflake,
    members: z.array(SyncMemberSchema),
});

/**
 * Result for a single member sync operation
 */
type SyncResult = {
    user_id: string;
    status: 'synced' | 'skipped' | 'failed';
    ign?: string; // The IGN that was synced (if status='synced')
    reason?: string; // Reason for skip/failure
};

export default async function syncRoutes(app: FastifyInstance) {
    /**
     * POST /sync/bulk
     * Bulk sync multiple members' IGNs with the database.
     * 
     * For each member:
     * - Sets main_ign as the primary IGN
     * - Optionally sets alt_ign if provided
     * - Skips if IGNs are already in use by another user or if member is already verified
     * 
     * Authorization: actor_user_id must have Administrator role
     * 
     * Returns:
     * - synced: Array of successfully synced members
     * - skipped: Array of members skipped (already verified or IGN conflict)
     * - failed: Array of members that failed due to errors
     */
    app.post('/sync/bulk', async (req, reply) => {
        const parsed = BulkSyncBody.safeParse(req.body);
        if (!parsed.success) {
            const msg = parsed.error.issues.map(i => i.message).join('; ');
            return Errors.validation(reply, msg);
        }

        const { actor_user_id, actor_roles, actor_has_admin_permission, guild_id, members } = parsed.data;

        console.log(`[BulkSync] Actor ${actor_user_id} in guild ${guild_id} syncing ${members.length} members`);

        // Authorization: Allow if user has Discord Administrator permission OR the mapped administrator role
        let authorized = false;

        if (actor_has_admin_permission) {
            console.log(`[BulkSync] User ${actor_user_id} authorized via Discord Administrator permission`);
            authorized = true;
        } else {
            try {
                await requireAdministrator(guild_id, actor_user_id, actor_roles);
                console.log(`[BulkSync] User ${actor_user_id} authorized via mapped administrator role`);
                authorized = true;
            } catch (err) {
                authorized = false;
            }
        }

        if (!authorized) {
            console.log(`[BulkSync] User ${actor_user_id} in guild ${guild_id} denied - no admin permission or role`);
            return reply.code(403).send({
                error: {
                    code: 'NOT_ADMINISTRATOR',
                    message: 'You need the Administrator role or Discord Administrator permission to use bulk sync',
                },
            });
        }

        // Ensure guild exists
        await ensureGuildExists(guild_id);

        // Ensure actor exists
        await ensureMemberExists(actor_user_id);

        // Track results
        const synced: SyncResult[] = [];
        const skipped: SyncResult[] = [];
        const failed: SyncResult[] = [];

        // Get all existing IGNs in this guild (for conflict checking)
        const existingIgnsRes = await query<{ user_id: string; ign: string; alt_ign: string | null }>(
            `SELECT user_id, ign, alt_ign FROM raider WHERE guild_id = $1::bigint`,
            [guild_id]
        );

        // Build a set of lowercase IGNs already in use (with user_id for conflict detection)
        const ignUsage = new Map<string, string>(); // lowercase IGN -> user_id
        for (const row of existingIgnsRes.rows) {
            if (row.ign) {
                ignUsage.set(row.ign.toLowerCase(), row.user_id);
            }
            if (row.alt_ign) {
                ignUsage.set(row.alt_ign.toLowerCase(), row.user_id);
            }
        }

        // Process each member
        for (const member of members) {
            try {
                const { user_id, main_ign, alt_ign } = member;

                // Ensure member exists in our system
                await ensureMemberExists(user_id);

                // Check if member is already verified in this guild (to determine if update or insert)
                const existingRaider = await query<{ ign: string; status: string; alt_ign: string | null }>(
                    `SELECT ign, status, alt_ign FROM raider 
                     WHERE guild_id = $1::bigint AND user_id = $2::bigint`,
                    [guild_id, user_id]
                );

                const isExistingRaider = existingRaider.rowCount && existingRaider.rowCount > 0;
                const existingIgn = isExistingRaider ? existingRaider.rows[0].ign : null;
                const existingAltIgn = isExistingRaider ? existingRaider.rows[0].alt_ign : null;

                // Check if IGNs have changed (only skip if IGNs are exactly the same)
                if (isExistingRaider && 
                    existingIgn === main_ign && 
                    existingAltIgn === (alt_ign || null)) {
                    skipped.push({
                        user_id,
                        status: 'skipped',
                        reason: 'IGN unchanged',
                    });
                    continue;
                }

                // Check if main IGN is already in use by another user
                const mainIgnLower = main_ign.toLowerCase();
                const mainIgnInUseBy = ignUsage.get(mainIgnLower);
                if (mainIgnInUseBy && mainIgnInUseBy !== user_id) {
                    skipped.push({
                        user_id,
                        status: 'skipped',
                        reason: `Main IGN "${main_ign}" already in use by another user`,
                    });
                    continue;
                }

                // Check if alt IGN (if provided) is already in use by another user
                if (alt_ign) {
                    const altIgnLower = alt_ign.toLowerCase();
                    const altIgnInUseBy = ignUsage.get(altIgnLower);
                    if (altIgnInUseBy && altIgnInUseBy !== user_id) {
                        skipped.push({
                            user_id,
                            status: 'skipped',
                            reason: `Alt IGN "${alt_ign}" already in use by another user`,
                        });
                        continue;
                    }
                }

                // Insert the raider record with main and optional alt IGN
                await query(
                    `INSERT INTO raider (guild_id, user_id, ign, alt_ign, status, verified_at)
                     VALUES ($1::bigint, $2::bigint, $3, $4, 'approved', NOW())
                     ON CONFLICT (guild_id, user_id) DO UPDATE
                     SET ign = EXCLUDED.ign,
                         alt_ign = EXCLUDED.alt_ign,
                         status = EXCLUDED.status,
                         verified_at = EXCLUDED.verified_at`,
                    [guild_id, user_id, main_ign, alt_ign || null]
                );

                // Add to ignUsage map to prevent duplicate usage in this batch
                ignUsage.set(mainIgnLower, user_id);
                if (alt_ign) {
                    ignUsage.set(alt_ign.toLowerCase(), user_id);
                }

                synced.push({
                    user_id,
                    status: 'synced',
                    ign: main_ign,
                });

                // Log audit event
                await logAudit(guild_id, actor_user_id, 'raider.bulk_sync', user_id, {
                    ign: main_ign,
                    alt_ign: alt_ign || null,
                });
            } catch (err) {
                console.error(`[BulkSync] Error syncing member ${member.user_id}:`, err);
                failed.push({
                    user_id: member.user_id,
                    status: 'failed',
                    reason: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        }

        console.log(
            `[BulkSync] Complete: ${synced.length} synced, ${skipped.length} skipped, ${failed.length} failed`
        );

        return reply.code(200).send({
            synced,
            skipped,
            failed,
        });
    });
}

// backend/src/routes/guilds.ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { zSnowflake } from '../lib/constants.js';
import { Errors } from '../lib/errors.js';
import { canManageGuildRoles } from '../lib/authorization.js';
import { logAudit } from '../lib/audit.js';
import { ensureGuildExists, ensureMemberExists, getGuildRoles, getGuildChannels } from '../lib/database-helpers.js';

/**
 * Internal role keys (must match role_catalog entries)
 */
const ROLE_KEYS = [
    'administrator',
    'moderator',
    'head_organizer',
    'officer',
    'security',
    'organizer',
    'team',
    'verified_raider',
    'suspended',
] as const;

const zRoleKey = z.enum(ROLE_KEYS);
type RoleKey = z.infer<typeof zRoleKey>;

/**
 * Internal channel keys (must match channel_catalog entries)
 */
const CHANNEL_KEYS = [
    'raid',
    'veri_log',
    'manual_verification',
    'getverified',
    'punishment_log',
    'raid_log',
    'quota',
    'bot_log',
    'staff_updates',
] as const;

const zChannelKey = z.enum(CHANNEL_KEYS);
type ChannelKey = z.infer<typeof zChannelKey>;

/**
 * Body schema for PUT /guilds/:guild_id/roles
 */
const PutRolesBody = z.object({
    actor_user_id: zSnowflake,
    // Partial updates: only include keys you want to change
    // null means delete the mapping
    roles: z
        .record(z.string(), zSnowflake.nullable())
        .refine(
            obj => Object.keys(obj).length > 0,
            'At least one role must be provided'
        ),
    // Optional: bot can send actor's Discord role IDs for backend-side checks
    actor_roles: z.array(zSnowflake).optional(),
    // Flag to indicate if actor has Discord Administrator permission
    actor_has_admin_permission: z.boolean().optional(),
});

/**
 * Body schema for PUT /guilds/:guild_id/channels
 */
const PutChannelsBody = z.object({
    actor_user_id: zSnowflake,
    // Partial updates: only include keys you want to change
    // null means delete the mapping
    channels: z
        .record(z.string(), zSnowflake.nullable())
        .refine(
            obj => Object.keys(obj).length > 0,
            'At least one channel must be provided'
        ),
    // Optional: bot can send actor's Discord role IDs for backend-side checks
    actor_roles: z.array(zSnowflake).optional(),
    // Flag to indicate if actor has Discord Administrator permission
    actor_has_admin_permission: z.boolean().optional(),
});

export default async function guildsRoutes(app: FastifyInstance) {
    /**
     * GET /guilds/:guild_id/roles
     * Returns the current role mappings for a guild.
     * Response: { roles: Record<role_key, discord_role_id | null> }
     */
    app.get('/guilds/:guild_id/roles', async (req, reply) => {
        const Params = z.object({ guild_id: zSnowflake });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid guild_id');
        }

        const { guild_id } = parsed.data;
        const roles = await getGuildRoles(guild_id);

        return reply.send({ roles });
    });

    /**
     * PUT /guilds/:guild_id/roles
     * Updates role mappings for a guild.
     * Body: { actor_user_id, roles: Record<role_key, discord_role_id | null> }
     * 
     * Behavior:
     * - For each provided key with a Snowflake value: upsert mapping
     * - For each provided key with null value: delete mapping
     * - Ignore unknown role keys (log warning but don't fail)
     * - Returns full current mapping after updates
     * - Logs audit event with diff
     */
    app.put('/guilds/:guild_id/roles', async (req, reply) => {
        const Params = z.object({ guild_id: zSnowflake });
        const p = Params.safeParse(req.params);
        const b = PutRolesBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { guild_id } = p.data;
        const { actor_user_id, roles, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization check: Allow if user has Discord Administrator permission OR the mapped administrator role
        let authorized = false;
        
        if (actor_has_admin_permission) {
            console.log(`[Guild Roles] User ${actor_user_id} authorized via Discord Administrator permission`);
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
            if (authorized) {
                console.log(`[Guild Roles] User ${actor_user_id} authorized via mapped administrator role`);
            }
        }
        
        if (!authorized) {
            console.log(`[Guild Roles] User ${actor_user_id} in guild ${guild_id} denied - no admin permission or role`);
            return Errors.notAuthorized(reply);
        }

        // Get current mapping for audit diff
        const previousMapping = await getGuildRoles(guild_id);

        // Ensure guild exists
        await ensureGuildExists(guild_id);

        // Ensure actor exists in member table before audit logging
        // This prevents foreign key constraint violations
        await ensureMemberExists(actor_user_id);

        const warnings: string[] = [];
        const updates: Record<string, string | null> = {};

        // Process each provided role
        for (const [roleKey, discordRoleId] of Object.entries(roles)) {
            // Validate role_key exists in catalog
            const validKey = ROLE_KEYS.includes(roleKey as any);
            if (!validKey) {
                warnings.push(`Unknown role key: ${roleKey}`);
                continue;
            }

            updates[roleKey] = discordRoleId;

            if (discordRoleId === null) {
                // Delete mapping
                await query(
                    `DELETE FROM guild_role 
                     WHERE guild_id = $1::bigint AND role_key = $2`,
                    [guild_id, roleKey]
                );
            } else {
                // Upsert mapping
                await query(
                    `INSERT INTO guild_role (guild_id, role_key, discord_role_id, updated_at)
                     VALUES ($1::bigint, $2, $3::bigint, NOW())
                     ON CONFLICT (guild_id, role_key)
                     DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id, updated_at = NOW()`,
                    [guild_id, roleKey, discordRoleId]
                );
            }
        }

        // Get updated mapping
        const currentMapping = await getGuildRoles(guild_id);

        // Log audit event with diff
        await logAudit(guild_id, actor_user_id, 'guild.roles.set', guild_id, {
            previous: previousMapping,
            current: currentMapping,
            updates,
        });

        const response: any = { roles: currentMapping };
        if (warnings.length > 0) {
            response.warnings = warnings;
        }

        return reply.send(response);
    });

    /**
     * GET /guilds/:guild_id/channels
     * Returns the current channel mappings for a guild.
     * Response: { channels: Record<channel_key, discord_channel_id | null> }
     */
    app.get('/guilds/:guild_id/channels', async (req, reply) => {
        const Params = z.object({ guild_id: zSnowflake });
        const parsed = Params.safeParse(req.params);

        if (!parsed.success) {
            return Errors.validation(reply, 'Invalid guild_id');
        }

        const { guild_id } = parsed.data;
        const channels = await getGuildChannels(guild_id);

        return reply.send({ channels });
    });

    /**
     * PUT /guilds/:guild_id/channels
     * Updates channel mappings for a guild.
     * Body: { actor_user_id, channels: Record<channel_key, discord_channel_id | null> }
     * 
     * Behavior:
     * - For each provided key with a Snowflake value: upsert mapping
     * - For each provided key with null value: delete mapping
     * - Ignore unknown channel keys (log warning but don't fail)
     * - Returns full current mapping after updates
     * - Logs audit event with diff
     */
    app.put('/guilds/:guild_id/channels', async (req, reply) => {
        const Params = z.object({ guild_id: zSnowflake });
        const p = Params.safeParse(req.params);
        const b = PutChannelsBody.safeParse(req.body);

        if (!p.success || !b.success) {
            const msg = [...(p.error?.issues ?? []), ...(b.error?.issues ?? [])]
                .map(i => i.message)
                .join('; ');
            return Errors.validation(reply, msg || 'Invalid request');
        }

        const { guild_id } = p.data;
        const { actor_user_id, channels, actor_roles, actor_has_admin_permission } = b.data;

        // Authorization check: Allow if user has Discord Administrator permission OR the mapped administrator role
        let authorized = false;
        
        if (actor_has_admin_permission) {
            console.log(`[Guild Channels] User ${actor_user_id} authorized via Discord Administrator permission`);
            authorized = true;
        } else {
            authorized = await canManageGuildRoles(guild_id, actor_user_id, actor_roles);
            if (authorized) {
                console.log(`[Guild Channels] User ${actor_user_id} authorized via mapped administrator role`);
            }
        }
        
        if (!authorized) {
            console.log(`[Guild Channels] User ${actor_user_id} in guild ${guild_id} denied - no admin permission or role`);
            return Errors.notAuthorized(reply);
        }

        // Get current mapping for audit diff
        const previousMapping = await getGuildChannels(guild_id);

        // Ensure guild exists
        await ensureGuildExists(guild_id);

        // Ensure actor exists in member table before audit logging
        // This prevents foreign key constraint violations
        await ensureMemberExists(actor_user_id);

        const warnings: string[] = [];
        const updates: Record<string, string | null> = {};

        // Process each provided channel
        for (const [channelKey, discordChannelId] of Object.entries(channels)) {
            // Validate channel_key exists in catalog
            const validKey = CHANNEL_KEYS.includes(channelKey as any);
            if (!validKey) {
                warnings.push(`Unknown channel key: ${channelKey}`);
                continue;
            }

            updates[channelKey] = discordChannelId;

            if (discordChannelId === null) {
                // Delete mapping
                await query(
                    `DELETE FROM guild_channel 
                     WHERE guild_id = $1::bigint AND channel_key = $2`,
                    [guild_id, channelKey]
                );
            } else {
                // Upsert mapping
                await query(
                    `INSERT INTO guild_channel (guild_id, channel_key, discord_channel_id, updated_at)
                     VALUES ($1::bigint, $2, $3::bigint, NOW())
                     ON CONFLICT (guild_id, channel_key)
                     DO UPDATE SET discord_channel_id = EXCLUDED.discord_channel_id, updated_at = NOW()`,
                    [guild_id, channelKey, discordChannelId]
                );
            }
        }

        // Get updated mapping
        const currentMapping = await getGuildChannels(guild_id);

        // Log audit event with diff
        await logAudit(guild_id, actor_user_id, 'guild.channels.set', guild_id, {
            previous: previousMapping,
            current: currentMapping,
            updates,
        });

        const response: any = { channels: currentMapping };
        if (warnings.length > 0) {
            response.warnings = warnings;
        }

        return reply.send(response);
    });
}

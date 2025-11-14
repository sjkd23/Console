import type { GuildMember } from 'discord.js';
import { getJSON } from '../utilities/http.js';

/**
 * Internal role keys (must match backend role_catalog)
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
 * Roles that can be added via /addrole command
 * Excludes verified_raider (requires verification) and suspended (punishment only)
 */
const ADDABLE_ROLES: RoleKey[] = [
    'organizer',
    'security',
    'officer',
    'head_organizer',
    'moderator',
    'administrator',
];

/**
 * Cache for guild role mappings
 * Map<guild_id, { mapping: Record<role_key, discord_role_id>, expires: number }>
 */
const roleCache = new Map<string, { mapping: Record<string, string | null>; expires: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Fetch guild role mappings from backend (with caching)
 */
async function getGuildRoleMapping(guildId: string): Promise<Record<string, string | null>> {
    const now = Date.now();
    const cached = roleCache.get(guildId);

    if (cached && cached.expires > now) {
        return cached.mapping;
    }

    try {
        const { roles } = await getJSON<{ roles: Record<string, string | null> }>(
            `/guilds/${guildId}/roles`
        );
        roleCache.set(guildId, { mapping: roles, expires: now + CACHE_TTL_MS });
        return roles;
    } catch (err) {
        console.error(`Failed to fetch role mapping for guild ${guildId}:`, err);
        return {};
    }
}

/**
 * Invalidate cached role mapping for a guild (call after updating roles)
 */
export function invalidateRoleCache(guildId: string): void {
    roleCache.delete(guildId);
}

/**
 * Check if a member has an internal role in their guild.
 * Returns true if:
 * - Member has Discord Administrator permission (short-circuit), OR
 * - Member has a Discord role that's mapped to the internal role
 */
export async function hasInternalRole(
    member: GuildMember | null,
    roleKey: RoleKey
): Promise<boolean> {
    if (!member) return false;

    // Short-circuit: Discord Administrator permission grants all roles
    if (member.permissions.has('Administrator')) {
        return true;
    }

    // Fetch guild's role mapping
    const mapping = await getGuildRoleMapping(member.guild.id);
    const discordRoleId = mapping[roleKey];

    if (!discordRoleId) {
        return false; // No mapping configured
    }

    // Check if member has the mapped Discord role
    return member.roles.cache.has(discordRoleId);
}

/**
 * Get all Discord role IDs for a member (for passing to backend)
 */
export function getMemberRoleIds(member: GuildMember | null): string[] {
    if (!member) return [];
    return Array.from(member.roles.cache.keys());
}

/**
 * Get the highest internal role a member has.
 * Returns the role with the highest hierarchy index, or null if none.
 */
export async function getHighestInternalRole(member: GuildMember | null): Promise<RoleKey | null> {
    if (!member) return null;

    // Administrator permission grants highest role
    if (member.permissions.has('Administrator')) {
        return 'administrator';
    }

    const mapping = await getGuildRoleMapping(member.guild.id);
    let highestRole: RoleKey | null = null;
    let highestIndex = -1;

    for (const roleKey of ROLE_HIERARCHY) {
        const discordRoleId = mapping[roleKey];
        if (discordRoleId && member.roles.cache.has(discordRoleId)) {
            const index = ROLE_HIERARCHY.indexOf(roleKey);
            if (index > highestIndex) {
                highestIndex = index;
                highestRole = roleKey;
            }
        }
    }

    return highestRole;
}

/**
 * Check if actor has a higher role than target in the role hierarchy.
 * Returns true if actor outranks target, false otherwise.
 * If actor has Administrator permission, they always outrank.
 * If target has Administrator permission (and actor doesn't), actor never outranks.
 */
export async function hasHigherRole(
    actor: GuildMember | null,
    target: GuildMember | null
): Promise<boolean> {
    if (!actor || !target) return false;

    // If same person, deny
    if (actor.id === target.id) return false;

    // Actor with Administrator permission always outranks non-admins
    const actorIsAdmin = actor.permissions.has('Administrator');
    const targetIsAdmin = target.permissions.has('Administrator');

    if (actorIsAdmin && !targetIsAdmin) return true;
    if (targetIsAdmin) return false; // Target is admin, so actor can't outrank

    // Compare internal roles
    const actorRole = await getHighestInternalRole(actor);
    const targetRole = await getHighestInternalRole(target);

    if (!actorRole) return false; // Actor has no internal role
    if (!targetRole) return true; // Target has no internal role, actor does

    const actorIndex = ROLE_HIERARCHY.indexOf(actorRole);
    const targetIndex = ROLE_HIERARCHY.indexOf(targetRole);

    return actorIndex > targetIndex;
}

/**
 * Check if the bot can manage a target member's roles.
 * Returns true if the bot's highest role is higher than the target's highest role.
 * This prevents 403 errors when attempting role mutations.
 */
export async function canBotManageMember(
    guild: any,
    targetMember: GuildMember | null
): Promise<{ canManage: boolean; reason?: string }> {
    if (!targetMember) {
        return { canManage: false, reason: 'Target member not found' };
    }

    try {
        const botMember = await guild.members.fetchMe();
        
        // Check Discord role hierarchy
        if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
            return {
                canManage: false,
                reason: 'Target member has a higher or equal role than the bot in the Discord role hierarchy. The bot cannot manage members with higher roles. Ask a server admin to adjust role positions.'
            };
        }

        // Check if bot has Manage Roles permission
        if (!botMember.permissions.has('ManageRoles')) {
            return {
                canManage: false,
                reason: 'Bot lacks "Manage Roles" permission. Ask a server admin to grant this permission.'
            };
        }

        return { canManage: true };
    } catch (err) {
        console.error('[Permissions] Failed to check bot role position:', err);
        return {
            canManage: false,
            reason: 'Failed to verify bot permissions. Please try again.'
        };
    }
}

/**
 * Check if a specific Discord role can be managed by the bot.
 * Returns true if the role exists and is lower than the bot's highest role.
 */
export async function canBotManageRole(
    guild: any,
    roleId: string
): Promise<{ canManage: boolean; reason?: string }> {
    try {
        const botMember = await guild.members.fetchMe();
        const role = await guild.roles.fetch(roleId);

        if (!role) {
            return {
                canManage: false,
                reason: `Role <@&${roleId}> not found in this server.`
            };
        }

        if (role.position >= botMember.roles.highest.position) {
            return {
                canManage: false,
                reason: `Role <@&${roleId}> is higher than or equal to the bot's highest role. Ask a server admin to move the bot's role above this role.`
            };
        }

        return { canManage: true };
    } catch (err) {
        console.error('[Permissions] Failed to check bot can manage role:', err);
        return {
            canManage: false,
            reason: 'Failed to verify role permissions. Please try again.'
        };
    }
}

/**
 * Check if actor has permission to target another member based on role hierarchy.
 * Returns detailed result with reason if denied.
 */
export async function canActorTargetMember(
    actor: GuildMember | null,
    target: GuildMember | null,
    options: {
        allowSelf?: boolean;
        checkBotPosition?: boolean;
    } = {}
): Promise<{ canTarget: boolean; reason?: string }> {
    if (!actor || !target) {
        return { canTarget: false, reason: 'Actor or target member not found' };
    }

    // Check if same person
    if (actor.id === target.id) {
        if (options.allowSelf) {
            return { canTarget: true };
        }
        return { canTarget: false, reason: 'You cannot target yourself.' };
    }

    // Check bot position first if requested (to fail fast with clear message)
    if (options.checkBotPosition) {
        const botCheck = await canBotManageMember(actor.guild, target);
        if (!botCheck.canManage) {
            return { canTarget: false, reason: `❌ **Cannot Modify Member**\n\n${botCheck.reason}` };
        }
    }

    // Check internal role hierarchy
    const actorOutranks = await hasHigherRole(actor, target);
    if (!actorOutranks) {
        return {
            canTarget: false,
            reason: '❌ **Access Denied**\n\nYou cannot target someone with an equal or higher role than you.\n\nThis prevents abuse of moderation permissions in the role hierarchy.'
        };
    }

    return { canTarget: true };
}

// ===== LEGACY HELPERS (for backward compatibility) =====

/** Organizer if:
 *  - has role ORGANIZER_ROLE_ID (if set)
 *  - OR matches the organizer mention in the embed description: "Organizer: <@123...>"
 */
export function isOrganizer(member: GuildMember | null, organizerIdInEmbed?: string): boolean {
    if (!member) return false;

    const roleId = process.env.ORGANIZER_ROLE_ID;
    if (roleId && member.roles.cache.has(roleId)) return true;

    if (organizerIdInEmbed && member.id === organizerIdInEmbed) return true;

    return false;
}

/** Security if:
 *  - has role SECURITY_ROLE_ID (if set)
 */
export function isSecurity(member: GuildMember | null): boolean {
    if (!member) return false;

    const roleId = process.env.SECURITY_ROLE_ID;
    if (roleId && member.roles.cache.has(roleId)) return true;

    return false;
}

/** Extracts the first <@123...> mention id from a string. */
export function extractFirstUserMentionId(text?: string | null): string | undefined {
    if (!text) return;
    const m = text.match(/<@(\d{5,})>/);
    return m?.[1];
}

// ===== ROLE ADDITION HELPERS =====

/**
 * Get all roles that an actor is allowed to add via /addrole
 * Actor can add any role strictly below their highest role in the hierarchy
 */
export async function getRolesActorCanAdd(actor: GuildMember): Promise<RoleKey[]> {
    // Find actor's highest role in hierarchy
    let actorHighestIndex = -1;
    for (let i = ROLE_HIERARCHY.length - 1; i >= 0; i--) {
        if (await hasInternalRole(actor, ROLE_HIERARCHY[i])) {
            actorHighestIndex = i;
            break;
        }
    }

    if (actorHighestIndex === -1) {
        return []; // Actor has no internal roles
    }

    // Return all addable roles strictly below actor's highest role
    return ADDABLE_ROLES.filter(role => {
        const roleIndex = ROLE_HIERARCHY.indexOf(role);
        return roleIndex < actorHighestIndex;
    });
}

/**
 * Check if actor can add a specific role to another member
 * Requirements:
 * - Role must be in ADDABLE_ROLES list
 * - Role must be strictly below actor's highest role in hierarchy
 */
export async function canActorAddRole(actor: GuildMember, roleToAdd: RoleKey): Promise<boolean> {
    // Check if role is addable at all
    if (!ADDABLE_ROLES.includes(roleToAdd)) {
        return false;
    }

    // Check if actor outranks the role they're trying to add
    const rolesActorCanAdd = await getRolesActorCanAdd(actor);
    return rolesActorCanAdd.includes(roleToAdd);
}


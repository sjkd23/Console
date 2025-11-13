// bot/src/lib/team-role-manager.ts
import { GuildMember, Client } from 'discord.js';
import { getGuildRoles } from './http.js';
import { createLogger } from './logger.js';

const logger = createLogger('TeamRoleManager');

/**
 * Staff roles that qualify a member for the Team role
 */
const STAFF_ROLE_KEYS = [
    'administrator',
    'moderator',
    'head_organizer',
    'officer',
    'security',
    'organizer',
] as const;

/**
 * Check if a member has any staff roles and should have the Team role
 */
async function shouldHaveTeamRole(member: GuildMember): Promise<boolean> {
    try {
        // Fetch the guild's role mappings from backend
        const { roles: roleMap } = await getGuildRoles(member.guild.id);
        
        // Get the member's Discord role IDs
        const memberRoleIds = member.roles.cache.map(r => r.id);
        
        // Check if member has any staff role
        for (const staffRoleKey of STAFF_ROLE_KEYS) {
            const staffDiscordRoleId = roleMap[staffRoleKey];
            if (staffDiscordRoleId && memberRoleIds.includes(staffDiscordRoleId)) {
                return true;
            }
        }
        
        return false;
    } catch (error) {
        logger.error('Error checking staff roles for member', { 
            guildId: member.guild.id, 
            userId: member.id, 
            userTag: member.user.tag, 
            error 
        });
        return false;
    }
}

/**
 * Sync the Team role for a specific member based on their current roles
 */
export async function syncTeamRoleForMember(member: GuildMember): Promise<void> {
    try {
        // Fetch the guild's role mappings
        const { roles: roleMap } = await getGuildRoles(member.guild.id);
        const teamRoleId = roleMap.team;
        
        // If team role is not configured, skip
        if (!teamRoleId) {
            return;
        }
        
        // Get the Team role object
        const teamRole = member.guild.roles.cache.get(teamRoleId);
        if (!teamRole) {
            logger.error('Team role not found in guild', { 
                guildId: member.guild.id, 
                teamRoleId 
            });
            return;
        }
        
        // Check if member should have team role
        const shouldHave = await shouldHaveTeamRole(member);
        const currentlyHas = member.roles.cache.has(teamRoleId);
        
        // Add team role if they should have it but don't
        if (shouldHave && !currentlyHas) {
            await member.roles.add(teamRole, 'Auto-assigned: Member has staff role');
            logger.info('Added Team role to member', { 
                guildId: member.guild.id, 
                guildName: member.guild.name, 
                userId: member.id, 
                userTag: member.user.tag 
            });
        }
        // Remove team role if they shouldn't have it but do
        else if (!shouldHave && currentlyHas) {
            await member.roles.remove(teamRole, 'Auto-removed: Member has no staff roles');
            logger.info('Removed Team role from member', { 
                guildId: member.guild.id, 
                guildName: member.guild.name, 
                userId: member.id, 
                userTag: member.user.tag 
            });
        }
    } catch (error) {
        logger.error('Error syncing team role for member', { 
            guildId: member.guild.id, 
            userId: member.id, 
            userTag: member.user.tag, 
            error 
        });
    }
}

/**
 * Sync Team role for all members in a guild (useful for initial setup or after config change)
 */
export async function syncTeamRoleForGuild(guildId: string, client: Client): Promise<void> {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            logger.error('Guild not found', { guildId });
            return;
        }
        
        logger.info('Starting Team role sync for guild', { guildId, guildName: guild.name });
        
        // Fetch all members
        await guild.members.fetch();
        
        // Sync each member
        let syncCount = 0;
        for (const [, member] of guild.members.cache) {
            await syncTeamRoleForMember(member);
            syncCount++;
        }
        
        logger.info('Completed Team role sync for guild', { guildId, guildName: guild.name, syncCount });
    } catch (error) {
        logger.error('Error syncing team role for guild', { guildId, error });
    }
}

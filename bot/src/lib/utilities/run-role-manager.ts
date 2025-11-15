import { Guild, Role, GuildMember } from 'discord.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('RunRoleManager');

/**
 * Creates a temporary role for a run at the bottom of the role list.
 * The role is named "<organizer>'s <dungeon>".
 * 
 * @param guild - The Discord guild
 * @param organizerUsername - The organizer's username
 * @param dungeonName - The dungeon name
 * @returns The created role, or null if creation failed
 */
export async function createRunRole(
    guild: Guild,
    organizerUsername: string,
    dungeonName: string
): Promise<Role | null> {
    try {
        const roleName = `${organizerUsername}'s ${dungeonName}`;
        
        // Create role at the bottom of the role list (position 1)
        const role = await guild.roles.create({
            name: roleName,
            color: 0x808080, // Gray color
            mentionable: false,
            hoist: false,
            position: 1, // Bottom of the list
            reason: `Temporary role for raid run: ${dungeonName}`
        });

        logger.info('Created run role', { 
            guildId: guild.id, 
            roleId: role.id, 
            roleName 
        });

        return role;
    } catch (error) {
        logger.error('Failed to create run role', { 
            guildId: guild.id, 
            organizerUsername, 
            dungeonName, 
            error 
        });
        return null;
    }
}

/**
 * Assigns a run role to a guild member.
 * 
 * @param member - The guild member
 * @param roleId - The role ID to assign
 * @returns True if successful, false otherwise
 */
export async function assignRunRole(
    member: GuildMember,
    roleId: string
): Promise<boolean> {
    try {
        await member.roles.add(roleId, 'Joined raid run');
        
        logger.debug('Assigned run role to member', { 
            guildId: member.guild.id, 
            userId: member.id, 
            roleId 
        });

        return true;
    } catch (error) {
        logger.error('Failed to assign run role', { 
            guildId: member.guild.id, 
            userId: member.id, 
            roleId, 
            error 
        });
        return false;
    }
}

/**
 * Removes a run role from a guild member.
 * 
 * @param member - The guild member
 * @param roleId - The role ID to remove
 * @returns True if successful, false otherwise
 */
export async function removeRunRole(
    member: GuildMember,
    roleId: string
): Promise<boolean> {
    try {
        await member.roles.remove(roleId, 'Left raid run');
        
        logger.debug('Removed run role from member', { 
            guildId: member.guild.id, 
            userId: member.id, 
            roleId 
        });

        return true;
    } catch (error) {
        logger.error('Failed to remove run role', { 
            guildId: member.guild.id, 
            userId: member.id, 
            roleId, 
            error 
        });
        return false;
    }
}

/**
 * Deletes a run role from the guild.
 * 
 * @param guild - The Discord guild
 * @param roleId - The role ID to delete
 * @returns True if successful, false otherwise
 */
export async function deleteRunRole(
    guild: Guild,
    roleId: string
): Promise<boolean> {
    try {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        
        if (!role) {
            logger.warn('Run role not found, may have been already deleted', { 
                guildId: guild.id, 
                roleId 
            });
            return true; // Consider this a success as the role is already gone
        }

        await role.delete('Raid run ended');
        
        logger.info('Deleted run role', { 
            guildId: guild.id, 
            roleId 
        });

        return true;
    } catch (error) {
        logger.error('Failed to delete run role', { 
            guildId: guild.id, 
            roleId, 
            error 
        });
        return false;
    }
}

/**
 * Gets all members who have a specific run role.
 * 
 * @param guild - The Discord guild
 * @param roleId - The role ID
 * @returns Array of guild members with the role
 */
export async function getMembersWithRunRole(
    guild: Guild,
    roleId: string
): Promise<GuildMember[]> {
    try {
        const role = await guild.roles.fetch(roleId).catch(() => null);
        
        if (!role) {
            logger.warn('Run role not found when fetching members', { 
                guildId: guild.id, 
                roleId 
            });
            return [];
        }

        return Array.from(role.members.values());
    } catch (error) {
        logger.error('Failed to get members with run role', { 
            guildId: guild.id, 
            roleId, 
            error 
        });
        return [];
    }
}

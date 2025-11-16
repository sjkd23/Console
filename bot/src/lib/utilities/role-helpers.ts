import {
    ChatInputCommandInteraction,
    Guild,
    User,
    EmbedBuilder,
    TextChannel,
    time,
    TimestampStyles,
} from 'discord.js';
import { getGuildRoles, getGuildChannels } from './http.js';
import { canBotManageRole } from '../permissions/permissions.js';

/**
 * Role configuration check result
 */
export interface RoleCheckResult {
    roleId: string | null;
    exists: boolean;
    canManage: boolean;
    error?: string;
}

/**
 * Checks if a required role is configured and accessible by the bot.
 * Automatically sends appropriate error messages.
 * 
 * @param interaction - Discord interaction
 * @param roleType - Type of role to check ('suspended', 'muted', 'verified_raider', etc.)
 * @param roleDisplayName - Display name for error messages
 * @returns Role ID if valid, null if invalid (error sent)
 * 
 * @example
 * const roleId = await checkRequiredRoleOrReply(interaction, 'suspended', 'Suspended');
 * if (!roleId) return;
 */
export async function checkRequiredRoleOrReply(
    interaction: ChatInputCommandInteraction,
    roleType: string,
    roleDisplayName: string
): Promise<string | null> {
    if (!interaction.guild || !interaction.guildId) return null;
    
    try {
        const { roles } = await getGuildRoles(interaction.guildId);
        const roleId = (roles as any)[roleType];
        
        if (!roleId) {
            await interaction.editReply(
                `❌ **${roleDisplayName} Role Not Configured**\n\n` +
                `The ${roleDisplayName.toLowerCase()} role has not been set up for this server.\n\n` +
                `**What to do:**\n` +
                `• Ask a server admin to use \`/setroles\` to configure the \`${roleType}\` role\n` +
                `• This role will be automatically assigned to ${roleDisplayName.toLowerCase()} members`
            );
            return null;
        }
        
        // Check if the role exists in Discord
        const roleExists = await interaction.guild.roles.fetch(roleId);
        if (!roleExists) {
            await interaction.editReply(
                `❌ **${roleDisplayName} Role Not Found**\n\n` +
                `The configured ${roleDisplayName.toLowerCase()} role (<@&${roleId}>) no longer exists in this server.\n\n` +
                `**What to do:**\n` +
                `• Ask a server admin to use \`/setroles\` to update the ${roleType} role`
            );
            return null;
        }
        
        // Check if bot can manage this role
        const botRoleCheck = await canBotManageRole(interaction.guild, roleId);
        if (!botRoleCheck.canManage) {
            await interaction.editReply(
                `❌ **Cannot Manage Role**\n\n${botRoleCheck.reason}`
            );
            return null;
        }
        
        return roleId;
    } catch (err) {
        console.error(`[RoleCheck] Failed to check ${roleType} role:`, err);
        await interaction.editReply('❌ Failed to verify role configuration. Please try again.');
        return null;
    }
}

/**
 * Attempts to assign a role to a member with error handling.
 * 
 * @param member - Guild member to assign role to
 * @param roleId - Role ID to assign
 * @param reason - Reason for audit log
 * @returns Success result with error details if failed
 */
export async function tryAssignRole(
    member: any,
    roleId: string,
    reason: string
): Promise<{ success: boolean; error?: string }> {
    try {
        await member.roles.add(roleId, reason);
        return { success: true };
    } catch (err: any) {
        if (err?.code === 50013) {
            return { success: false, error: 'Missing permissions to assign role' };
        } else if (err?.code === 50013) {
            // User already has the role
            return { success: true };
        } else {
            return { success: false, error: 'Failed to assign role' };
        }
    }
}

/**
 * Attempts to remove a role from a member with error handling.
 * 
 * @param member - Guild member to remove role from
 * @param roleId - Role ID to remove
 * @param reason - Reason for audit log
 * @returns Success result with error details if failed
 */
export async function tryRemoveRole(
    member: any,
    roleId: string,
    reason: string
): Promise<{ success: boolean; error?: string }> {
    try {
        await member.roles.remove(roleId, reason);
        return { success: true };
    } catch (err: any) {
        if (err?.code === 50013) {
            return { success: false, error: 'Missing permissions to remove role' };
        } else {
            return { success: false, error: 'Failed to remove role' };
        }
    }
}

/**
 * Attempts to send a DM to a user with error handling.
 * 
 * @param user - User to send DM to
 * @param embed - Embed to send
 * @returns Whether DM was sent successfully
 */
export async function trySendDM(
    user: User,
    embed: EmbedBuilder
): Promise<boolean> {
    try {
        await user.send({ embeds: [embed] });
        return true;
    } catch (err) {
        console.warn(`[DM] Failed to DM user ${user.id}:`, err);
        return false;
    }
}

/**
 * Logs a moderation action to the punishment log channel if configured.
 * 
 * @param interaction - Discord interaction
 * @param embed - Embed to log
 * @returns Whether logging was successful
 */
export async function logToPunishmentChannel(
    interaction: ChatInputCommandInteraction,
    embed: EmbedBuilder
): Promise<boolean> {
    if (!interaction.guild || !interaction.guildId) return false;
    
    try {
        const { channels } = await getGuildChannels(interaction.guildId);
        const punishmentLogChannelId = channels.punishment_log;
        
        if (!punishmentLogChannelId) return false;
        
        const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);
        
        if (logChannel && logChannel.isTextBased()) {
            await (logChannel as TextChannel).send({ embeds: [embed] });
            return true;
        }
        
        return false;
    } catch (err) {
        console.warn(`[PunishmentLog] Failed to log to punishment_log channel:`, err);
        return false;
    }
}

/**
 * Creates a punishment DM embed with standard formatting.
 * 
 * @param options - Embed options
 * @returns Formatted embed
 */
export function createPunishmentDMEmbed(options: {
    guildName: string;
    title: string;
    description: string;
    reason: string;
    moderator: User;
    punishmentId: string;
    expiresAt?: Date;
    duration?: string;
    additionalFields?: Array<{ name: string; value: string; inline?: boolean }>;
}): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(options.title)
        .setDescription(options.description)
        .setColor(0xff6600)
        .addFields({ name: 'Reason', value: options.reason });
    
    if (options.duration && options.expiresAt) {
        embed.addFields(
            { name: 'Duration', value: options.duration, inline: true },
            { name: 'Expires', value: time(options.expiresAt, TimestampStyles.RelativeTime), inline: true }
        );
    }
    
    if (options.additionalFields) {
        embed.addFields(...options.additionalFields);
    }
    
    embed.addFields(
        { name: 'Issued By', value: `<@${options.moderator.id}>`, inline: true },
        { name: 'Punishment ID', value: `\`${options.punishmentId}\``, inline: true },
        { name: 'Date', value: time(new Date(), TimestampStyles.LongDateTime) }
    );
    
    embed.setTimestamp();
    
    return embed;
}

/**
 * Creates a punishment log embed with standard formatting.
 * 
 * @param options - Embed options
 * @returns Formatted embed
 */
export function createPunishmentLogEmbed(options: {
    title: string;
    targetUser: User;
    moderator: User;
    punishmentId: string;
    reason: string;
    expiresAt?: Date;
    duration?: string;
    roleAssigned?: boolean;
    roleError?: string;
    dmSent?: boolean;
    additionalFields?: Array<{ name: string; value: string; inline?: boolean }>;
}): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(options.title)
        .setColor(0xff6600)
        .addFields(
            { name: 'Member', value: `<@${options.targetUser.id}> (${options.targetUser.tag})`, inline: true },
            { name: 'User ID', value: options.targetUser.id, inline: true },
            { name: 'Punishment ID', value: `\`${options.punishmentId}\``, inline: true }
        );
    
    if (options.duration && options.expiresAt) {
        embed.addFields(
            { name: 'Duration', value: options.duration, inline: true },
            { name: 'Expires', value: time(options.expiresAt, TimestampStyles.LongDateTime), inline: true }
        );
    }
    
    if (options.additionalFields) {
        embed.addFields(...options.additionalFields);
    }
    
    const roleStatus = options.roleAssigned !== undefined
        ? (options.roleAssigned ? '✅ Yes' : `❌ No (${options.roleError})`)
        : undefined;
    
    const dmStatus = options.dmSent !== undefined
        ? (options.dmSent ? '✅ Yes' : '❌ No')
        : undefined;
    
    embed.addFields(
        { name: 'Moderator', value: `<@${options.moderator.id}> (${options.moderator.tag})`, inline: true }
    );
    
    if (roleStatus) {
        embed.addFields({ name: 'Role Assigned', value: roleStatus, inline: true });
    }
    
    if (dmStatus) {
        embed.addFields({ name: 'DM Sent', value: dmStatus, inline: true });
    }
    
    embed.addFields({ name: 'Reason', value: options.reason });
    embed.setTimestamp();
    
    return embed;
}

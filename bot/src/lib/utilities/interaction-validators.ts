import { ChatInputCommandInteraction, MessageFlags, User, GuildMember } from 'discord.js';

/**
 * Result type for validation functions
 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that an interaction is in a guild (not in DMs).
 * Automatically sends error response if not in guild.
 * 
 * @param interaction - Discord interaction
 * @returns True if in guild, false if not (error sent)
 * 
 * @example
 * if (!await requireGuild(interaction)) return;
 */
export async function requireGuild(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild || !interaction.guildId) {
        await interaction.reply({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    return true;
}

/**
 * Validates that the target user is not the command invoker.
 * Automatically sends error response if self-targeting.
 * 
 * @param interaction - Discord interaction
 * @param targetUser - Target user
 * @param actionName - Name of action for error message (e.g., 'mute', 'suspend', 'warn')
 * @returns True if not self-targeting, false if self-targeting (error sent)
 * 
 * @example
 * if (!await preventSelfTarget(interaction, targetUser, 'mute')) return;
 */
export async function preventSelfTarget(
    interaction: ChatInputCommandInteraction,
    targetUser: User,
    actionName: string
): Promise<boolean> {
    if (targetUser.id === interaction.user.id) {
        await interaction.editReply(`❌ You cannot ${actionName} yourself.`);
        return false;
    }
    return true;
}

/**
 * Validates that the target user is not a bot.
 * Automatically sends error response if targeting bot.
 * 
 * @param interaction - Discord interaction
 * @param targetUser - Target user
 * @param actionName - Name of action for error message
 * @returns True if not a bot, false if bot (error sent)
 * 
 * @example
 * if (!await preventBotTarget(interaction, targetUser, 'warn')) return;
 */
export async function preventBotTarget(
    interaction: ChatInputCommandInteraction,
    targetUser: User,
    actionName: string
): Promise<boolean> {
    if (targetUser.bot) {
        await interaction.editReply(`❌ You cannot ${actionName} bots.`);
        return false;
    }
    return true;
}

/**
 * Fetches a guild member with automatic error handling.
 * Automatically sends error response if member not found.
 * 
 * @param interaction - Discord interaction
 * @param userId - User ID to fetch
 * @returns GuildMember if found, null if not found (error sent)
 * 
 * @example
 * const member = await fetchMemberOrReply(interaction, userId);
 * if (!member) return;
 */
export async function fetchMemberOrReply(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<GuildMember | null> {
    if (!interaction.guild) return null;
    
    try {
        return await interaction.guild.members.fetch(userId);
    } catch {
        await interaction.editReply(`❌ <@${userId}> is not a member of this server.`);
        return null;
    }
}

/**
 * Validates interaction is in guild and defers the reply.
 * Combines two common operations.
 * 
 * @param interaction - Discord interaction
 * @param ephemeral - Whether to defer ephemerally
 * @returns True if successful, false if not in guild
 * 
 * @example
 * if (!await requireGuildAndDefer(interaction)) return;
 */
export async function requireGuildAndDefer(
    interaction: ChatInputCommandInteraction,
    ephemeral = false
): Promise<boolean> {
    if (!await requireGuild(interaction)) return false;
    await interaction.deferReply({ ephemeral });
    return true;
}

/**
 * Performs common moderation command validations:
 * - Requires guild
 * - Prevents self-targeting
 * - Prevents bot targeting
 * - Fetches target member
 * 
 * @param interaction - Discord interaction
 * @param targetUser - Target user
 * @param actionName - Name of action for error messages
 * @returns Target GuildMember if all validations pass, null otherwise (error sent)
 * 
 * @example
 * const targetMember = await validateModerationTarget(interaction, targetUser, 'mute');
 * if (!targetMember) return;
 */
export async function validateModerationTarget(
    interaction: ChatInputCommandInteraction,
    targetUser: User,
    actionName: string
): Promise<GuildMember | null> {
    if (!await requireGuild(interaction)) return null;
    if (!await preventSelfTarget(interaction, targetUser, actionName)) return null;
    if (!await preventBotTarget(interaction, targetUser, actionName)) return null;
    
    return await fetchMemberOrReply(interaction, targetUser.id);
}

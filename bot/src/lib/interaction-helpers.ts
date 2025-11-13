/**
 * Common helpers for Discord.js interactions to reduce code duplication.
 */

import {
    ChatInputCommandInteraction,
    GuildMember,
    MessageFlags,
    Guild,
} from 'discord.js';

/**
 * Ensures the interaction is in a guild context.
 * Replies with an error message if not in a guild and returns null.
 * @param interaction - The chat interaction
 * @returns Guild if valid, null otherwise
 */
export async function ensureGuildContext(
    interaction: ChatInputCommandInteraction
): Promise<Guild | null> {
    if (!interaction.guild || !interaction.guildId) {
        await interaction.reply({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }
    return interaction.guild;
}

/**
 * Fetches a guild member with error handling.
 * @param guild - The guild to fetch from
 * @param userId - The user ID to fetch
 * @returns The guild member if found, null otherwise
 */
export async function fetchGuildMember(
    guild: Guild,
    userId: string
): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

/**
 * Validates that a user is a member of the guild.
 * Replies with an error if the user is not found.
 * @param interaction - The chat interaction
 * @param guild - The guild to check
 * @param userId - The user ID to validate
 * @param userMention - Optional user mention for error message
 * @returns The guild member if valid, null otherwise
 */
export async function validateGuildMember(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
    userId: string,
    userMention?: string
): Promise<GuildMember | null> {
    const member = await fetchGuildMember(guild, userId);
    
    if (!member) {
        await interaction.reply({
            content: `❌ ${userMention || `<@${userId}>`} is not a member of this server.`,
            flags: MessageFlags.Ephemeral,
        });
        return null;
    }
    
    return member;
}

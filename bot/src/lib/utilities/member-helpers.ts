/**
 * Member fetching helpers to reduce code duplication across bot commands
 */

import {
    Guild,
    GuildMember,
    ChatInputCommandInteraction,
    MessageFlags
} from 'discord.js';

/**
 * Safely fetches a guild member with error handling
 * @param guild - The guild to fetch from
 * @param userId - The user ID to fetch
 * @returns The guild member if found, null otherwise
 */
export async function fetchMember(
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
 * Fetches a guild member or replies with an error message
 * @param guild - The guild to fetch from
 * @param userId - The user ID to fetch
 * @param interaction - The interaction to reply to if member not found
 * @param errorMessage - Custom error message (default: "Could not fetch your member information.")
 * @returns The guild member if found, null otherwise (with error reply sent)
 */
export async function fetchMemberOrReply(
    guild: Guild,
    userId: string,
    interaction: ChatInputCommandInteraction,
    errorMessage: string = 'Could not fetch your member information.'
): Promise<GuildMember | null> {
    const member = await fetchMember(guild, userId);
    
    if (!member) {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(`❌ ${errorMessage}`);
        } else {
            await interaction.reply({
                content: `❌ ${errorMessage}`,
                flags: MessageFlags.Ephemeral
            });
        }
        return null;
    }
    
    return member;
}

/**
 * Fetches the interaction invoker's guild member with error handling
 * Convenience wrapper for the common pattern of fetching interaction.user
 * @param interaction - The interaction containing the guild and user
 * @returns The guild member if found, null otherwise (with error reply sent)
 */
export async function fetchInvokerMember(
    interaction: ChatInputCommandInteraction
): Promise<GuildMember | null> {
    if (!interaction.guild) {
        return null;
    }
    
    return fetchMemberOrReply(
        interaction.guild,
        interaction.user.id,
        interaction,
        'Could not fetch your member record. Try again in a moment.'
    );
}

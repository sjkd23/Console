/**
 * Channel fetching helpers to reduce code duplication across organizer commands
 */

import {
    Guild,
    GuildTextBasedChannel,
    ChatInputCommandInteraction,
    MessageFlags
} from 'discord.js';
import { getGuildChannels } from './http.js';

/**
 * Fetches the configured raid channel for a guild with comprehensive error handling
 * @param guild - The guild to fetch the raid channel for
 * @param interaction - The interaction to reply to if errors occur
 * @returns The raid channel if found and valid, null otherwise (with error reply sent)
 */
export async function fetchConfiguredRaidChannel(
    guild: Guild,
    interaction: ChatInputCommandInteraction
): Promise<GuildTextBasedChannel | null> {
    // Get the configured raid channel
    const { channels } = await getGuildChannels(guild.id);
    const raidChannelId = channels.raid;

    if (!raidChannelId) {
        await interaction.editReply(
            '**Error:** No raid channel is configured. Ask an admin to set one up with `/setchannels`.'
        );
        return null;
    }

    // Fetch the raid channel
    try {
        const fetchedChannel = await interaction.client.channels.fetch(raidChannelId);
        if (!fetchedChannel || !fetchedChannel.isTextBased() || fetchedChannel.isDMBased()) {
            await interaction.editReply(
                '**Error:** The raid channel is invalid or inaccessible. Ask an admin to reconfigure it with `/setchannels`.'
            );
            return null;
        }
        return fetchedChannel as GuildTextBasedChannel;
    } catch (err) {
        console.error('Failed to fetch raid channel:', err);
        await interaction.editReply(
            '**Error:** Can\'t access the raid channel. It may have been deleted. Ask an admin to reconfigure it with `/setchannels`.'
        );
        return null;
    }
}

/**
 * Fetches a configured channel by key with error handling
 * @param guild - The guild to fetch the channel for
 * @param channelKey - The channel key to fetch (raid, veri_log, etc.)
 * @returns The channel if found and valid, null otherwise
 */
export async function fetchConfiguredChannel(
    guild: Guild,
    channelKey: string
): Promise<GuildTextBasedChannel | null> {
    try {
        const { channels } = await getGuildChannels(guild.id);
        const channelId = channels[channelKey];

        if (!channelId) {
            return null;
        }

        const fetchedChannel = await guild.client.channels.fetch(channelId);
        if (!fetchedChannel || !fetchedChannel.isTextBased() || fetchedChannel.isDMBased()) {
            return null;
        }
        return fetchedChannel as GuildTextBasedChannel;
    } catch {
        return null;
    }
}

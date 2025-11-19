import { Client, Guild, type GuildTextBasedChannel } from 'discord.js';
import { getJSON, postJSON } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('O3Progression');

/**
 * Shared interface for O3 progression ping messages.
 * Follows DRY principles by extracting common logic.
 */
interface O3ProgressionOptions {
    /** The main message text (e.g., "Realm Closed", "Mini: Dammah") */
    messageText: string;
    /** The run ID */
    runId: number;
    /** The guild where the run is happening */
    guild: Guild;
    /** The Discord client */
    client: Client;
    /** Optional: Include party/location info in message */
    includePartyLocation?: boolean;
}

/**
 * Sends an O3 progression ping message, automatically deleting the previous one.
 * This is the shared implementation for Realm Closed, Miniboss, and Third Room pings.
 * 
 * @returns The new ping message ID, or null if failed
 */
export async function sendO3ProgressionPing(options: O3ProgressionOptions): Promise<string | null> {
    const { messageText, runId, guild, client, includePartyLocation = true } = options;

    try {
        // Fetch run details
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            dungeonLabel: string;
            dungeonKey: string;
            roleId: string | null;
            pingMessageId: string | null;
            party: string | null;
            location: string | null;
        }>(`/runs/${runId}`, { guildId: guild.id });

        if (!run.channelId || !run.postMessageId) {
            logger.warn('Run missing channel or message ID', { runId });
            return null;
        }

        // Fetch the channel
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            logger.warn('Channel not found or invalid', { runId, channelId: run.channelId });
            return null;
        }

        const textChannel = channel as GuildTextBasedChannel;

        // Delete the previous ping message if it exists
        if (run.pingMessageId) {
            try {
                const oldPingMessage = await textChannel.messages.fetch(run.pingMessageId).catch(() => null);
                if (oldPingMessage && oldPingMessage.deletable) {
                    await oldPingMessage.delete();
                    logger.debug('Deleted previous ping message', { runId, oldPingMessageId: run.pingMessageId });
                }
            } catch (err) {
                logger.warn('Failed to delete previous ping message', { runId, pingMessageId: run.pingMessageId, error: err });
                // Continue anyway - this shouldn't block sending a new ping
            }
        }

        // Build the ping message
        let content = `**${messageText}**`;

        // Add role mention if available
        if (run.roleId) {
            content += ` <@&${run.roleId}>`;
        }

        content += `\n\n**${run.dungeonLabel}**`;

        // Add party/location info if requested and available
        if (includePartyLocation) {
            const info: string[] = [];
            if (run.party) info.push(`Party: **${run.party}**`);
            if (run.location) info.push(`Location: **${run.location}**`);
            if (info.length > 0) {
                content += ` • ${info.join(' • ')}`;
            }
        }

        // Add link to the raid panel
        const raidPanelUrl = `https://discord.com/channels/${guild.id}/${run.channelId}/${run.postMessageId}`;
        content += `\n[Jump to Raid Panel](${raidPanelUrl})`;

        // Send the new ping message
        const pingMessage = await textChannel.send({ content });

        // Store the new ping message ID in the database
        await postJSON(`/runs/${runId}/ping-message`, {
            pingMessageId: pingMessage.id
        }, { guildId: guild.id });

        logger.info('Sent O3 progression ping', {
            runId,
            pingMessageId: pingMessage.id,
            messageText,
            dungeonLabel: run.dungeonLabel
        });

        return pingMessage.id;
    } catch (error) {
        logger.error('Failed to send O3 progression ping', { runId, messageText, error });
        return null;
    }
}

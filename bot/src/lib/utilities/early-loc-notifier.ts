// bot/src/lib/utilities/early-loc-notifier.ts
import { Client, ChannelType, EmbedBuilder } from 'discord.js';
import { createLogger } from '../logging/logger.js';
import { getJSON, getDungeonRolePings } from './http.js';

const logger = createLogger('EarlyLocNotifier');

interface EarlyLocNotificationData {
    shouldNotify: boolean;
    isInitialSet: boolean;
    party: string | null;
    location: string | null;
}

/**
 * Send an early-loc notification when party/location is set or changed.
 * Always sends a new message (never edits previous ones).
 * 
 * @param client - Discord client
 * @param guildId - Guild ID
 * @param organizerId - Organizer user ID
 * @param dungeonKey - Dungeon key (for role ping lookup)
 * @param dungeonLabel - Dungeon name (for display)
 * @param runChannelId - Channel ID where the run message is posted
 * @param runMessageId - Message ID of the run message
 * @param notificationData - Data about the notification (from backend)
 */
export async function sendEarlyLocNotification(
    client: Client,
    guildId: string,
    organizerId: string,
    dungeonKey: string,
    dungeonLabel: string,
    runChannelId: string | null,
    runMessageId: string | null,
    notificationData: EarlyLocNotificationData
): Promise<void> {
    if (!notificationData.shouldNotify) {
        logger.debug({ guildId }, 'No early-loc notification needed');
        return;
    }

    try {
        // Fetch the guild's configured early_loc channel
        const response = await getJSON<{ channels: Record<string, string | null> }>(
            `/guilds/${guildId}/channels`
        );

        const earlyLocChannelId = response.channels['early_loc'];
        if (!earlyLocChannelId) {
            logger.debug({ guildId }, 'No early_loc channel configured, skipping notification');
            return;
        }

        // Fetch the channel
        const channel = await client.channels.fetch(earlyLocChannelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            logger.warn({ guildId, earlyLocChannelId }, 
                'early_loc channel not found or not a text channel');
            return;
        }

        // Determine title and color based on whether this is initial set or change
        const isInitialSet = notificationData.isInitialSet;
        const title = isInitialSet ? '🟢 Location Set' : '🟡 Location Updated';
        const color = isInitialSet ? 0x57F287 : 0xFEE75C; // Green for SET, Yellow for CHANGED

        // Format party and location (show N/A for null values)
        const partyText = notificationData.party || 'N/A';
        const locationText = notificationData.location || 'N/A';

        // Build the message URL if we have the channel and message IDs
        let messageUrl: string | undefined;
        if (runChannelId && runMessageId) {
            messageUrl = `https://discord.com/channels/${guildId}/${runChannelId}/${runMessageId}`;
        }

        // Build the embed
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(
                `Organizer: <@${organizerId}>\n` +
                `Dungeon: **${dungeonLabel}**\n` +
                `Party: **${partyText}**\n` +
                `Location: **${locationText}**` +
                (messageUrl ? `\n\n[Jump to Run Message](${messageUrl})` : '')
            )
            .setColor(color)
            .setTimestamp();

        // Check if there's a configured dungeon role ping
        let content = '';
        try {
            const { dungeon_role_pings } = await getDungeonRolePings(guildId);
            const roleId = dungeon_role_pings[dungeonKey];
            if (roleId) {
                content = `<@&${roleId}>`;
            }
        } catch (e) {
            logger.warn({ guildId, dungeonKey }, 
                'Failed to fetch dungeon role pings for early-loc notification');
            // Continue without role ping
        }

        // Send the embed (with optional role ping in content)
        await channel.send({ 
            content: content || undefined,
            embeds: [embed] 
        });

        logger.info({ guildId, isInitialSet, party: notificationData.party, location: notificationData.location }, 
            'Sent early-loc notification');
    } catch (err) {
        logger.error({ err, guildId }, 
            'Failed to send early-loc notification');
        // Don't throw - notification failure shouldn't block the main operation
    }
}

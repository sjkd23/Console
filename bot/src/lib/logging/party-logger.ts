// bot/src/lib/logging/party-logger.ts
/**
 * Centralized party logging system for tracking all party-related events.
 * Creates threads in the raid-log channel to organize logs for each party.
 */

import {
    Client,
    ThreadChannel,
    EmbedBuilder,
    ChannelType,
    TextChannel
} from 'discord.js';
import { getGuildChannels } from '../utilities/http.js';
import { createLogger } from './logger.js';

const logger = createLogger('PartyLogger');

/** In-memory cache to store thread IDs for each party */
const logThreadCache = new Map<string, string>();

export interface PartyLogContext {
    guildId: string;
    ownerId: string;
    ownerUsername: string;
    partyName: string;
    messageId: string;
}

/**
 * Create or retrieve the log thread for a party.
 * Returns the thread channel if successful, null otherwise.
 */
export async function getOrCreatePartyLogThread(
    client: Client,
    context: PartyLogContext
): Promise<ThreadChannel | null> {
    try {
        // Generate a unique cache key
        const cacheKey = `party:${context.guildId}:${context.messageId}`;

        // Check cache first
        const cachedThreadId = logThreadCache.get(cacheKey);
        if (cachedThreadId) {
            try {
                const thread = await client.channels.fetch(cachedThreadId) as ThreadChannel;
                if (thread && !thread.archived) {
                    return thread;
                }
            } catch {
                // Thread no longer exists, remove from cache
                logThreadCache.delete(cacheKey);
            }
        }

        // Get the raid-log channel (parties log to the same channel as raids for now)
        const { channels } = await getGuildChannels(context.guildId);
        const raidLogChannelId = channels.raid_log;

        if (!raidLogChannelId) {
            logger.warn('No raid-log channel configured', { guildId: context.guildId });
            return null;
        }

        // Fetch the raid-log channel
        const raidLogChannel = await client.channels.fetch(raidLogChannelId);
        if (!raidLogChannel || !raidLogChannel.isTextBased() || raidLogChannel.type === ChannelType.GuildVoice) {
            logger.warn('Raid-log channel is not a text channel', { channelId: raidLogChannelId });
            return null;
        }

        // Create the initial message for the thread
        const title = `Party: ${context.partyName} - Owner: ${context.ownerUsername}`;
        
        const initialEmbed = new EmbedBuilder()
            .setTitle(`🎉 ${title}`)
            .setDescription(
                `**Type:** Party Finder\n` +
                `**Party Name:** ${context.partyName}\n` +
                `**Owner:** <@${context.ownerId}>\n` +
                `**Started:** <t:${Math.floor(Date.now() / 1000)}:F>`
            )
            .setColor(0x57F287) // Green for party
            .setTimestamp(new Date());

        const initialMessage = await (raidLogChannel as TextChannel).send({
            embeds: [initialEmbed]
        });

        // Create the thread
        const thread = await initialMessage.startThread({
            name: title.substring(0, 100), // Discord thread name limit
            autoArchiveDuration: 1440, // 24 hours
        });

        // Cache the thread ID
        logThreadCache.set(cacheKey, thread.id);

        logger.info('Created new party log thread', { 
            guildId: context.guildId, 
            threadId: thread.id,
            partyName: context.partyName
        });

        return thread;
    } catch (error) {
        logger.error('Failed to create/retrieve party log thread', { error, context });
        return null;
    }
}

/**
 * Log a message to the party thread
 */
export async function logToPartyThread(
    client: Client,
    context: PartyLogContext,
    message: string,
    embed?: EmbedBuilder
): Promise<void> {
    try {
        const thread = await getOrCreatePartyLogThread(client, context);
        if (!thread) return;

        const content: any = { content: message };
        if (embed) {
            content.embeds = [embed];
        }

        await thread.send(content);
    } catch (error) {
        logger.error('Failed to log message to party thread', { error, context });
    }
}

/**
 * Update the initial thread message with ended timestamp
 */
export async function updatePartyThreadWithEndTime(
    client: Client,
    context: PartyLogContext
): Promise<void> {
    try {
        const thread = await getOrCreatePartyLogThread(client, context);
        if (!thread) return;

        // Fetch the starter message (the message that created the thread)
        const starterMessage = await thread.fetchStarterMessage();
        if (!starterMessage || !starterMessage.embeds.length) return;

        const embed = EmbedBuilder.from(starterMessage.embeds[0]);
        const description = embed.data.description || '';
        
        // Add ended timestamp to description if not already present
        if (!description.includes('**Ended:**')) {
            const endedTime = Math.floor(Date.now() / 1000);
            const updatedDescription = description + `\n**Ended:** <t:${endedTime}:F>`;
            embed.setDescription(updatedDescription);
            
            await starterMessage.edit({ embeds: [embed] });
        }
    } catch (error) {
        logger.error('Failed to update party thread starter with end time', { error, context });
    }
}

/**
 * Log party creation
 */
export async function logPartyCreation(
    client: Client,
    context: PartyLogContext,
    additionalInfo?: { location?: string; description?: string; dungeons?: string[] }
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle('✅ Party Created')
        .setColor(0x57F287) // Green
        .setTimestamp(new Date());

    let description = `**Party Name:** ${context.partyName}\n`;
    
    if (additionalInfo?.location) {
        description += `**Location:** ${additionalInfo.location}\n`;
    }
    if (additionalInfo?.description) {
        description += `**Description:** ${additionalInfo.description}\n`;
    }
    if (additionalInfo?.dungeons && additionalInfo.dungeons.length > 0) {
        description += `**Dungeons:** ${additionalInfo.dungeons.join(', ')}\n`;
    }

    embed.setDescription(description);

    await logToPartyThread(client, context, '', embed);
}

/**
 * Log party closure
 */
export async function logPartyClosure(
    client: Client,
    context: PartyLogContext,
    closedById: string
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle('❌ Party Closed')
        .setDescription(`Party closed by <@${closedById}>`)
        .setColor(0xED4245) // Red
        .setTimestamp(new Date());

    await logToPartyThread(client, context, '', embed);
    
    // Update the initial message with end time
    await updatePartyThreadWithEndTime(client, context);
}

/**
 * Clear the thread cache for a specific party (call when party closes)
 */
export function clearPartyLogThreadCache(context: PartyLogContext): void {
    const cacheKey = `party:${context.guildId}:${context.messageId}`;
    logThreadCache.delete(cacheKey);
}

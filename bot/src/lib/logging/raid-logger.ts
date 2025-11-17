// bot/src/lib/raid-logger.ts
/**
 * Centralized raid logging system for tracking all raid-related events.
 * Creates threads in the raid-log channel to organize logs for each run/headcount.
 */

import {
    Client,
    ThreadChannel,
    EmbedBuilder,
    ChannelType,
    TextChannel,
    ForumChannel,
    NewsChannel,
    messageLink
} from 'discord.js';
import { getGuildChannels } from '../utilities/http.js';
import { createLogger } from './logger.js';

const logger = createLogger('RaidLogger');

/** In-memory cache to store thread IDs for each run/headcount */
const logThreadCache = new Map<string, string>();

export interface RaidLogContext {
    guildId: string;
    organizerId: string;
    organizerUsername: string;
    dungeonName: string;
    type: 'run' | 'headcount';
    runId?: number;
    panelTimestamp?: string;
}

/**
 * Create or retrieve the log thread for a raid.
 * Returns the thread channel if successful, null otherwise.
 */
export async function getOrCreateLogThread(
    client: Client,
    context: RaidLogContext
): Promise<ThreadChannel | null> {
    try {
        // Generate a unique cache key
        const cacheKey = context.type === 'run'
            ? `run:${context.guildId}:${context.runId}`
            : `headcount:${context.guildId}:${context.panelTimestamp}`;

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

        // Get the raid-log channel
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
        const title = `${context.dungeonName}: Organizer - ${context.organizerUsername}`;
        
        const initialEmbed = new EmbedBuilder()
            .setTitle(`📋 ${title}`)
            .setDescription(
                `**Type:** ${context.type === 'run' ? 'Run' : 'Headcount'}\n` +
                `**Dungeon:** ${context.dungeonName}\n` +
                `**Organizer:** <@${context.organizerId}>\n` +
                `**Started:** <t:${Math.floor(Date.now() / 1000)}:F>`
            )
            .setColor(context.type === 'run' ? 0x5865F2 : 0xFEE75C)
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

        logger.info('Created new raid log thread', { 
            guildId: context.guildId, 
            threadId: thread.id,
            type: context.type 
        });

        return thread;
    } catch (error) {
        logger.error('Failed to create/retrieve log thread', { error, context });
        return null;
    }
}

/**
 * Log a message to the raid thread
 */
export async function logToThread(
    client: Client,
    context: RaidLogContext,
    message: string,
    embed?: EmbedBuilder
): Promise<void> {
    try {
        const thread = await getOrCreateLogThread(client, context);
        if (!thread) return;

        const content: any = { content: message };
        if (embed) {
            content.embeds = [embed];
        }

        await thread.send(content);
    } catch (error) {
        logger.error('Failed to log message to thread', { error, context });
    }
}

/**
 * Update the initial thread message with ended timestamp
 */
export async function updateThreadStarterWithEndTime(
    client: Client,
    context: RaidLogContext
): Promise<void> {
    try {
        const thread = await getOrCreateLogThread(client, context);
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
        logger.error('Failed to update thread starter with end time', { error, context });
    }
}

/**
 * Log run/headcount creation
 */
export async function logRaidCreation(
    client: Client,
    context: RaidLogContext,
    additionalInfo?: { party?: string; location?: string; description?: string }
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle('✅ Raid Created')
        .setColor(0x00ff00)
        .setTimestamp(new Date());

    let description = `**Type:** ${context.type === 'run' ? 'Run' : 'Headcount'}\n`;
    
    if (additionalInfo?.party) {
        description += `**Party:** ${additionalInfo.party}\n`;
    }
    if (additionalInfo?.location) {
        description += `**Location:** ${additionalInfo.location}\n`;
    }
    if (additionalInfo?.description) {
        description += `**Note:** ${additionalInfo.description}\n`;
    }

    embed.setDescription(description);

    await logToThread(client, context, '', embed);
}

/**
 * Log run status change (started, ended, cancelled)
 */
export async function logRunStatusChange(
    client: Client,
    context: RaidLogContext,
    status: 'live' | 'ended' | 'cancelled',
    actorId: string
): Promise<void> {
    const statusEmojis = {
        live: '🟢',
        ended: '✅',
        cancelled: '❌'
    };

    const statusLabels = {
        live: 'Started',
        ended: 'Ended',
        cancelled: 'Cancelled'
    };

    const statusColors = {
        live: 0x00ff00,
        ended: 0x5865F2,
        cancelled: 0xff0000
    };

    const embed = new EmbedBuilder()
        .setTitle(`${statusEmojis[status]} Run ${statusLabels[status]}`)
        .setColor(statusColors[status])
        .setTimestamp(new Date());

    // Add description with timestamp for ended/cancelled runs
    if (status === 'ended' || status === 'cancelled') {
        const endedTime = Math.floor(Date.now() / 1000);
        embed.setDescription(
            `Run status changed to **${status}** by <@${actorId}>`
        );
        embed.addFields({
            name: 'Ended',
            value: `<t:${endedTime}:F>\n<t:${endedTime}:R>`,
            inline: false
        });
    } else {
        embed.setDescription(`Run status changed to **${status}** by <@${actorId}>`);
    }

    await logToThread(client, context, '', embed);
}

/**
 * Log user joining or leaving a raid
 */
export async function logRaidJoin(
    client: Client,
    context: RaidLogContext,
    userId: string,
    action: 'joined' | 'left',
    newCount: number
): Promise<void> {
    const emoji = action === 'joined' ? '➕' : '➖';
    const color = action === 'joined' ? 0x00ff00 : 0xff6b6b;

    const embed = new EmbedBuilder()
        .setDescription(`${emoji} <@${userId}> **${action}** the raid (Total: **${newCount}** raiders)`)
        .setColor(color)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Log key reaction (pop/unpop)
 */
export async function logKeyReaction(
    client: Client,
    context: RaidLogContext,
    userId: string,
    keyType: string,
    action: 'added' | 'removed',
    newCount: number
): Promise<void> {
    const emoji = action === 'added' ? '🔑' : '🔓';
    const color = action === 'added' ? 0xfee75c : 0x95a5a6;

    const embed = new EmbedBuilder()
        .setDescription(
            `${emoji} <@${userId}> **${action}** a **${keyType}** key reaction ` +
            `(Total ${keyType}: **${newCount}**)`
        )
        .setColor(color)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Log button interaction (organizer panel, etc.)
 */
export async function logButtonClick(
    client: Client,
    context: RaidLogContext,
    userId: string,
    buttonLabel: string,
    buttonAction: string
): Promise<void> {
    const embed = new EmbedBuilder()
        .setDescription(`🔘 <@${userId}> clicked **${buttonLabel}** (${buttonAction})`)
        .setColor(0x95a5a6)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Log party/location update
 */
export async function logRunInfoUpdate(
    client: Client,
    context: RaidLogContext,
    userId: string,
    field: 'party' | 'location',
    newValue: string
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle(`📝 ${field === 'party' ? 'Party' : 'Location'} Updated`)
        .setDescription(
            `<@${userId}> updated the **${field}** to: **${newValue}**`
        )
        .setColor(0x5865F2)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Log key window activation
 */
export async function logKeyWindow(
    client: Client,
    context: RaidLogContext,
    userId: string,
    duration: number
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle('🔑 Key Popped')
        .setDescription(
            `<@${userId}> activated the key window (${duration} seconds)\n` +
            `Party join window is now open!`
        )
        .setColor(0xfee75c)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Log screenshot submission (for Oryx 3 runs)
 */
export async function logScreenshotSubmission(
    client: Client,
    context: RaidLogContext,
    screenshotUrl: string,
    userId: string
): Promise<void> {
    const embed = new EmbedBuilder()
        .setTitle('📸 Completion Screenshot Submitted')
        .setDescription(
            `<@${userId}> submitted a completion screenshot for Oryx 3.\n\n` +
            `[View Screenshot](${screenshotUrl})`
        )
        .setImage(screenshotUrl)
        .setColor(0x3498db)
        .setTimestamp(new Date());

    await logToThread(client, context, '', embed);
}

/**
 * Clear the thread cache for a specific raid (call when raid ends)
 */
export function clearLogThreadCache(context: RaidLogContext): void {
    const cacheKey = context.type === 'run'
        ? `run:${context.guildId}:${context.runId}`
        : `headcount:${context.guildId}:${context.panelTimestamp}`;
    
    logThreadCache.delete(cacheKey);
}

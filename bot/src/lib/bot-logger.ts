// bot/src/lib/bot-logger.ts
/**
 * Bot activity logging system for tracking command executions and bot events.
 * Logs to the bot_log channel configured via /setchannels.
 */

import {
    Client,
    EmbedBuilder,
    TextChannel,
    ChatInputCommandInteraction,
    User,
    Guild,
    GuildMember,
} from 'discord.js';
import { getGuildChannels } from './http.js';
import { createLogger } from './logger.js';

const logger = createLogger('BotLogger');

/**
 * Log a command execution to the bot-log channel
 */
export async function logCommandExecution(
    client: Client,
    interaction: ChatInputCommandInteraction,
    options?: {
        success?: boolean;
        errorMessage?: string;
        details?: Record<string, any>;
    }
): Promise<void> {
    try {
        if (!interaction.guildId) return; // Don't log DM commands

        // Get the bot-log channel
        const { channels } = await getGuildChannels(interaction.guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            logger.warn('Bot-log channel is not a text channel', { channelId: botLogChannelId });
            return;
        }

        // Extract command info
        const commandName = interaction.commandName;
        const subcommand = interaction.options.getSubcommand(false);
        const fullCommand = subcommand ? `/${commandName} ${subcommand}` : `/${commandName}`;
        
        // Build embed
        const isSuccess = options?.success !== false;
        const embed = new EmbedBuilder()
            .setTitle(`${isSuccess ? '✅' : '❌'} Command: ${fullCommand}`)
            .setColor(isSuccess ? 0x00ff00 : 0xff0000)
            .setTimestamp(new Date())
            .addFields(
                { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
                { name: 'Command ID', value: interaction.id, inline: false }
            );

        // Add error message if provided
        if (options?.errorMessage) {
            embed.addFields({ name: 'Error', value: options.errorMessage, inline: false });
        }

        // Add additional details if provided
        if (options?.details && Object.keys(options.details).length > 0) {
            const detailsText = Object.entries(options.details)
                .map(([key, value]) => `**${key}:** ${value}`)
                .join('\n');
            embed.addFields({ name: 'Details', value: detailsText, inline: false });
        }

        await botLogChannel.send({ embeds: [embed] });

        logger.info('Logged command execution', { 
            guildId: interaction.guildId, 
            command: fullCommand,
            userId: interaction.user.id,
            success: isSuccess
        });
    } catch (error) {
        logger.error('Failed to log command execution', { error });
    }
}

/**
 * Log a moderation action to the bot-log channel
 */
export async function logModerationAction(
    client: Client,
    guildId: string,
    action: string,
    actorId: string,
    targetId: string,
    details?: {
        reason?: string;
        duration?: string;
        additionalInfo?: Record<string, any>;
    }
): Promise<void> {
    try {
        // Get the bot-log channel
        const { channels } = await getGuildChannels(guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`🔨 Moderation: ${action}`)
            .setColor(0xff9500)
            .setTimestamp(new Date())
            .addFields(
                { name: 'Moderator', value: `<@${actorId}>`, inline: true },
                { name: 'Target', value: `<@${targetId}>`, inline: true }
            );

        if (details?.reason) {
            embed.addFields({ name: 'Reason', value: details.reason, inline: false });
        }

        if (details?.duration) {
            embed.addFields({ name: 'Duration', value: details.duration, inline: true });
        }

        if (details?.additionalInfo) {
            const infoText = Object.entries(details.additionalInfo)
                .map(([key, value]) => `**${key}:** ${value}`)
                .join('\n');
            embed.addFields({ name: 'Additional Info', value: infoText, inline: false });
        }

        await botLogChannel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to log moderation action', { error });
    }
}

/**
 * Log a configuration change to the bot-log channel
 */
export async function logConfigChange(
    client: Client,
    guildId: string,
    configType: string,
    actorId: string,
    changes: Record<string, { old?: string; new?: string }>
): Promise<void> {
    try {
        // Get the bot-log channel
        const { channels } = await getGuildChannels(guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`⚙️ Configuration: ${configType}`)
            .setColor(0x5865F2)
            .setTimestamp(new Date())
            .addFields({ name: 'Modified By', value: `<@${actorId}>`, inline: false });

        // Add change details
        for (const [key, change] of Object.entries(changes)) {
            const oldValue = change.old || '—';
            const newValue = change.new || '—';
            embed.addFields({
                name: key,
                value: `${oldValue} → ${newValue}`,
                inline: true
            });
        }

        await botLogChannel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to log config change', { error });
    }
}

/**
 * Log a general bot event to the bot-log channel
 */
export async function logBotEvent(
    client: Client,
    guildId: string,
    eventTitle: string,
    description: string,
    options?: {
        color?: number;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
    }
): Promise<void> {
    try {
        // Get the bot-log channel
        const { channels } = await getGuildChannels(guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(eventTitle)
            .setDescription(description)
            .setColor(options?.color || 0x5865F2)
            .setTimestamp(new Date());

        if (options?.fields) {
            embed.addFields(options.fields);
        }

        await botLogChannel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to log bot event', { error });
    }
}

/**
 * Log quota-related actions (to avoid overlap with quota panel updates)
 * This focuses on administrative actions, not automatic point updates
 */
export async function logQuotaAction(
    client: Client,
    guildId: string,
    action: string,
    actorId: string,
    targetId: string,
    points: number,
    reason?: string
): Promise<void> {
    try {
        // Get the bot-log channel
        const { channels } = await getGuildChannels(guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            return;
        }

        const emoji = points >= 0 ? '➕' : '➖';
        const embed = new EmbedBuilder()
            .setTitle(`${emoji} Quota: ${action}`)
            .setColor(points >= 0 ? 0x00ff00 : 0xff6b6b)
            .setTimestamp(new Date())
            .addFields(
                { name: 'Moderator', value: `<@${actorId}>`, inline: true },
                { name: 'Target', value: `<@${targetId}>`, inline: true },
                { name: 'Points', value: `${points >= 0 ? '+' : ''}${points}`, inline: true }
            );

        if (reason) {
            embed.addFields({ name: 'Reason', value: reason, inline: false });
        }

        await botLogChannel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to log quota action', { error });
    }
}

/**
 * Log verification actions (manual verify/unverify from commands)
 * This complements the verification log thread system
 */
export async function logVerificationAction(
    client: Client,
    guildId: string,
    action: 'verified' | 'unverified',
    actorId: string,
    targetId: string,
    ign: string,
    reason?: string
): Promise<void> {
    try {
        // Get the bot-log channel
        const { channels } = await getGuildChannels(guildId);
        const botLogChannelId = channels.bot_log;

        if (!botLogChannelId) {
            return; // No bot-log channel configured
        }

        // Fetch the bot-log channel
        const botLogChannel = await client.channels.fetch(botLogChannelId);
        if (!botLogChannel || !botLogChannel.isTextBased() || !(botLogChannel instanceof TextChannel)) {
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`${action === 'verified' ? '✅' : '❌'} Verification: ${action}`)
            .setColor(action === 'verified' ? 0x00ff00 : 0xff0000)
            .setTimestamp(new Date())
            .addFields(
                { name: 'Moderator', value: `<@${actorId}>`, inline: true },
                { name: 'User', value: `<@${targetId}>`, inline: true },
                { name: 'IGN', value: ign, inline: true }
            );

        if (reason) {
            embed.addFields({ name: 'Reason', value: reason, inline: false });
        }

        await botLogChannel.send({ embeds: [embed] });
    } catch (error) {
        logger.error('Failed to log verification action', { error });
    }
}

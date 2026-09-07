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
import type { AttachmentPayload } from 'discord.js';
import { getGuildChannels } from '../utilities/http.js';
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
        auditAction?: string;
        color?: number;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        files?: readonly AttachmentPayload[];
        imageUrl?: string;
    }
): Promise<
    | { status: 'sent'; channelId: string }
    | {
        status: 'skipped';
        reason: 'not_configured' | 'channel_not_found' | 'channel_not_sendable';
        channelId: string | null;
    }
    | {
        status: 'failed';
        reason: 'configuration_lookup_failed' | 'channel_fetch_failed' | 'send_failed';
        channelId: string | null;
    }
> {
    const auditEvent = options?.auditAction ?? eventTitle;
    const diagnosticsRequested = options?.auditAction !== undefined;
    let botLogChannelId: string | null = null;

    try {
        const { channels } = await getGuildChannels(guildId);
        botLogChannelId = channels.bot_log ?? null;
    } catch (error) {
        logger.error('Failed to resolve bot-log channel for audit event', {
            guildId,
            auditEvent,
            botLogChannelId,
            reason: 'configuration_lookup_failed',
            error,
        });
        return { status: 'failed', reason: 'configuration_lookup_failed', channelId: null };
    }

    if (!botLogChannelId) {
        if (diagnosticsRequested) {
            logger.warn('Skipped bot-log audit because no channel is configured', {
                guildId,
                auditEvent,
                botLogChannelId,
                reason: 'not_configured',
            });
        }
        return { status: 'skipped', reason: 'not_configured', channelId: null };
    }

    let botLogChannel;
    try {
        botLogChannel = await client.channels.fetch(botLogChannelId);
    } catch (error) {
        logger.error('Failed to fetch configured bot-log channel for audit event', {
            guildId,
            auditEvent,
            botLogChannelId,
            reason: 'channel_fetch_failed',
            error,
        });
        return { status: 'failed', reason: 'channel_fetch_failed', channelId: botLogChannelId };
    }

    if (!botLogChannel) {
        if (diagnosticsRequested) {
            logger.warn('Skipped bot-log audit because the configured channel was not found', {
                guildId,
                auditEvent,
                botLogChannelId,
                reason: 'channel_not_found',
            });
        }
        return { status: 'skipped', reason: 'channel_not_found', channelId: botLogChannelId };
    }

    if (!botLogChannel.isSendable()) {
        if (diagnosticsRequested) {
            logger.warn('Skipped bot-log audit because the configured channel is not sendable', {
                guildId,
                auditEvent,
                botLogChannelId,
                channelType: botLogChannel.type,
                reason: 'channel_not_sendable',
            });
        }
        return { status: 'skipped', reason: 'channel_not_sendable', channelId: botLogChannelId };
    }

    const embed = new EmbedBuilder()
        .setTitle(eventTitle)
        .setDescription(description)
        .setColor(options?.color || 0x5865F2)
        .setTimestamp(new Date());

    if (options?.fields) {
        embed.addFields(options.fields);
    }
    if (options?.imageUrl) {
        embed.setImage(options.imageUrl);
    }

    try {
        await botLogChannel.send({ embeds: [embed], files: options?.files });
        if (diagnosticsRequested) {
            logger.info('Sent bot-log audit event', {
                guildId,
                auditEvent,
                botLogChannelId,
            });
        }
        return { status: 'sent', channelId: botLogChannelId };
    } catch (error) {
        logger.error('Failed to send bot-log audit event', {
            guildId,
            auditEvent,
            botLogChannelId,
            reason: 'send_failed',
            error,
        });
        return { status: 'failed', reason: 'send_failed', channelId: botLogChannelId };
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

// bot/src/lib/quota-config-panel.ts
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getQuotaRoleConfig, BackendError } from '../utilities/http.js';
import type { QuotaPeriod } from '../utilities/http.js';
import { formatPoints, formatPointAmount } from '../utilities/format-helpers.js';
import { MINUTE_QUOTA_LABEL, MINUTE_QUOTA_DESCRIPTION } from './quota-base-points.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';

/**
 * Build the /configquota main panel embed and buttons
 * Used by both the command and the refresh logic
 */
export async function buildQuotaConfigPanel(guildId: string, roleId: string, userId?: string): Promise<{
    embed: EmbedBuilder;
    buttons: ActionRowBuilder<ButtonBuilder>[];
    config: QuotaConfigPanelConfig | null;
}> {
    // Fetch current config from backend
    let config: QuotaConfigPanelConfig | null = null;
    let activePeriod: QuotaPeriod | null = null;
    let dungeonOverrides: Record<string, number> = {};
    
    try {
        const result = await getQuotaRoleConfig(guildId, roleId);
        config = result.config;
        activePeriod = result.active_period;
        dungeonOverrides = result.dungeon_overrides;
        
        // Debug log to check if base points are being returned
        if (config) {
            console.log(`[QuotaConfigPanel] Config fetched for ${guildId}/${roleId}:`, {
                base_exalt_points: config.base_exalt_points,
                base_non_exalt_points: config.base_non_exalt_points,
                moderation_points: config.moderation_points
            });
        }
    } catch (err) {
        if (err instanceof BackendError && err.status === 404) {
            // No config exists yet - that's okay, we'll create one
        } else {
            throw err;
        }
    }

    // Fetch role information (we'll need to pass this in or fetch it)
    // For now, we'll just use the roleId in the embed
    const embed = new EmbedBuilder()
        .setTitle(`📊 Quota Configuration`)
        .setDescription(`Configure quota settings for <@&${roleId}>.\n\n${MINUTE_QUOTA_DESCRIPTION}`)
        .setColor(0x5865F2)
        .setTimestamp();

    if (config && activePeriod) {
        const periodStartDate = new Date(activePeriod.starts_at);
        const periodStartTimestamp = Math.floor(periodStartDate.getTime() / 1000);
        const resetDate = new Date(activePeriod.ends_at);
        const resetTimestamp = Math.floor(resetDate.getTime() / 1000);
        
        // Use ?? instead of || to handle 0 values correctly
        const baseExaltPoints = config.base_exalt_points ?? 1;
        const baseNonExaltPoints = config.base_non_exalt_points ?? 0;
        
        embed.addFields(
            { name: '🎯 Next Required Points', value: formatPoints(config.required_points), inline: true },
            { name: '⏱️ Next Interval', value: `${config.reset_interval_days} day${config.reset_interval_days === 1 ? '' : 's'}`, inline: true },
            { name: '🔄 Next Rollover', value: config.rollover_enabled ? 'Enabled' : 'Disabled', inline: true },
            { name: '📆 Period Start', value: `<t:${periodStartTimestamp}:F>\n(<t:${periodStartTimestamp}:R>)`, inline: true },
            { name: '📅 Resets', value: `<t:${resetTimestamp}:F>\n(<t:${resetTimestamp}:R>)`, inline: true },
            { name: '🎯 Active Target', value: formatPoints(activePeriod.required_points), inline: true },
            { name: '⚔️ Base Exalt Points', value: formatPoints(baseExaltPoints), inline: true },
            { name: '🗡️ Base Non-Exalt Points', value: formatPoints(baseNonExaltPoints), inline: true },
            { name: '\u200b', value: '\u200b', inline: true } // Spacer for proper layout
        );

        if (config.required_points !== activePeriod.required_points
            || config.rollover_enabled !== activePeriod.rollover_enabled) {
            embed.addFields({
                name: 'ℹ️ Pending Period Settings',
                value: 'The target or rollover setting differs from the active snapshot. The updated setting applies when the next period starts.',
                inline: false,
            });
        }

        // Build moderation points summary
        const modCommandPoints: string[] = [];
        if (config.verify_points && config.verify_points > 0) {
            modCommandPoints.push(`Verify: ${formatPoints(config.verify_points)}`);
        }
        if (config.warn_points && config.warn_points > 0) {
            modCommandPoints.push(`Warn: ${formatPoints(config.warn_points)}`);
        }
        if (config.suspend_points && config.suspend_points > 0) {
            modCommandPoints.push(`Suspend: ${formatPoints(config.suspend_points)}`);
        }
        if (config.modmail_reply_points && config.modmail_reply_points > 0) {
            modCommandPoints.push(`Modmail: ${formatPoints(config.modmail_reply_points)}`);
        }
        if (config.editname_points && config.editname_points > 0) {
            modCommandPoints.push(`Editname: ${formatPoints(config.editname_points)}`);
        }
        if (config.addnote_points && config.addnote_points > 0) {
            modCommandPoints.push(`Addnote: ${formatPoints(config.addnote_points)}`);
        }
        
        // Fallback to old moderation_points if no individual commands are set
        if (modCommandPoints.length === 0 && config.moderation_points > 0) {
            modCommandPoints.push(`All: ${formatPoints(config.moderation_points)}`);
        }

        const modPointsValue = modCommandPoints.length > 0 
            ? modCommandPoints.join(', ') 
            : 'None configured';
        
        embed.addFields({
            name: '✅ Moderation Command Points',
            value: modPointsValue,
            inline: false
        });

        // Show dungeon overrides if any
        if (Object.keys(dungeonOverrides).length > 0) {
            const overrideList = Object.entries(dungeonOverrides)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([key, pts]) => `${dungeonByCode[key]?.dungeonName ?? key}: ${formatPointAmount(pts)}`)
                .join('\n');
            
            embed.addFields({
                name: '⚙️ Dungeon Point Overrides',
                value: overrideList || 'None',
                inline: false
            });

            if (Object.keys(dungeonOverrides).length > 10) {
                embed.setFooter({ text: `... and ${Object.keys(dungeonOverrides).length - 10} more overrides` });
            }
        }
    } else if (config) {
        embed.addFields(
            {
                name: 'ℹ️ Status',
                value: 'Quota automation is inactive because required points are 0. Set a positive requirement to start a fresh period.',
                inline: false,
            },
            { name: '🎯 Required Points', value: formatPoints(config.required_points), inline: true },
            { name: '⏱️ Configured Interval', value: `${config.reset_interval_days} day${config.reset_interval_days === 1 ? '' : 's'}`, inline: true },
            { name: '🔄 Rollover', value: config.rollover_enabled ? 'Enabled' : 'Disabled', inline: true },
            { name: '⚔️ Base Exalt Points', value: formatPoints(config.base_exalt_points ?? 1), inline: true },
            { name: '🗡️ Base Non-Exalt Points', value: formatPoints(config.base_non_exalt_points ?? 0), inline: true },
        );
    } else {
        embed.addFields({
            name: 'ℹ️ Status',
            value: 'No configuration found. Click the buttons below to set up quota tracking for this role.',
            inline: false
        });
    }

    if (config) {
        embed.addFields({ name: MINUTE_QUOTA_LABEL, value: `${formatPoints(config.misc_points_per_minute)}/min`, inline: false });
    }

    // Build action buttons with creation timestamp for expiry checking (10 minute expiry)
    const createdAt = Date.now();
    const userIdSuffix = userId ? `:${userId}` : '';
    const buttons1 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`quota_config_basic:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Set Basic Config')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⚙️'),
            new ButtonBuilder()
                .setCustomId(`quota_config_base_points:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Base Points')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎯'),
            new ButtonBuilder()
                .setCustomId(`quota_config_moderation:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Moderation Points')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`quota_config_dungeons:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Configure Dungeons')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🗺️'),
            new ButtonBuilder()
                .setCustomId(`quota_refresh_panel:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Update Panel')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔄')
                .setDisabled(!activePeriod)
        );

    // Second row with Reset Panel, Delete Quota, and Stop buttons
    const buttons2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`quota_reset_panel:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Reset Period')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔁')
                .setDisabled(!activePeriod),
            new ButtonBuilder()
                .setCustomId(`quota_delete_config:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Delete Quota')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(!config), // Only enable if config exists
            new ButtonBuilder()
                .setCustomId(`quota_toggle_rollover:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel(config?.rollover_enabled ? 'Disable Rollover' : 'Enable Rollover')
                .setStyle(config?.rollover_enabled ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('🔄')
                .setDisabled(!config),
            new ButtonBuilder()
                .setCustomId(`quota_config_stop:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Stop')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑')
        );

    return { embed, buttons: [buttons1, buttons2], config };
}

interface QuotaConfigPanelConfig {
    guild_id: string;
    discord_role_id: string;
    required_points: number;
    reset_at: string;
    period_start_at: string;
    reset_interval_days: number;
    rollover_enabled: boolean;
    panel_message_id: string | null;
    moderation_points: number;
    base_exalt_points?: number;
    base_non_exalt_points?: number;
    misc_points_per_minute: number;
    verify_points?: number;
    warn_points?: number;
    suspend_points?: number;
    modmail_reply_points?: number;
    editname_points?: number;
    addnote_points?: number;
}

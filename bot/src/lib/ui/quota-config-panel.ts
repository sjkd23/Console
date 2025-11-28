// bot/src/lib/quota-config-panel.ts
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getQuotaRoleConfig, BackendError } from '../utilities/http.js';
import { formatPoints } from '../utilities/format-helpers.js';

/**
 * Build the /configquota main panel embed and buttons
 * Used by both the command and the refresh logic
 */
export async function buildQuotaConfigPanel(guildId: string, roleId: string, userId?: string): Promise<{
    embed: EmbedBuilder;
    buttons: ActionRowBuilder<ButtonBuilder>[];
    config: any | null;
}> {
    // Fetch current config from backend
    let config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
        moderation_points: number;
        base_exalt_points?: number;
        base_non_exalt_points?: number;
        verify_points?: number;
        warn_points?: number;
        suspend_points?: number;
        modmail_reply_points?: number;
        editname_points?: number;
        addnote_points?: number;
    } | null = null;
    let dungeonOverrides: Record<string, number> = {};
    
    try {
        const result = await getQuotaRoleConfig(guildId, roleId);
        config = result.config;
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
        .setDescription(`Configure quota settings for <@&${roleId}>.`)
        .setColor(0x5865F2)
        .setTimestamp();

    if (config) {
        const resetDate = new Date(config.reset_at);
        const resetTimestamp = Math.floor(resetDate.getTime() / 1000);
        
        // Use ?? instead of || to handle 0 values correctly
        const baseExaltPoints = config.base_exalt_points ?? 1;
        const baseNonExaltPoints = config.base_non_exalt_points ?? 1;
        
        embed.addFields(
            { name: '🎯 Required Points', value: formatPoints(config.required_points), inline: true },
            { name: '📅 Resets', value: `<t:${resetTimestamp}:F>\n(<t:${resetTimestamp}:R>)`, inline: true },
            { name: '\u200b', value: '\u200b', inline: true }, // Spacer for proper layout
            { name: '⚔️ Base Exalt Points', value: formatPoints(baseExaltPoints), inline: true },
            { name: '🗡️ Base Non-Exalt Points', value: formatPoints(baseNonExaltPoints), inline: true }
        );

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
                .map(([key, pts]) => `${key}: ${formatPoints(pts)} pts`)
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
    } else {
        embed.addFields({
            name: 'ℹ️ Status',
            value: 'No configuration found. Click the buttons below to set up quota tracking for this role.',
            inline: false
        });
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
                .setDisabled(!config) // Only enable if config exists
        );

    // Second row with Reset Panel, Delete Quota, and Stop buttons
    const buttons2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`quota_reset_panel:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Reset Panel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔁')
                .setDisabled(!config), // Only enable if config exists
            new ButtonBuilder()
                .setCustomId(`quota_delete_config:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Delete Quota')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(!config), // Only enable if config exists
            new ButtonBuilder()
                .setCustomId(`quota_config_stop:${roleId}:${createdAt}${userIdSuffix}`)
                .setLabel('Stop')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑')
        );

    return { embed, buttons: [buttons1, buttons2], config };
}

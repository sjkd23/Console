// bot/src/lib/configpoints-panel.ts
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getRaiderPointsConfig, getKeyPopPointsConfig, BackendError } from './http.js';

/**
 * Build the /configpoints main panel embed and buttons
 * Used by both the command and the refresh logic
 */
export async function buildConfigPointsPanel(guildId: string, userId?: string): Promise<{
    embed: EmbedBuilder;
    buttons: ActionRowBuilder<ButtonBuilder>;
}> {
    // Fetch current configuration from backend
    let dungeonPoints: Record<string, number> = {};
    let keyPopPoints: Record<string, number> = {};
    
    try {
        const result = await getRaiderPointsConfig(guildId);
        dungeonPoints = result.dungeon_points;
    } catch (err) {
        if (err instanceof BackendError && err.status === 404) {
            // No config exists yet - that's okay, we'll show empty config
        } else {
            throw err;
        }
    }

    try {
        const result = await getKeyPopPointsConfig(guildId);
        keyPopPoints = result.dungeon_points;
    } catch (err) {
        if (err instanceof BackendError && err.status === 404) {
            // No config exists yet - that's okay, we'll show empty config
        } else {
            throw err;
        }
    }

    // Build config panel embed
    const embed = new EmbedBuilder()
        .setTitle('⭐ Raider Points Configuration')
        .setDescription(
            'Configure how many **points** raiders earn for completing dungeons or popping keys.\n\n' +
            '**Default Values:**\n' +
            '• Dungeon completions: **1 point** (default)\n' +
            '• Key pops: **5 points** (default)\n\n' +
            '**Points vs Quota Points:**\n' +
            '• **Points**: Awarded to raiders for participation\n' +
            '• **Quota Points**: Awarded to organizers/verifiers per role'
        )
        .setColor(0x3498db)
        .setTimestamp();

    // Show configured dungeons if any
    const dungeonConfiguredList = Object.entries(dungeonPoints)
        .filter(([, pts]) => pts !== 1) // Only show non-default configs
        .sort(([, a], [, b]) => b - a) // Sort by points descending
        .slice(0, 10) // Limit to 10 for cleaner display
        .map(([key, pts]) => `**${key}**: ${pts} pts`)
        .join('\n');

    const dungeonConfigCount = Object.values(dungeonPoints).filter(p => p !== 1).length;

    if (dungeonConfiguredList) {
        embed.addFields({
            name: `🗺️ Dungeon Overrides (${dungeonConfigCount})`,
            value: dungeonConfiguredList,
            inline: true
        });
    } else {
        embed.addFields({
            name: '🗺️ Dungeon Overrides (0)',
            value: 'All use default: 1 pt',
            inline: true
        });
    }

    // Show configured key pop points
    const keyConfiguredList = Object.entries(keyPopPoints)
        .filter(([, pts]) => pts !== 5) // Only show non-default configs
        .sort(([, a], [, b]) => b - a) // Sort by points descending
        .slice(0, 10) // Limit to 10 for cleaner display
        .map(([key, pts]) => `**${key}**: ${pts} pts`)
        .join('\n');

    const keyConfigCount = Object.values(keyPopPoints).filter(p => p !== 5).length;

    if (keyConfiguredList) {
        embed.addFields({
            name: `🔑 Key Pop Overrides (${keyConfigCount})`,
            value: keyConfiguredList,
            inline: true
        });
    } else {
        embed.addFields({
            name: '🔑 Key Pop Overrides (0)',
            value: 'All use default: 5 pts',
            inline: true
        });
    }

    // Add footer if there are more than 10 configs for either category
    const totalExcess = Math.max(0, dungeonConfigCount - 10) + Math.max(0, keyConfigCount - 10);
    if (totalExcess > 0) {
        embed.setFooter({ text: `... and ${totalExcess} more override(s). Use configure buttons to view all.` });
    }

    // Build action buttons
    const buttons = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(userId ? `points_config_dungeons:${userId}` : 'points_config_dungeons')
                .setLabel('Configure Dungeons')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🗺️'),
            new ButtonBuilder()
                .setCustomId(userId ? `points_config_keys:${userId}` : 'points_config_keys')
                .setLabel('Configure Keys')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔑'),
            new ButtonBuilder()
                .setCustomId(userId ? `points_config_stop:${userId}` : 'points_config_stop')
                .setLabel('Stop')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑')
        );

    return { embed, buttons };
}

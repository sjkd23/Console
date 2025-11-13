import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getQuotaRoleConfig, BackendError } from '../../lib/http.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';

/**
 * /configquota - Configure quota settings for a specific role
 * Opens an interactive panel to configure:
 * - Required points per quota period
 * - Reset schedule (day of week, hour, minute)
 * - Per-dungeon point overrides
 */
export const configquota: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('configquota')
        .setDescription('Configure quota settings for a specific role (Moderator+)')
        .addRoleOption(o => 
            o.setName('role')
                .setDescription('The role to configure quota settings for')
                .setRequired(true)
        )
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // Guild-only check
            if (!interaction.inGuild() || !interaction.guild) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // ACK ASAP (permission check done by middleware)
            await interaction.deferReply();

            // Get the target role
            const role = interaction.options.getRole('role', true);
            if (!role) {
                await interaction.editReply('❌ Invalid role specified.');
                return;
            }

            // Fetch current config from backend
            let config: any = null;
            let dungeonOverrides: Record<string, number> = {};
            
            try {
                const result = await getQuotaRoleConfig(interaction.guildId!, role.id);
                config = result.config;
                dungeonOverrides = result.dungeon_overrides;
            } catch (err) {
                if (err instanceof BackendError && err.status === 404) {
                    // No config exists yet - that's okay, we'll create one
                } else {
                    throw err;
                }
            }

            // Build config panel embed
            const embed = new EmbedBuilder()
                .setTitle(`📊 Quota Configuration: ${role.name}`)
                .setDescription(`Configure quota settings for members with the <@&${role.id}> role.`)
                .setColor(role.color || 0x5865F2)
                .setTimestamp();

            if (config) {
                const resetDate = new Date(config.reset_at);
                const resetTimestamp = Math.floor(resetDate.getTime() / 1000);
                
                embed.addFields(
                    { name: '🎯 Required Points', value: config.required_points.toString(), inline: true },
                    { name: '📅 Resets', value: `<t:${resetTimestamp}:F>\n(<t:${resetTimestamp}:R>)`, inline: true }
                );

                // Show dungeon overrides if any
                if (Object.keys(dungeonOverrides).length > 0) {
                    const overrideList = Object.entries(dungeonOverrides)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 10)
                        .map(([key, pts]) => `${key}: ${pts} pts`)
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

            // Build action buttons
            const buttons = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`quota_config_basic:${role.id}:${interaction.user.id}`)
                        .setLabel('Set Basic Config')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('⚙️'),
                    new ButtonBuilder()
                        .setCustomId(`quota_config_dungeons:${role.id}:${interaction.user.id}`)
                        .setLabel('Configure Dungeons')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🗺️'),
                    new ButtonBuilder()
                        .setCustomId(`quota_refresh_panel:${role.id}:${interaction.user.id}`)
                        .setLabel('Update Panel')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🔄')
                        .setDisabled(!config), // Only enable if config exists
                    new ButtonBuilder()
                        .setCustomId(`quota_reset_panel:${role.id}:${interaction.user.id}`)
                        .setLabel('Reset Panel')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🔁')
                        .setDisabled(!config), // Only enable if config exists
                    new ButtonBuilder()
                        .setCustomId(`quota_config_stop:${role.id}:${interaction.user.id}`)
                        .setLabel('Stop')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('🛑')
                );

            await interaction.editReply({
                embeds: [embed],
                components: [buttons],
            });

        } catch (err) {
            console.error('configquota command error:', err);
            
            const errorMsg = err instanceof BackendError
                ? `❌ Failed to load quota configuration: ${err.message}`
                : '❌ An unexpected error occurred while loading quota configuration.';

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(errorMsg);
                } else {
                    await interaction.reply({ content: errorMsg, ephemeral: true });
                }
            } catch { }
        }
    },
};

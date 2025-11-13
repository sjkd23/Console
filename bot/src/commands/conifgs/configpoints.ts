// bot/src/commands/configpoints.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { BackendError } from '../../lib/http.js';
import { buildConfigPointsPanel } from '../../lib/configpoints-panel.js';

/**
 * /configpoints - Configure raider points for dungeons
 * Opens an interactive panel to configure how many points raiders earn for completing each dungeon.
 * This is guild-wide configuration (not role-specific like quota points).
 * Moderator+ command.
 */
export const configpoints: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('configpoints')
        .setDescription('Configure raider points for dungeons (Moderator+)')
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

            // Build config panel using helper function
            const { embed, buttons } = await buildConfigPointsPanel(interaction.guildId!, interaction.user.id);

            await interaction.editReply({
                embeds: [embed],
                components: [buttons],
            });

        } catch (err) {
            console.error('configpoints command error:', err);
            
            const errorMsg = err instanceof BackendError
                ? `❌ Failed to load raider points configuration: ${err.message}`
                : '❌ An unexpected error occurred while loading raider points configuration.';

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

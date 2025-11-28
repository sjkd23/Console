import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    Message,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { BackendError } from '../../lib/utilities/http.js';
import { buildQuotaConfigPanel } from '../../lib/ui/quota-config-panel.js';
import { createLogger } from '../../lib/logging/logger.js';

const logger = createLogger('ConfigQuota');
const CONFIG_PANEL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

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

            // Build config panel using helper function
            const { embed, buttons } = await buildQuotaConfigPanel(interaction.guildId!, role.id, interaction.user.id);

            const reply = await interaction.editReply({
                embeds: [embed],
                components: buttons,
            });

            // Schedule automatic button removal after 10 minutes
            setTimeout(async () => {
                try {
                    // Fetch the message to ensure it still exists
                    const message = reply instanceof Message ? reply : await interaction.fetchReply();
                    
                    // Remove all components (buttons)
                    await message.edit({
                        components: []
                    });

                    logger.debug('Removed buttons from expired config panel', {
                        guildId: interaction.guildId,
                        roleId: role.id,
                        messageId: message.id
                    });
                } catch (err) {
                    // Message might have been deleted or bot lacks permissions
                    logger.debug('Could not remove buttons from expired config panel', {
                        guildId: interaction.guildId,
                        roleId: role.id,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }, CONFIG_PANEL_EXPIRY_MS);

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

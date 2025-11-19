// bot/src/commands/conifgs/configrolepings.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    MessageFlags,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { setDungeonRolePing, getDungeonRolePings, BackendError } from '../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { handleDungeonAutocomplete } from '../../lib/utilities/dungeon-autocomplete.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { logCommandExecution, logConfigChange } from '../../lib/logging/bot-logger.js';

/**
 * /configrolepings - Configure which role to ping when creating runs/headcounts for specific dungeons
 * Allows moderators to set up @here + custom role pings for specific dungeon types.
 * Moderator+ command.
 */
export const configrolepings: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('configrolepings')
        .setDescription('Configure role pings for dungeon runs (Moderator+)')
        .addStringOption(o =>
            o.setName('dungeon')
                .setDescription('Choose a dungeon')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addRoleOption(o =>
            o.setName('role')
                .setDescription('Role to ping (leave empty to remove)')
                .setRequired(false)
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

            // Fetch member for actor_roles
            let member: GuildMember;
            try {
                member = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again in a moment.');
                return;
            }

            // Get dungeon and role
            const dungeonCode = interaction.options.getString('dungeon', true);
            const role = interaction.options.getRole('role');

            // Validate dungeon
            const dungeon = dungeonByCode[dungeonCode];
            if (!dungeon) {
                await interaction.editReply('❌ Invalid dungeon selected. Please try again.');
                return;
            }

            // Backend call
            const result = await setDungeonRolePing(interaction.guildId!, {
                actor_user_id: interaction.user.id,
                dungeon_key: dungeonCode,
                discord_role_id: role?.id ?? null,
                actor_roles: getMemberRoleIds(member),
                actor_has_admin_permission: member.permissions.has('Administrator'),
            });

            // Log the command execution
            try {
                await logCommandExecution(
                    interaction.client,
                    interaction,
                    {
                        success: true,
                        details: {
                            dungeon_key: dungeonCode,
                            dungeon_name: dungeon.dungeonName,
                            role_id: role?.id ?? 'none',
                            role_name: role?.name ?? 'removed',
                        }
                    }
                );
            } catch (e) {
                console.error('Failed to log configrolepings command execution:', e);
            }

            // Log the config change
            try {
                await logConfigChange(
                    interaction.client,
                    interaction.guildId!,
                    'Dungeon Role Ping',
                    interaction.user.id,
                    {
                        [`${dungeon.dungeonName}`]: {
                            old: undefined,
                            new: role?.name ?? 'removed'
                        }
                    }
                );
            } catch (e) {
                console.error('Failed to log config change:', e);
            }

            // Success message
            if (role) {
                await interaction.editReply(
                    `✅ **Configuration Updated**\n\n` +
                    `When creating runs or headcounts for **${dungeon.dungeonName}**, the bot will now ping:\n` +
                    `• @here\n` +
                    `• ${role}\n\n` +
                    `This takes effect immediately for all new runs and headcounts.`
                );
            } else {
                await interaction.editReply(
                    `✅ **Configuration Updated**\n\n` +
                    `Removed custom role ping for **${dungeon.dungeonName}**.\n` +
                    `The bot will only ping @here for this dungeon.`
                );
            }

        } catch (err) {
            console.error('configrolepings command error:', err);

            const errorMsg = err instanceof BackendError
                ? `❌ Failed to update dungeon role ping configuration: ${err.message}`
                : '❌ An unexpected error occurred while updating the configuration.';

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(errorMsg);
                } else {
                    await interaction.reply(errorMsg);
                }
            } catch { }
        }
    },

    // Autocomplete handler
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    }
};

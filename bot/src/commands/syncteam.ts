// bot/src/commands/syncteam.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { syncTeamRoleForGuild } from '../lib/team-role-manager.js';

/**
 * /syncteam - Manually sync Team role for all members in the guild
 * This is useful after setting up the Team role for the first time
 * or when you want to ensure all members have the correct Team role status
 */
export const syncteam: SlashCommand = {
    requiredRole: 'administrator',
    data: new SlashCommandBuilder()
        .setName('syncteam')
        .setDescription('Sync Team role for all members in this server (Administrator)')
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction) {
        // Guild-only check
        if (!interaction.guild || !interaction.guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Defer reply immediately (permission check done by middleware)
        await interaction.deferReply();

        try {
            // Start sync
            await interaction.editReply('⏳ Starting Team role sync for all members...\n\nThis may take a moment depending on server size.');
            
            // Sync all members
            await syncTeamRoleForGuild(interaction.guildId, interaction.client);
            
            await interaction.editReply('✅ Team role sync completed!\n\nAll members have been checked and the Team role has been assigned or removed as needed.');
        } catch (error) {
            console.error('syncteam command error:', error);
            await interaction.editReply('❌ An error occurred while syncing Team roles. Check the logs for details.');
        }
    },
};

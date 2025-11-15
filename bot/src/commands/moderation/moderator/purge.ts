// bot/src/commands/moderation/moderator/purge.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
    TextChannel,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';

/**
 * /purge - Delete messages in the current channel
 * Moderator+ command
 */
export const purge: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete messages in this channel (Moderator+)')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Number of messages to delete (max 25)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(25)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction) {
        try {
            // Guild-only check
            if (!interaction.guild || !interaction.guildId) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Check if channel is text-based
            if (!interaction.channel || !interaction.channel.isTextBased()) {
                await interaction.reply({
                    content: '❌ This command can only be used in text channels.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Get the amount
            const amount = interaction.options.getInteger('amount', true);

            // Defer reply (ephemeral so it doesn't get caught in the purge)
            await interaction.deferReply({ ephemeral: true });

            try {
                // Fetch messages
                const messages = await interaction.channel.messages.fetch({ limit: amount });

                // Filter out pinned messages
                const unpinnedMessages = messages.filter(msg => !msg.pinned);

                if (unpinnedMessages.size === 0) {
                    await interaction.editReply('❌ No messages to delete (all messages are pinned or none found).');
                    return;
                }

                // Bulk delete the messages
                const deleted = await (interaction.channel as TextChannel).bulkDelete(unpinnedMessages, true);

                // Send success message
                await interaction.editReply(
                    `✅ Successfully deleted **${deleted.size}** message${deleted.size !== 1 ? 's' : ''}.` +
                    (unpinnedMessages.size > deleted.size 
                        ? `\n⚠️ Note: Some messages were older than 14 days and could not be deleted.` 
                        : '')
                );
            } catch (err) {
                console.error('[Purge] Error deleting messages:', err);
                
                let errorMessage = '❌ Failed to delete messages.\n\n';
                
                if (err instanceof Error) {
                    if (err.message.includes('Missing Permissions')) {
                        errorMessage += 'The bot does not have the **Manage Messages** permission in this channel.';
                    } else if (err.message.includes('Missing Access')) {
                        errorMessage += 'The bot does not have access to this channel.';
                    } else {
                        errorMessage += `Error: ${err.message}`;
                    }
                } else {
                    errorMessage += 'An unexpected error occurred. Messages may be too old (older than 14 days cannot be bulk deleted).';
                }
                
                await interaction.editReply(errorMessage);
            }
        } catch (unhandled) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            } catch { }
            console.error('[Purge] Unhandled error:', unhandled);
        }
    },
};

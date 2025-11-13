// bot/src/commands/moderation/addnote.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    time,
    TimestampStyles,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { canActorTargetMember, getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { createNote, BackendError } from '../../lib/http.js';

/**
 * /addnote - Add a silent staff note to a member
 * Security+ command (staff only)
 */
export const addnote: SlashCommand = {
    requiredRole: 'security',
    data: new SlashCommandBuilder()
        .setName('addnote')
        .setDescription('Add a staff note to a member (Security+ only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to add a note for')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('note')
                .setDescription('The note text')
                .setRequired(true)
                .setMaxLength(1000)
        )
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

            // Defer reply early
            await interaction.deferReply();

            // Fetch members
            const invokerMember = await interaction.guild.members.fetch(interaction.user.id);

            // Get options
            const targetUser = interaction.options.getUser('member', true);
            const noteText = interaction.options.getString('note', true).trim();

            // Can't add note for yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot add a note for yourself.');
                return;
            }

            // Can't add notes for bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot add notes for bots.');
                return;
            }

            // Ensure target is in this guild
            let targetMember;
            try {
                targetMember = await interaction.guild.members.fetch(targetUser.id);
            } catch {
                await interaction.editReply(`❌ <@${targetUser.id}> is not a member of this server.`);
                return;
            }

            // Role hierarchy check
            const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
                allowSelf: false
            });
            if (!targetCheck.canTarget) {
                await interaction.editReply(targetCheck.reason!);
                return;
            }

            try {
                // Create note in backend
                const note = await createNote({
                    actor_user_id: interaction.user.id,
                    guild_id: interaction.guildId,
                    user_id: targetUser.id,
                    note_text: noteText,
                    actor_roles: getMemberRoleIds(invokerMember),
                });

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle('📝 Staff Note Added')
                    .setColor(0x3498db)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'Note ID', value: `\`${note.id}\``, inline: true },
                        { name: 'Added By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Note', value: noteText }
                    )
                    .setFooter({ text: '💡 Use /checkpunishments to view all notes and punishments for a member' })
                    .setTimestamp();

                await interaction.editReply({ embeds: [responseEmbed] });
            } catch (err) {
                let errorMessage = '❌ **Failed to add note**\n\n';

                if (err instanceof BackendError) {
                    switch (err.code) {
                        case 'NOT_AUTHORIZED':
                            errorMessage += '**Issue:** You don\'t have the Security role configured for this server.\n\n';
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Ask a server admin to use `/setroles` to set up the Security role\n';
                            errorMessage += '• Make sure you have the Discord role that\'s mapped to Security';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• Note must be 1-1000 characters\n';
                            errorMessage += '• All required fields must be provided';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[AddNote] Unexpected error:', err);
                    errorMessage += 'An unexpected error occurred. Please try again later.';
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
            console.error('[AddNote] Unhandled error:', unhandled);
        }
    },
};

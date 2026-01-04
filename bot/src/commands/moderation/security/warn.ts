// bot/src/commands/warn.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    time,
    TimestampStyles,
    TextChannel,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { canActorTargetMember, getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { createPunishment, BackendError, getGuildChannels, awardModerationPointsWithUpdate } from '../../../lib/utilities/http.js';

/**
 * /warn - Issue a warning to a member
 * Security+ command
 */
export const warn: SlashCommand = {
    requiredRole: 'security',
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issue a warning to a member (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to warn')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the warning')
                .setRequired(true)
                .setMaxLength(500)
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
            const reason = interaction.options.getString('reason', true).trim();

            // Can't warn yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot warn yourself.');
                return;
            }

            // Can't warn bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot warn bots.');
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

            // Note: Role hierarchy is bypassed for warn command

            try {
                // Create punishment in backend
                const punishment = await createPunishment({
                    actor_user_id: interaction.user.id,
                    guild_id: interaction.guildId,
                    user_id: targetUser.id,
                    type: 'warn',
                    reason,
                    actor_roles: getMemberRoleIds(invokerMember),
                });

                // Try to DM the user
                let dmSent = false;
                try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Warning')
                    .setDescription(`You received a warning in **${interaction.guild.name}**.`)
                    .setColor(0xffa500)
                    .addFields(
                        { name: 'Reason', value: reason },
                        { name: 'Issued By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Warning ID', value: `\`${punishment.id}\``, inline: true },
                        { name: 'Date', value: time(new Date(punishment.created_at), TimestampStyles.LongDateTime) }
                    )
                    .setFooter({ text: 'Please follow server rules to avoid future warnings' })
                    .setTimestamp();                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[Warn] Failed to DM user ${targetUser.id}:`, dmErr);
                }

            // Build success response
            const responseEmbed = new EmbedBuilder()
                .setTitle('⚠️ Warning Issued')
                .setColor(0xffa500)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Warning ID', value: `\`${punishment.id}\``, inline: true },
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason }
                )
                .setFooter({ text: dmSent ? 'User notified via DM' : 'Could not DM user' })
                .setTimestamp();                await interaction.editReply({ embeds: [responseEmbed] });

                // Award moderation points if configured
                try {
                    const moderationPointsResult = await awardModerationPointsWithUpdate(
                        interaction.client,
                        interaction.guildId,
                        interaction.user.id,
                        {
                            actor_user_id: interaction.user.id,
                            actor_roles: getMemberRoleIds(invokerMember),
                            command_type: 'warn',
                        }
                    );
                    
                    if (moderationPointsResult.points_awarded > 0) {
                        console.log(`[Warn] Awarded ${moderationPointsResult.points_awarded} moderation points to ${interaction.user.id}`);
                    }
                } catch (pointsErr) {
                    // Non-critical, don't block the command
                    console.warn('[Warn] Failed to award moderation points:', pointsErr);
                }

                // Log to punishment_log channel if configured
                try {
                    const { channels } = await getGuildChannels(interaction.guildId);
                    const punishmentLogChannelId = channels.punishment_log;

                    if (punishmentLogChannelId) {
                        const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                        if (logChannel && logChannel.isTextBased()) {
                            const logEmbed = new EmbedBuilder()
                                .setTitle('⚠️ Warning Issued')
                                .setColor(0xffa500)
                                .addFields(
                                    { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Warning ID', value: `\`${punishment.id}\``, inline: true },
                                    { name: 'Moderator', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                    { name: 'Reason', value: reason }
                                )
                                .setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[Warn] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to issue warning**\n\n';

                if (err instanceof BackendError) {
                    switch (err.code) {
                        case 'NOT_AUTHORIZED':
                        case 'NOT_SECURITY':
                            // This shouldn't happen since middleware already checked permissions
                            // But if it does, it's likely a backend configuration issue
                            errorMessage += '**Issue:** Authorization failed on the backend.\n\n';
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• This is likely a server configuration issue\n';
                            errorMessage += '• Contact a server administrator if this persists';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• Reason must be 1-500 characters\n';
                            errorMessage += '• All required fields must be provided';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[Warn] Unexpected error:', err);
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
            console.error('[Warn] Unhandled error:', unhandled);
        }
    },
};

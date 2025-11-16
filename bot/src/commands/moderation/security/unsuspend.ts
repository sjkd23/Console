// bot/src/commands/unsuspend.ts
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
import { getMemberRoleIds, canBotManageRole, canActorTargetMember } from '../../../lib/permissions/permissions.js';
import { getUserPunishments, removePunishment, BackendError, getGuildChannels, getGuildRoles } from '../../../lib/utilities/http.js';

/**
 * /unsuspend - Remove an active suspension from a member
 * Security+ command
 * Deactivates the suspension and removes the suspended role
 */
export const unsuspend: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('unsuspend')
        .setDescription('Remove an active suspension from a member (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to unsuspend')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for removing the suspension')
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

            // Fetch invoker member
            const invokerMember = await interaction.guild.members.fetch(interaction.user.id);

            // Get options
            const targetUser = interaction.options.getUser('member', true);
            const reason = interaction.options.getString('reason', true).trim();

            // Can't unsuspend yourself (shouldn't happen but check anyway)
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot unsuspend yourself.');
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

            // Role hierarchy and bot position check
            const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
                allowSelf: false,
                checkBotPosition: true
            });
            if (!targetCheck.canTarget) {
                await interaction.editReply(targetCheck.reason!);
                return;
            }

            try {
                // Get active suspensions for this user
                const { punishments } = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    true // active only
                );

                // Filter to only active suspensions
                const activeSuspensions = punishments.filter(
                    p => p.type === 'suspend' && p.active
                );

                if (activeSuspensions.length === 0) {
                    await interaction.editReply(`❌ **No Active Suspension**\n\n<@${targetUser.id}> does not have any active suspensions.\n\nUse \`/checkpunishments\` to view their punishment history.`);
                    return;
                }

                // If multiple active suspensions (shouldn't happen often), use the most recent
                const suspension = activeSuspensions.sort(
                    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                )[0];

                // Check if this is an old-format punishment ID (numeric instead of 24-char hex)
                const isOldFormat = typeof suspension.id === 'string' && 
                                   (suspension.id.length !== 24 || !/^[0-9a-f]{24}$/.test(suspension.id));

                if (isOldFormat) {
                    await interaction.editReply(
                        `❌ **Cannot Process Old Suspension**\n\n` +
                        `This suspension (ID: \`${suspension.id}\`) was created with an old system and cannot be removed using this command.\n\n` +
                        `**What to do:**\n` +
                        `• The suspension will automatically expire at ${suspension.expires_at ? time(new Date(suspension.expires_at), TimestampStyles.RelativeTime) : 'an unknown time'}\n` +
                        `• Ask an administrator to run the database migration to update old punishment records\n` +
                        `• Or manually remove the suspended role from the user`
                    );
                    return;
                }

                // Remove the suspension via backend
                const result = await removePunishment(suspension.id, {
                    actor_user_id: interaction.user.id,
                    removal_reason: reason,
                    actor_roles: getMemberRoleIds(invokerMember),
                });

                // Remove the suspended role
                let roleRemoved = false;
                let roleError = '';
                try {
                    const { roles } = await getGuildRoles(interaction.guildId);
                    const suspendedRoleId = roles.suspended;

                    if (suspendedRoleId) {
                        if (targetMember.roles.cache.has(suspendedRoleId)) {
                            await targetMember.roles.remove(suspendedRoleId, `Unsuspended by ${interaction.user.tag}`);
                            roleRemoved = true;
                        } else {
                            roleError = 'User did not have suspended role';
                        }
                    } else {
                        roleError = 'Suspended role not configured';
                    }
                } catch (roleErr: any) {
                    if (roleErr?.code === 50013) {
                        roleError = 'Missing permissions to remove role';
                        console.warn(`[Unsuspend] Cannot remove suspended role: Missing Permissions`);
                    } else {
                        roleError = 'Failed to remove role';
                        console.warn(`[Unsuspend] Failed to remove suspended role:`, roleErr?.message || roleErr);
                    }
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('✅ Suspension Removed')
                        .setDescription(`Your suspension has been removed in **${interaction.guild.name}**.`)
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Reason', value: reason },
                            { name: 'Original Suspension Reason', value: result.reason }
                        )
                        .setFooter({ text: 'You can now participate in raids again.' })
                        .setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[Unsuspend] Failed to DM user ${targetUser.id}:`, dmErr);
                }

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle('✅ Member Unsuspended')
                    .setColor(0x00ff00)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'Suspension ID', value: `\`${suspension.id}\``, inline: true },
                        { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Reason', value: reason },
                        { name: 'Original Suspension Reason', value: result.reason }
                    )
                    .setTimestamp();

                const warnings = [];
                if (roleRemoved) {
                    warnings.push('✓ Suspended role removed');
                } else if (roleError) {
                    warnings.push(`⚠️ Role: ${roleError}`);
                }
                if (!dmSent) {
                    warnings.push('⚠️ Could not DM user');
                } else {
                    warnings.push('✓ User notified via DM');
                }

                if (warnings.length > 0) {
                    responseEmbed.setFooter({ text: warnings.join(' | ') });
                }

                await interaction.editReply({ embeds: [responseEmbed] });

                // Log to punishment_log channel if configured
                try {
                    const { channels } = await getGuildChannels(interaction.guildId);
                    const punishmentLogChannelId = channels.punishment_log;

                    if (punishmentLogChannelId) {
                        const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                        if (logChannel && logChannel.isTextBased()) {
                            const logEmbed = new EmbedBuilder()
                                .setTitle('✅ Member Unsuspended')
                                .setColor(0x00ff00)
                                .addFields(
                                    { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Suspension ID', value: `\`${suspension.id}\``, inline: true },
                                    { name: 'Moderator', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'Role Removed', value: roleRemoved ? '✅ Yes' : `❌ No${roleError ? ` (${roleError})` : ''}`, inline: true },
                                    { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                    { name: 'Reason', value: reason },
                                    { name: 'Original Suspension Reason', value: result.reason }
                                )
                                .setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[Unsuspend] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to unsuspend member**\n\n';

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
                        case 'PUNISHMENT_NOT_FOUND':
                            errorMessage += '**Issue:** The suspension could not be found or has already been removed.\n\n';
                            errorMessage += 'The user may not have an active suspension.';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• Reason must be 1-500 characters';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[Unsuspend] Unexpected error:', err);
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
            console.error('[Unsuspend] Unhandled error:', unhandled);
        }
    },
};

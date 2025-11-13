// bot/src/commands/removepunishment.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    time,
    TimestampStyles,
    TextChannel,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds, canBotManageRole } from '../../lib/permissions/permissions.js';
import { removePunishment, getPunishment, BackendError, getGuildChannels, getGuildRoles } from '../../lib/http.js';

/**
 * /removepunishment - Permanently remove a punishment from records
 * Officer+ command
 * Used to clear warnings, expired suspensions, or already-lifted suspensions from the database
 * For active suspensions, use /unsuspend instead
 */
export const removepunishment: SlashCommand = {
    requiredRole: 'officer',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('removepunishment')
        .setDescription('Remove a punishment from records (Officer+)')
        .addStringOption(option =>
            option
                .setName('id')
                .setDescription('The punishment ID to remove (24 character code)')
                .setRequired(true)
                .setMinLength(24)
                .setMaxLength(24)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for removing this record')
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
            const punishmentId = interaction.options.getString('id', true).trim().toLowerCase();
            const removalReason = interaction.options.getString('reason', true).trim();

            // Validate ID format (24 character hex string)
            if (!/^[0-9a-f]{24}$/.test(punishmentId)) {
                await interaction.editReply('❌ **Invalid Punishment ID**\n\nPunishment IDs must be 24 character hexadecimal codes.\n\nExample: `a1b2c3d4e5f6789012345678`');
                return;
            }

            try {
                // Get the punishment first to check it exists and get details
                const punishment = await getPunishment(punishmentId);

                // Verify punishment is from this guild
                if (punishment.guild_id !== interaction.guildId) {
                    await interaction.editReply(`❌ Punishment \`${punishmentId}\` does not exist in this server.`);
                    return;
                }

                // Check if already inactive
                if (!punishment.active) {
                    await interaction.editReply(`❌ Punishment \`${punishmentId}\` has already been removed.\n\nRemoved by: <@${punishment.removed_by}>\nRemoval date: ${time(new Date(punishment.removed_at!), TimestampStyles.LongDateTime)}\nReason: ${punishment.removal_reason}`);
                    return;
                }

                // Check if this is an active suspension - should use /unsuspend instead
                if (punishment.type === 'suspend' && punishment.expires_at) {
                    const expiresAt = new Date(punishment.expires_at);
                    const now = new Date();
                    
                    if (expiresAt > now) {
                        // This is an active suspension that hasn't expired yet
                        await interaction.editReply(
                            `❌ **Cannot Remove Active Suspension**\n\n` +
                            `Punishment \`${punishmentId}\` is an active suspension.\n\n` +
                            `**To remove an active suspension:**\n` +
                            `• Use \`/unsuspend\` to lift the suspension immediately\n\n` +
                            `**About /removepunishment:**\n` +
                            `This command is for removing:\n` +
                            `• Warnings (active or inactive)\n` +
                            `• Expired suspensions\n` +
                            `• Already-lifted suspensions\n\n` +
                            `This clears the punishment from records entirely.`
                        );
                        return;
                    }
                }

                // Remove the punishment via backend
                const result = await removePunishment(punishmentId, {
                    actor_user_id: interaction.user.id,
                    removal_reason: removalReason,
                    actor_roles: getMemberRoleIds(invokerMember),
                });

                // If this was a suspension, remove the suspended role
                let roleRemoved = false;
                let roleError = '';
                if (result.type === 'suspend') {
                    try {
                        const { roles } = await getGuildRoles(interaction.guildId);
                        const suspendedRoleId = roles.suspended;

                        if (suspendedRoleId) {
                            const targetMember = await interaction.guild.members.fetch(result.user_id);
                            if (targetMember.roles.cache.has(suspendedRoleId)) {
                                await targetMember.roles.remove(suspendedRoleId, `Suspension removed by ${interaction.user.tag} - ${punishmentId}`);
                                roleRemoved = true;
                            } else {
                                roleError = 'User did not have suspended role';
                            }
                        }
                    } catch (roleErr: any) {
                        if (roleErr?.code === 50013) {
                            roleError = 'Missing permissions to remove role';
                            console.warn(`[RemovePunishment] Cannot remove suspended role: Missing Permissions`);
                        } else if (roleErr?.code === 10007) {
                            roleError = 'User not found (may have left server)';
                            console.warn(`[RemovePunishment] User not found:`, roleErr?.message || roleErr);
                        } else {
                            roleError = 'Failed to remove role';
                            console.warn(`[RemovePunishment] Failed to remove suspended role:`, roleErr?.message || roleErr);
                        }
                    }
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const targetUser = await interaction.client.users.fetch(result.user_id);
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('✅ Punishment Removed')
                        .setDescription(`A ${result.type === 'warn' ? 'warning' : 'suspension'} has been removed from your record in **${interaction.guild.name}**.`)
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Original Punishment ID', value: `\`${punishmentId}\``, inline: true },
                            { name: 'Type', value: result.type === 'warn' ? 'Warning' : 'Suspension', inline: true },
                            { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Removal Reason', value: removalReason },
                            { name: 'Original Reason', value: result.reason }
                        )
                        .setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[RemovePunishment] Failed to DM user ${result.user_id}:`, dmErr);
                }

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle('✅ Punishment Removed')
                    .setColor(0x00ff00)
                    .addFields(
                        { name: 'Punishment ID', value: `\`${punishmentId}\``, inline: true },
                        { name: 'Type', value: result.type === 'warn' ? 'Warning' : 'Suspension', inline: true },
                        { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                        { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Removal Reason', value: removalReason },
                        { name: 'Original Reason', value: result.reason }
                    )
                    .setTimestamp();

                const warnings = [];
                if (result.type === 'suspend') {
                    if (roleRemoved) {
                        warnings.push('✓ Suspended role removed');
                    } else if (roleError) {
                        warnings.push(`⚠️ Role: ${roleError}`);
                    }
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
                            const targetUser = await interaction.client.users.fetch(result.user_id);
                            const logEmbed = new EmbedBuilder()
                                .setTitle('✅ Punishment Removed')
                                .setColor(0x00ff00)
                                .addFields(
                                    { name: 'Punishment ID', value: `\`${punishmentId}\``, inline: true },
                                    { name: 'Type', value: result.type === 'warn' ? 'Warning' : 'Suspension', inline: true },
                                    { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: result.user_id, inline: true },
                                    { name: 'Removed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true }
                                );

                            if (result.type === 'suspend') {
                                logEmbed.addFields({ 
                                    name: 'Role Removed', 
                                    value: roleRemoved ? '✅ Yes' : `❌ No${roleError ? ` (${roleError})` : ''}`, 
                                    inline: true 
                                });
                            }

                            logEmbed.addFields(
                                { name: 'Removal Reason', value: removalReason },
                                { name: 'Original Reason', value: result.reason }
                            );

                            logEmbed.setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[RemovePunishment] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to remove punishment**\n\n';

                if (err instanceof BackendError) {
                    switch (err.code) {
                        case 'NOT_AUTHORIZED':
                            errorMessage += '**Issue:** You don\'t have the Moderator role configured for this server.\n\n';
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Ask a server admin to use `/setroles` to set up the Moderator role\n';
                            errorMessage += '• Make sure you have the Discord role that\'s mapped to Moderator';
                            break;
                        case 'PUNISHMENT_NOT_FOUND':
                            errorMessage += `**Issue:** Punishment \`${punishmentId}\` does not exist.\n\n`;
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Check the punishment ID is correct\n';
                            errorMessage += '• Use `/checkpunishments` to view existing punishments';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• Removal reason must be 1-500 characters\n';
                            errorMessage += '• Punishment ID must be valid\n';
                            errorMessage += '• Punishment must be active';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[RemovePunishment] Unexpected error:', err);
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
            console.error('[RemovePunishment] Unhandled error:', unhandled);
        }
    },
};

// bot/src/commands/moderation/security/unmute.ts
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
 * /unmute - Remove an active mute from a member
 * Security+ command
 * Deactivates the mute and removes the muted role
 */
export const unmute: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove an active mute from a member (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to unmute')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for removing the mute')
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

            // Can't unmute yourself (shouldn't happen but check anyway)
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot unmute yourself.');
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
                // Get active mutes for this user
                const { punishments } = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    true // active only
                );

                // Filter to only active mutes
                const activeMutes = punishments.filter(
                    p => p.type === 'mute' && p.active
                );

                if (activeMutes.length === 0) {
                    await interaction.editReply(`❌ **No Active Mute**\n\n<@${targetUser.id}> does not have any active mutes.\n\nUse \`/checkpunishments\` to view their punishment history.`);
                    return;
                }

                // Use the most recent active mute
                const muteToRemove = activeMutes[0];
                const muteExpiry = muteToRemove.expires_at ? new Date(muteToRemove.expires_at) : null;

                // Remove the mute in backend
                await removePunishment(muteToRemove.id, {
                    actor_user_id: interaction.user.id,
                    removal_reason: reason,
                    actor_roles: getMemberRoleIds(invokerMember),
                });

                // Try to remove the muted role
                let roleRemoved = false;
                let roleError = '';
                try {
                    const { roles } = await getGuildRoles(interaction.guildId);
                    const mutedRoleId = roles.muted;

                    if (mutedRoleId) {
                        // Check if bot can manage the role
                        const botRoleCheck = await canBotManageRole(interaction.guild, mutedRoleId);
                        if (!botRoleCheck.canManage) {
                            roleError = 'Bot cannot manage muted role';
                            console.warn(`[Unmute] ${botRoleCheck.reason}`);
                        } else if (targetMember.roles.cache.has(mutedRoleId)) {
                            await targetMember.roles.remove(mutedRoleId, `Unmuted by ${interaction.user.tag} - ${muteToRemove.id}`);
                            roleRemoved = true;
                        } else {
                            // User doesn't have the role anyway
                            roleRemoved = true;
                        }
                    } else {
                        roleError = 'No muted role configured';
                    }
                } catch (roleErr: any) {
                    roleError = roleErr?.message || 'Unknown error';
                    console.warn(`[Unmute] Failed to remove muted role:`, roleErr);
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('🔊 Mute Removed')
                        .setDescription(`Your mute has been removed in **${interaction.guild.name}**.`)
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Reason for Removal', value: reason },
                            { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Original Mute ID', value: `\`${muteToRemove.id}\``, inline: true }
                        );

                    if (muteExpiry) {
                        const wasExpired = muteExpiry < new Date();
                        dmEmbed.addFields({
                            name: 'Original Expiry',
                            value: wasExpired 
                                ? `${time(muteExpiry, TimestampStyles.RelativeTime)} (was expired)`
                                : time(muteExpiry, TimestampStyles.RelativeTime),
                            inline: true
                        });
                    }

                    dmEmbed.setFooter({ text: 'You can now send messages in this server.' });
                    dmEmbed.setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[Unmute] Failed to DM user ${targetUser.id}:`, dmErr);
                }

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle('🔊 Mute Removed')
                    .setColor(0x00ff00)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'Mute ID', value: `\`${muteToRemove.id}\``, inline: true },
                        { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true }
                    );

                if (muteExpiry) {
                    const wasExpired = muteExpiry < new Date();
                    responseEmbed.addFields({
                        name: 'Original Expiry',
                        value: wasExpired 
                            ? `${time(muteExpiry, TimestampStyles.RelativeTime)} (was expired)`
                            : time(muteExpiry, TimestampStyles.RelativeTime),
                        inline: true
                    });
                }

                responseEmbed.addFields(
                    { name: 'Reason', value: reason }
                );

                const warnings = [];
                if (!roleRemoved) {
                    warnings.push(`⚠️ Role: ${roleError}`);
                }
                if (!dmSent) {
                    warnings.push('⚠️ Could not DM user (DMs may be disabled)');
                }

                if (warnings.length > 0) {
                    responseEmbed.setFooter({ text: warnings.join(' | ') });
                } else {
                    responseEmbed.setFooter({ text: '✓ Muted role removed | ✓ User notified via DM' });
                }

                responseEmbed.setTimestamp();

                await interaction.editReply({ embeds: [responseEmbed] });

                // Log to punishment_log channel if configured
                try {
                    const { channels } = await getGuildChannels(interaction.guildId);
                    const punishmentLogChannelId = channels.punishment_log;

                    if (punishmentLogChannelId) {
                        const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                        if (logChannel && logChannel.isTextBased()) {
                            const logEmbed = new EmbedBuilder()
                                .setTitle('🔊 Mute Removed')
                                .setColor(0x00ff00)
                                .addFields(
                                    { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Mute ID', value: `\`${muteToRemove.id}\``, inline: true },
                                    { name: 'Removed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'Role Removed', value: roleRemoved ? '✅ Yes' : `❌ No (${roleError})`, inline: true },
                                    { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true }
                                );

                            if (muteExpiry) {
                                const wasExpired = muteExpiry < new Date();
                                logEmbed.addFields({
                                    name: 'Original Expiry',
                                    value: wasExpired 
                                        ? `${time(muteExpiry, TimestampStyles.LongDateTime)} (was expired)`
                                        : time(muteExpiry, TimestampStyles.LongDateTime),
                                    inline: false
                                });
                            }

                            logEmbed.addFields({ name: 'Reason', value: reason });
                            logEmbed.setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[Unmute] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to unmute member**\n\n';

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
                        case 'NOT_FOUND':
                            errorMessage += 'The mute record could not be found. It may have already been removed or expired.';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}`;
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[Unmute] Unexpected error:', err);
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
            console.error('[Unmute] Unhandled error:', unhandled);
        }
    },
};

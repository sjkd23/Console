




















// bot/src/commands/moderation/security/mute.ts
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
import { canActorTargetMember, getMemberRoleIds, canBotManageRole } from '../../../lib/permissions/permissions.js';
import { createPunishment, getUserPunishments, removePunishment, BackendError, getGuildChannels, getGuildRoles } from '../../../lib/utilities/http.js';

/**
 * /mute - Temporarily mute a member from sending messages
 * Security+ command
 * Assigns the 'muted' role and removes it after the duration expires
 */
export const mute: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Temporarily mute a member from sending messages (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to mute')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('duration')
                .setDescription('Mute duration (e.g., 30m for 30 minutes, 5h for 5 hours, 2d for 2 days)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the mute')
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
            const durationStr = interaction.options.getString('duration', true).trim().toLowerCase();
            const reason = interaction.options.getString('reason', true).trim();

            // Parse duration string (e.g., "30m", "5h" or "2d")
            const durationMatch = durationStr.match(/^(\d+)(m|h|d)$/);
            if (!durationMatch) {
                await interaction.editReply('❌ **Invalid Duration Format**\n\nPlease use format like:\n• `30m` for 30 minutes\n• `5h` for 5 hours\n• `2d` for 2 days\n• `30d` for 30 days (maximum)');
                return;
            }

            const durationValue = parseInt(durationMatch[1], 10);
            const durationUnit = durationMatch[2];

            // Convert to minutes
            let durationMinutes: number;
            if (durationUnit === 'm') {
                durationMinutes = durationValue;
            } else if (durationUnit === 'h') {
                durationMinutes = durationValue * 60;
            } else { // 'd'
                durationMinutes = durationValue * 24 * 60;
            }

            // Validate duration (min 1 minute, max 30 days = 43200 minutes)
            if (durationMinutes < 1) {
                await interaction.editReply('❌ Duration must be at least 1 minute.');
                return;
            }
            if (durationMinutes > 43200) {
                await interaction.editReply('❌ Duration cannot exceed 30 days (43200 minutes).');
                return;
            }

            // Format duration for display
            let durationDisplay: string;
            if (durationUnit === 'm') {
                durationDisplay = `${durationValue} minute${durationValue !== 1 ? 's' : ''}`;
            } else if (durationUnit === 'h') {
                durationDisplay = `${durationValue} hour${durationValue !== 1 ? 's' : ''}`;
            } else {
                durationDisplay = `${durationValue} day${durationValue !== 1 ? 's' : ''}`;
            }

            // Can't mute yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot mute yourself.');
                return;
            }

            // Can't mute bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot mute bots.');
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

            // Check if muted role is configured
            let mutedRoleId: string | null = null;
            try {
                const { roles } = await getGuildRoles(interaction.guildId);
                mutedRoleId = roles.muted;

                if (!mutedRoleId) {
                    await interaction.editReply('❌ **Muted Role Not Configured**\n\nThe muted role has not been set up for this server.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the `muted` role\n• This role will be automatically assigned to muted members');
                    return;
                }

                // Check if the role exists in Discord
                const roleExists = await interaction.guild.roles.fetch(mutedRoleId);
                if (!roleExists) {
                    await interaction.editReply(`❌ **Muted Role Not Found**\n\nThe configured muted role (<@&${mutedRoleId}>) no longer exists in this server.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to update the muted role`);
                    return;
                }

                // Check if bot can manage this role
                const botRoleCheck = await canBotManageRole(interaction.guild, mutedRoleId);
                if (!botRoleCheck.canManage) {
                    await interaction.editReply(`❌ **Cannot Manage Role**\n\n${botRoleCheck.reason}`);
                    return;
                }
            } catch (roleCheckErr) {
                console.error('[Mute] Failed to check muted role:', roleCheckErr);
                await interaction.editReply('❌ Failed to verify role configuration. Please try again.');
                return;
            }

            try {
                // Check if user already has an active mute
                const { punishments } = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    true // active only
                );

                const activeMute = punishments.find(
                    (p: any) => p.type === 'mute' && p.active
                );

                let isExtension = false;
                let originalExpiresAt: Date | null = null;
                let additionalTime = '';
                let extendedDurationMinutes = durationMinutes; // Default to the input duration

                if (activeMute && activeMute.expires_at) {
                    // User already muted - we'll extend it
                    isExtension = true;
                    originalExpiresAt = new Date(activeMute.expires_at);
                    
                    // Calculate new expiration by adding duration to existing expiration
                    additionalTime = durationDisplay;

                    // Calculate the extended expiration time (original + additional time)
                    const newExpiresAt = new Date(originalExpiresAt.getTime() + durationMinutes * 60 * 1000);
                    
                    // Calculate duration from NOW to the new expiration
                    const now = new Date();
                    const durationFromNow = newExpiresAt.getTime() - now.getTime();
                    extendedDurationMinutes = Math.ceil(durationFromNow / (1000 * 60));

                    console.log('[Mute] Extension calculation:', {
                        original_expires: originalExpiresAt.toISOString(),
                        added_minutes: durationMinutes,
                        new_expires: newExpiresAt.toISOString(),
                        duration_from_now_minutes: extendedDurationMinutes
                    });

                    // Check if this is an old-format punishment ID (numeric instead of 24-char hex)
                    const isOldFormat = typeof activeMute.id === 'string' && 
                                       (activeMute.id.length !== 24 || !/^[0-9a-f]{24}$/.test(activeMute.id));

                    if (isOldFormat) {
                        console.warn(`[Mute] Found old-format punishment ID: ${activeMute.id}. Skipping extension, will create new mute instead.`);
                        isExtension = false;
                        originalExpiresAt = null;
                        additionalTime = '';
                        extendedDurationMinutes = durationMinutes; // Reset to original duration
                    } else {
                        // Validate the punishment ID before attempting removal
                        if (typeof activeMute.id !== 'string') {
                            console.error(`[Mute] Invalid punishment ID type: ${typeof activeMute.id}`);
                            await interaction.editReply('❌ **Internal Error**\n\nFound an invalid mute record. Please contact an administrator.');
                            return;
                        }

                        // Remove the old mute
                        await removePunishment(activeMute.id, {
                            actor_user_id: interaction.user.id,
                            removal_reason: `Extended by adding ${additionalTime}`,
                            actor_roles: getMemberRoleIds(invokerMember),
                        });
                    }
                }

                // Create mute in backend with the correct duration
                const punishmentPayload = {
                    actor_user_id: interaction.user.id,
                    guild_id: interaction.guildId,
                    user_id: targetUser.id,
                    type: 'mute' as const,
                    reason: isExtension ? `${reason} [Extended from previous mute]` : reason,
                    duration_minutes: extendedDurationMinutes,
                    actor_roles: getMemberRoleIds(invokerMember),
                };

                console.log('[Mute] Creating punishment with payload:', {
                    ...punishmentPayload,
                    actor_user_id_length: punishmentPayload.actor_user_id.length,
                    guild_id_length: punishmentPayload.guild_id.length,
                    user_id_length: punishmentPayload.user_id.length,
                    reason_length: punishmentPayload.reason.length,
                });

                const punishment = await createPunishment(punishmentPayload);

                // Calculate expiration date from the punishment
                const expiresAt = new Date(punishment.expires_at!);

                // Assign muted role
                let roleAdded = false;
                let roleError = '';
                try {
                    await targetMember.roles.add(mutedRoleId, `Muted by ${interaction.user.tag} - ${punishment.id}`);
                    roleAdded = true;
                } catch (roleErr: any) {
                    if (roleErr?.code === 50013) {
                        roleError = 'Missing permissions to assign role';
                        console.warn(`[Mute] Cannot assign muted role: Missing Permissions`);
                    } else if (roleErr?.code === 50013) {
                        // User already has the role (likely from existing mute)
                        roleAdded = true;
                    } else {
                        roleError = 'Failed to assign role';
                        console.warn(`[Mute] Failed to assign muted role:`, roleErr?.message || roleErr);
                    }
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle(isExtension ? '🔇 Mute Extended' : '🔇 Mute Notice')
                        .setDescription(isExtension 
                            ? `Your mute has been extended in **${interaction.guild.name}**.`
                            : `You have been muted from sending messages in **${interaction.guild.name}**.`)
                        .setColor(0xff6600)
                        .addFields(
                            { name: 'Reason', value: reason }
                        );

                    if (isExtension && originalExpiresAt) {
                        dmEmbed.addFields(
                            { name: 'Additional Time Added', value: additionalTime, inline: true },
                            { name: 'Previous Expiration', value: time(originalExpiresAt, TimestampStyles.LongDateTime), inline: false },
                            { name: 'New Expiration', value: time(expiresAt, TimestampStyles.LongDateTime), inline: false }
                        );
                    } else {
                        dmEmbed.addFields(
                            { name: 'Duration', value: durationDisplay, inline: true },
                            { name: 'Expires', value: time(expiresAt, TimestampStyles.RelativeTime), inline: true }
                        );
                    }

                    dmEmbed.addFields(
                        { name: 'Issued By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Mute ID', value: `\`${punishment.id}\``, inline: true },
                        { name: 'Date', value: time(new Date(punishment.created_at), TimestampStyles.LongDateTime) }
                    );

                    dmEmbed.setFooter({ text: 'The mute will be automatically lifted when it expires.' });
                    dmEmbed.setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[Mute] Failed to DM user ${targetUser.id}:`, dmErr);
                }

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle(isExtension ? '🔇 Mute Extended' : '🔇 Member Muted')
                    .setColor(0xff6600)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'Mute ID', value: `\`${punishment.id}\``, inline: true },
                        { name: isExtension ? 'Additional Time' : 'Duration', value: durationDisplay, inline: true }
                    );

                if (isExtension && originalExpiresAt) {
                    responseEmbed.addFields(
                        { name: 'Previous Expiration', value: time(originalExpiresAt, TimestampStyles.RelativeTime), inline: true },
                        { name: 'New Expiration', value: time(expiresAt, TimestampStyles.RelativeTime), inline: true }
                    );
                } else {
                    responseEmbed.addFields(
                        { name: 'Expires', value: time(expiresAt, TimestampStyles.RelativeTime), inline: true }
                    );
                }

                responseEmbed.addFields(
                    { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason }
                );
                responseEmbed.setTimestamp();

                const warnings = [];
                if (!roleAdded) {
                    warnings.push(`⚠️ Role: ${roleError}`);
                }
                if (!dmSent) {
                    warnings.push('⚠️ Could not DM user (DMs may be disabled)');
                }

                if (warnings.length > 0) {
                    responseEmbed.setFooter({ text: warnings.join(' | ') });
                } else {
                    responseEmbed.setFooter({ text: '✓ Muted role assigned | ✓ User notified via DM' });
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
                                .setTitle(isExtension ? '🔇 Mute Extended' : '🔇 Member Muted')
                                .setColor(0xff6600)
                                .addFields(
                                    { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Mute ID', value: `\`${punishment.id}\``, inline: true }
                                );

                            if (isExtension && originalExpiresAt) {
                                logEmbed.addFields(
                                    { name: 'Action', value: '⏱️ **Mute Extended**', inline: false },
                                    { name: 'Additional Time', value: additionalTime, inline: true },
                                    { name: 'Previous Expiration', value: time(originalExpiresAt, TimestampStyles.LongDateTime), inline: false },
                                    { name: 'New Expiration', value: time(expiresAt, TimestampStyles.LongDateTime), inline: false }
                                );
                            } else {
                                logEmbed.addFields(
                                    { name: 'Duration', value: durationDisplay, inline: true },
                                    { name: 'Expires', value: time(expiresAt, TimestampStyles.LongDateTime), inline: true }
                                );
                            }

                            logEmbed.addFields(
                                { name: 'Moderator', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'Role Assigned', value: roleAdded ? '✅ Yes' : `❌ No (${roleError})`, inline: true },
                                { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Reason', value: reason }
                            );
                            logEmbed.setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[Mute] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to mute member**\n\n';

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
                            errorMessage += '• Duration format: `30m` (minutes), `5h` (hours), or `2d` (days)\n';
                            errorMessage += '• Maximum duration: 30 days\n';
                            errorMessage += '• All required fields must be provided';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[Mute] Unexpected error:', err);
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
            console.error('[Mute] Unhandled error:', unhandled);
        }
    },
};

// bot/src/commands/suspend.ts
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
import { canActorTargetMember, getMemberRoleIds, canBotManageRole } from '../../lib/permissions/permissions.js';
import { createPunishment, getUserPunishments, removePunishment, BackendError, getGuildChannels, getGuildRoles } from '../../lib/http.js';

/**
 * /suspend - Temporarily suspend a member from raid participation
 * Moderator-only command
 * Assigns the 'suspended' role and removes it after the duration expires
 */
export const suspend: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('suspend')
        .setDescription('Temporarily suspend a member from raids (Moderator only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to suspend')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('duration')
                .setDescription('Suspension duration (e.g., 5h for 5 hours, 2d for 2 days)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the suspension')
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

            // Parse duration string (e.g., "5h" or "2d")
            const durationMatch = durationStr.match(/^(\d+)(h|d)$/);
            if (!durationMatch) {
                await interaction.editReply('❌ **Invalid Duration Format**\n\nPlease use format like:\n• `5h` for 5 hours\n• `2d` for 2 days\n• `30d` for 30 days (maximum)');
                return;
            }

            const durationValue = parseInt(durationMatch[1], 10);
            const durationUnit = durationMatch[2];

            // Convert to hours
            let durationHours: number;
            if (durationUnit === 'h') {
                durationHours = durationValue;
            } else { // 'd'
                durationHours = durationValue * 24;
            }

            // Validate duration (max 30 days = 720 hours)
            if (durationHours < 1) {
                await interaction.editReply('❌ Duration must be at least 1 hour.');
                return;
            }
            if (durationHours > 720) {
                await interaction.editReply('❌ Duration cannot exceed 30 days (720 hours).');
                return;
            }

            // Can't suspend yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot suspend yourself.');
                return;
            }

            // Can't suspend bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot suspend bots.');
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

            // Check if suspended role is configured
            let suspendedRoleId: string | null = null;
            try {
                const { roles } = await getGuildRoles(interaction.guildId);
                suspendedRoleId = roles.suspended;

                if (!suspendedRoleId) {
                    await interaction.editReply('❌ **Suspended Role Not Configured**\n\nThe suspended role has not been set up for this server.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the `suspended` role\n• This role will be automatically assigned to suspended members');
                    return;
                }

                // Check if the role exists in Discord
                const roleExists = await interaction.guild.roles.fetch(suspendedRoleId);
                if (!roleExists) {
                    await interaction.editReply(`❌ **Suspended Role Not Found**\n\nThe configured suspended role (<@&${suspendedRoleId}>) no longer exists in this server.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to update the suspended role`);
                    return;
                }

                // Check if bot can manage this role
                const botRoleCheck = await canBotManageRole(interaction.guild, suspendedRoleId);
                if (!botRoleCheck.canManage) {
                    await interaction.editReply(`❌ **Cannot Manage Role**\n\n${botRoleCheck.reason}`);
                    return;
                }
            } catch (roleCheckErr) {
                console.error('[Suspend] Failed to check suspended role:', roleCheckErr);
                await interaction.editReply('❌ Failed to verify role configuration. Please try again.');
                return;
            }

            // Calculate duration in minutes and display format (outside try-catch for error message access)
            const durationMinutes = durationHours * 60;
            const durationDisplay = durationUnit === 'h' 
                ? `${durationValue} hour${durationValue !== 1 ? 's' : ''}`
                : `${durationValue} day${durationValue !== 1 ? 's' : ''} (${durationHours} hours)`;

            try {
                // Check if user already has an active suspension
                const { punishments } = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    true // active only
                );

                const activeSuspension = punishments.find(
                    (p: any) => p.type === 'suspend' && p.active
                );

                let isExtension = false;
                let originalExpiresAt: Date | null = null;
                let additionalTime = '';
                let extendedDurationMinutes = durationMinutes; // Default to the input duration

                if (activeSuspension && activeSuspension.expires_at) {
                    // User already suspended - we'll extend it
                    isExtension = true;
                    originalExpiresAt = new Date(activeSuspension.expires_at);
                    
                    // Calculate new expiration by adding duration to existing expiration
                    const addedTime = durationUnit === 'h' 
                        ? `${durationValue} hour${durationValue !== 1 ? 's' : ''}`
                        : `${durationValue} day${durationValue !== 1 ? 's' : ''}`;
                    additionalTime = addedTime;

                    // Calculate the extended expiration time (original + additional time)
                    const newExpiresAt = new Date(originalExpiresAt.getTime() + durationMinutes * 60 * 1000);
                    
                    // Calculate duration from NOW to the new expiration
                    const now = new Date();
                    const durationFromNow = newExpiresAt.getTime() - now.getTime();
                    extendedDurationMinutes = Math.ceil(durationFromNow / (1000 * 60));

                    console.log('[Suspend] Extension calculation:', {
                        original_expires: originalExpiresAt.toISOString(),
                        added_minutes: durationMinutes,
                        new_expires: newExpiresAt.toISOString(),
                        duration_from_now_minutes: extendedDurationMinutes
                    });

                    // Check if this is an old-format punishment ID (numeric instead of 24-char hex)
                    const isOldFormat = typeof activeSuspension.id === 'string' && 
                                       (activeSuspension.id.length !== 24 || !/^[0-9a-f]{24}$/.test(activeSuspension.id));

                    if (isOldFormat) {
                        console.warn(`[Suspend] Found old-format punishment ID: ${activeSuspension.id}. Skipping extension, will create new suspension instead.`);
                        // Don't try to remove the old one - just let it expire and create a new one
                        // The new suspension will take precedence
                        isExtension = false;
                        originalExpiresAt = null;
                        additionalTime = '';
                        extendedDurationMinutes = durationMinutes; // Reset to original duration
                    } else {
                        // Validate the punishment ID before attempting removal
                        if (typeof activeSuspension.id !== 'string') {
                            console.error(`[Suspend] Invalid punishment ID type: ${typeof activeSuspension.id}`);
                            await interaction.editReply('❌ **Internal Error**\n\nFound an invalid suspension record. Please contact an administrator.');
                            return;
                        }

                        // Remove the old suspension
                        await removePunishment(activeSuspension.id, {
                            actor_user_id: interaction.user.id,
                            removal_reason: `Extended by adding ${addedTime}`,
                            actor_roles: getMemberRoleIds(invokerMember),
                        });
                    }
                }

                // Create suspension in backend with the correct duration
                const punishmentPayload = {
                    actor_user_id: interaction.user.id,
                    guild_id: interaction.guildId,
                    user_id: targetUser.id,
                    type: 'suspend' as const,
                    reason: isExtension ? `${reason} [Extended from previous suspension]` : reason,
                    duration_minutes: extendedDurationMinutes,
                    actor_roles: getMemberRoleIds(invokerMember),
                };

                // Debug log to verify payload structure
                console.log('[Suspend] Creating punishment with payload:', {
                    ...punishmentPayload,
                    actor_user_id_length: punishmentPayload.actor_user_id.length,
                    guild_id_length: punishmentPayload.guild_id.length,
                    user_id_length: punishmentPayload.user_id.length,
                    reason_length: punishmentPayload.reason.length,
                });

                const punishment = await createPunishment(punishmentPayload);

                // Calculate expiration date from the punishment
                const expiresAt = new Date(punishment.expires_at!);

                // Assign suspended role
                let roleAdded = false;
                let roleError = '';
                try {
                    await targetMember.roles.add(suspendedRoleId, `Suspended by ${interaction.user.tag} - ${punishment.id}`);
                    roleAdded = true;
                } catch (roleErr: any) {
                    if (roleErr?.code === 50013) {
                        roleError = 'Missing permissions to assign role';
                        console.warn(`[Suspend] Cannot assign suspended role: Missing Permissions`);
                    } else if (roleErr?.code === 50013) {
                        // User already has the role (likely from existing suspension)
                        roleAdded = true;
                    } else {
                        roleError = 'Failed to assign role';
                        console.warn(`[Suspend] Failed to assign suspended role:`, roleErr?.message || roleErr);
                    }
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const durationDisplayDM = durationUnit === 'h' 
                        ? `${durationValue} hour${durationValue !== 1 ? 's' : ''}`
                        : `${durationValue} day${durationValue !== 1 ? 's' : ''}`;

                    const dmEmbed = new EmbedBuilder()
                        .setTitle(isExtension ? '🔨 Suspension Extended' : '🔨 Suspension Notice')
                        .setDescription(isExtension 
                            ? `Your suspension has been extended in **${interaction.guild.name}**.`
                            : `You have been suspended from raid participation in **${interaction.guild.name}**.`)
                        .setColor(0xff0000)
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
                            { name: 'Duration', value: durationDisplayDM, inline: true },
                            { name: 'Expires', value: time(expiresAt, TimestampStyles.RelativeTime), inline: true }
                        );
                    }

                    dmEmbed.addFields(
                        { name: 'Issued By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Suspension ID', value: `\`${punishment.id}\``, inline: true },
                        { name: 'Date', value: time(new Date(punishment.created_at), TimestampStyles.LongDateTime) }
                    );

                    dmEmbed.setFooter({ text: 'The suspension will be automatically lifted when it expires.' });
                    dmEmbed.setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[Suspend] Failed to DM user ${targetUser.id}:`, dmErr);
                }

                // Build success response
                const responseEmbed = new EmbedBuilder()
                    .setTitle(isExtension ? '🔨 Suspension Extended' : '🔨 Member Suspended')
                    .setColor(0xff0000)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'Suspension ID', value: `\`${punishment.id}\``, inline: true },
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
                    responseEmbed.setFooter({ text: '✓ Suspended role assigned | ✓ User notified via DM' });
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
                                .setTitle(isExtension ? '🔨 Suspension Extended' : '🔨 Member Suspended')
                                .setColor(0xff0000)
                                .addFields(
                                    { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Suspension ID', value: `\`${punishment.id}\``, inline: true }
                                );

                            if (isExtension && originalExpiresAt) {
                                logEmbed.addFields(
                                    { name: 'Action', value: '⏱️ **Suspension Extended**', inline: false },
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
                    console.warn(`[Suspend] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to suspend member**\n\n';

                if (err instanceof BackendError) {
                    switch (err.code) {
                        case 'NOT_AUTHORIZED':
                            errorMessage += '**Issue:** You don\'t have the Moderator role configured for this server.\n\n';
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Ask a server admin to use `/setroles` to set up the Moderator role\n';
                            errorMessage += '• Make sure you have the Discord role that\'s mapped to Moderator';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• Reason must be 1-500 characters\n';
                            errorMessage += '• Duration format: `5h` (hours) or `2d` (days)\n';
                            errorMessage += '• Maximum duration: 30 days\n';
                            errorMessage += '• All required fields must be provided';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[Suspend] Unexpected error:', err);
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
            console.error('[Suspend] Unhandled error:', unhandled);
        }
    },
};

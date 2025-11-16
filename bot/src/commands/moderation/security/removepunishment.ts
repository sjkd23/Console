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
import type { SlashCommand } from '../../_types.js';
import { getMemberRoleIds, canBotManageRole } from '../../../lib/permissions/permissions.js';
import { 
    removePunishment, 
    getPunishment, 
    BackendError, 
    getGuildChannels, 
    getGuildRoles,
    getNote,
    removeNote
} from '../../../lib/utilities/http.js';

/**
 * /removepunishment - Permanently remove a punishment or note from records
 * Security+ command
 * Used to clear warnings, suspensions, mutes, or notes from the database
 * Can remove both active and inactive punishments (active suspensions will unsuspend immediately)
 */
export const removepunishment: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('removepunishment')
        .setDescription('Remove a punishment or note from records (Security+)')
        .addStringOption(option =>
            option
                .setName('id')
                .setDescription('The punishment/note ID to remove (24 character code)')
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
            const recordId = interaction.options.getString('id', true).trim().toLowerCase();
            const removalReason = interaction.options.getString('reason', true).trim();

            // Validate ID format (24 character hex string)
            if (!/^[0-9a-f]{24}$/.test(recordId)) {
                await interaction.editReply('❌ **Invalid ID Format**\n\nIDs must be 24 character hexadecimal codes.\n\nExample: `a1b2c3d4e5f6789012345678`');
                return;
            }

            try {
                // Try to get as punishment first
                let isPunishment = true;
                let isNote = false;
                let record: any;

                try {
                    record = await getPunishment(recordId);
                } catch (punishmentErr) {
                    if (punishmentErr instanceof BackendError && punishmentErr.code === 'PUNISHMENT_NOT_FOUND') {
                        // Not a punishment, try note
                        isPunishment = false;
                        try {
                            record = await getNote(recordId);
                            isNote = true;
                        } catch (noteErr) {
                            if (noteErr instanceof BackendError && noteErr.code === 'NOTE_NOT_FOUND') {
                                await interaction.editReply(`❌ **Record Not Found**\n\nNo punishment or note with ID \`${recordId}\` exists.\n\nMake sure you're using the correct 24-character ID.`);
                                return;
                            }
                            throw noteErr;
                        }
                    } else {
                        throw punishmentErr;
                    }
                }

                // Verify record is from this guild
                if (record.guild_id !== interaction.guildId) {
                    await interaction.editReply(`❌ ${isNote ? 'Note' : 'Punishment'} \`${recordId}\` does not exist in this server.`);
                    return;
                }

                // Handle note removal
                if (isNote) {
                    const result = await removeNote(recordId, {
                        actor_user_id: interaction.user.id,
                        removal_reason: removalReason,
                        actor_roles: getMemberRoleIds(invokerMember),
                        actor_has_admin: invokerMember.permissions.has('Administrator'),
                    });

                    // Try to DM the user
                    let dmSent = false;
                    try {
                        const targetUser = await interaction.client.users.fetch(result.user_id);
                        const dmEmbed = new EmbedBuilder()
                            .setTitle('✅ Note Removed')
                            .setDescription(`A staff note has been removed from your record in **${interaction.guild.name}**.`)
                            .setColor(0x00ff00)
                            .addFields(
                                { name: 'Note ID', value: `\`${recordId}\``, inline: true },
                                { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Removal Reason', value: removalReason },
                                { name: 'Original Note', value: result.note_text }
                            )
                            .setTimestamp();

                        await targetUser.send({ embeds: [dmEmbed] });
                        dmSent = true;
                    } catch (dmErr) {
                        console.warn(`[RemovePunishment] Failed to DM user ${result.user_id}:`, dmErr);
                    }

                    // Build success response
                    const responseEmbed = new EmbedBuilder()
                        .setTitle('✅ Note Removed')
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Note ID', value: `\`${recordId}\``, inline: true },
                            { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                            { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Removal Reason', value: removalReason },
                            { name: 'Original Note', value: result.note_text }
                        )
                        .setFooter({ text: dmSent ? '✓ User notified via DM' : '⚠️ Could not DM user' })
                        .setTimestamp();

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
                                    .setTitle('✅ Note Removed')
                                    .setColor(0x00ff00)
                                    .addFields(
                                        { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                        { name: 'User ID', value: result.user_id, inline: true },
                                        { name: 'Note ID', value: `\`${recordId}\``, inline: true },
                                        { name: 'Removed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                        { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                        { name: 'Removal Reason', value: removalReason },
                                        { name: 'Original Note', value: result.note_text }
                                    )
                                    .setTimestamp();

                                await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                            }
                        }
                    } catch (logErr) {
                        console.warn(`[RemovePunishment] Failed to log to punishment_log channel:`, logErr);
                    }

                    return;
                }

                // Handle punishment removal
                const punishment = record;

                // Check if this is an active suspension - track for warning message
                let wasActiveSuspension = false;
                if (punishment.active && punishment.type === 'suspend' && punishment.expires_at) {
                    const expiresAt = new Date(punishment.expires_at);
                    const now = new Date();
                    
                    if (expiresAt > now) {
                        wasActiveSuspension = true;
                    }
                }

                // Track if punishment was already inactive (for display purposes)
                const wasAlreadyInactive = !punishment.active;

                // Remove the punishment via backend
                const result = await removePunishment(recordId, {
                    actor_user_id: interaction.user.id,
                    removal_reason: removalReason,
                    actor_roles: getMemberRoleIds(invokerMember),
                    actor_has_admin: invokerMember.permissions.has('Administrator'),
                });

                // If this was a suspension or mute, try to remove the role
                let roleRemoved = false;
                let roleError = '';
                if (result.type === 'suspend' || result.type === 'mute') {
                    try {
                        const { roles } = await getGuildRoles(interaction.guildId);
                        const roleId = result.type === 'suspend' ? roles.suspended : roles.muted;

                        if (roleId) {
                            const targetMember = await interaction.guild.members.fetch(result.user_id);
                            if (targetMember.roles.cache.has(roleId)) {
                                await targetMember.roles.remove(roleId, `${result.type === 'suspend' ? 'Suspension' : 'Mute'} removed by ${interaction.user.tag} - ${recordId}`);
                                roleRemoved = true;
                            } else {
                                roleRemoved = true; // User doesn't have role
                            }
                        }
                    } catch (roleErr: any) {
                        if (roleErr?.code === 50013) {
                            roleError = 'Missing permissions to remove role';
                            console.warn(`[RemovePunishment] Cannot remove role: Missing Permissions`);
                        } else if (roleErr?.code === 10007) {
                            roleError = 'User not found (may have left server)';
                            console.warn(`[RemovePunishment] User not found:`, roleErr?.message || roleErr);
                        } else {
                            roleError = 'Failed to remove role';
                            console.warn(`[RemovePunishment] Failed to remove role:`, roleErr?.message || roleErr);
                        }
                    }
                }

                // Try to DM the user
                let dmSent = false;
                try {
                    const targetUser = await interaction.client.users.fetch(result.user_id);
                    const typeLabel = result.type === 'warn' ? 'warning' : result.type === 'suspend' ? 'suspension' : 'mute';
                    const dmEmbed = new EmbedBuilder()
                        .setTitle('✅ Punishment Removed from Record')
                        .setDescription(`A ${typeLabel} has been removed from your record in **${interaction.guild.name}**.`)
                        .setColor(0x00ff00)
                        .addFields(
                            { name: 'Punishment ID', value: `\`${recordId}\``, inline: true },
                            { name: 'Type', value: typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1), inline: true },
                            { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Removal Reason', value: removalReason },
                            { name: 'Original Reason', value: result.reason }
                        )
                        .setTimestamp();

                    if (wasActiveSuspension) {
                        dmEmbed.setFooter({ text: 'This was an active suspension that has now been lifted.' });
                    } else if (wasAlreadyInactive) {
                        dmEmbed.setFooter({ text: 'This punishment was already inactive and has been cleared from your record.' });
                    }

                    await targetUser.send({ embeds: [dmEmbed] });
                    dmSent = true;
                } catch (dmErr) {
                    console.warn(`[RemovePunishment] Failed to DM user ${result.user_id}:`, dmErr);
                }

                // Build success response
                const typeLabel = result.type === 'warn' ? 'Warning' : result.type === 'suspend' ? 'Suspension' : 'Mute';
                const responseEmbed = new EmbedBuilder()
                    .setTitle(`✅ ${typeLabel} Removed from Record`)
                    .setColor(0x00ff00)
                    .addFields(
                        { name: 'Punishment ID', value: `\`${recordId}\``, inline: true },
                        { name: 'Type', value: typeLabel, inline: true },
                        { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                        { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Removal Reason', value: removalReason },
                        { name: 'Original Reason', value: result.reason }
                    )
                    .setTimestamp();

                if (wasActiveSuspension) {
                    responseEmbed.addFields({
                        name: '⚠️ Note',
                        value: 'This was an active suspension. The user has been immediately unsuspended.'
                    });
                } else if (wasAlreadyInactive) {
                    responseEmbed.addFields({
                        name: 'ℹ️ Status',
                        value: 'This punishment was already inactive and has been removed from the record.'
                    });
                }

                const warnings = [];
                if (result.type === 'suspend' || result.type === 'mute') {
                    if (roleRemoved) {
                        warnings.push(`✓ ${result.type === 'suspend' ? 'Suspended' : 'Muted'} role removed`);
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
                                .setTitle(`✅ ${typeLabel} Removed`)
                                .setColor(0x00ff00)
                                .addFields(
                                    { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: result.user_id, inline: true },
                                    { name: 'Punishment ID', value: `\`${recordId}\``, inline: true },
                                    { name: 'Type', value: typeLabel, inline: true },
                                    { name: 'Removed By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true }
                                );

                            if (result.type === 'suspend' || result.type === 'mute') {
                                logEmbed.addFields({
                                    name: 'Role Removed',
                                    value: roleRemoved ? '✅ Yes' : `❌ No${roleError ? ` (${roleError})` : ''}`,
                                    inline: true
                                });
                            }

                            logEmbed.addFields(
                                { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Removal Reason', value: removalReason },
                                { name: 'Original Reason', value: result.reason }
                            );

                            if (wasActiveSuspension) {
                                logEmbed.addFields({
                                    name: '⚠️ Note',
                                    value: 'This was an active suspension'
                                });
                            } else if (wasAlreadyInactive) {
                                logEmbed.addFields({
                                    name: 'ℹ️ Status',
                                    value: 'Punishment was already inactive - removed from record'
                                });
                            }

                            logEmbed.setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.warn(`[RemovePunishment] Failed to log to punishment_log channel:`, logErr);
                }
            } catch (err) {
                let errorMessage = '❌ **Failed to remove record**\n\n';

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
                        case 'NOTE_NOT_FOUND':
                            errorMessage += '**Issue:** The record could not be found or has already been removed.\n\n';
                            errorMessage += 'The punishment or note may not exist.';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += '**Requirements:**\n';
                            errorMessage += '• ID must be a 24-character hexadecimal code\n';
                            errorMessage += '• Reason must be 1-500 characters';
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

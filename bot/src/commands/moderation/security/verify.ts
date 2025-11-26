// bot/src/commands/verify.ts
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
import { verifyRaider, BackendError, getGuildChannels, getRaider, getGuildRoles, awardModerationPointsWithUpdate } from '../../../lib/utilities/http.js';
import { logCommandExecution, logVerificationAction } from '../../../lib/logging/bot-logger.js';
import { createLogger } from '../../../lib/logging/logger.js';

const logger = createLogger('Verify');

/**
 * /verify - Manually verify a Discord member with their ROTMG IGN.
 * Staff-only command (Security role required).
 * Writes to the backend raider table: ign, status='approved', verified_at=NOW().
 */
export const verify: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Manually verify a member with their ROTMG IGN (Security only)')
        .addUserOption(option =>
            option
                .setName('member')                .setDescription('The Discord member to verify')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('ign')
                .setDescription('The member\'s ROTMG in-game name')
                .setRequired(true)
        ),

    async run(interaction: ChatInputCommandInteraction) {
        // Must be in a guild
        if (!interaction.guild || !interaction.guildId) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Fetch invoker member (permission check done by middleware)
        const invokerMember = await interaction.guild.members.fetch(interaction.user.id);

        // Get options
        const targetUser = interaction.options.getUser('member', true);
        const ign = interaction.options.getString('ign', true).trim();

        // Basic IGN validation (lightweight)
        if (!ign || ign.length === 0) {
            await interaction.reply({
                content: 'IGN cannot be empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (ign.length > 16) {
            await interaction.reply({
                content: 'IGN must be 16 characters or less.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (!/^[A-Za-z0-9 _-]+$/.test(ign)) {
            await interaction.reply({
                content: 'IGN can only contain letters, numbers, spaces, - or _.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Ensure target is in this guild
        let targetMember;
        try {
            targetMember = await interaction.guild.members.fetch(targetUser.id);
        } catch {
            await interaction.reply({
                content: `<@${targetUser.id}> is not a member of this server.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Defer reply (backend call may take a moment)
        await interaction.deferReply();

        // Check if user is already verified
        let existingRaider = null;
        try {
            existingRaider = await getRaider(interaction.guildId, targetUser.id);
            if (existingRaider && existingRaider.status === 'approved') {
                await interaction.editReply(`❌ **Already Verified**\n\n<@${targetUser.id}> is already verified with IGN \`${existingRaider.ign}\`.\n\nUse \`/editname\` if you need to update their IGN.`);
                return;
            }
        } catch (checkErr) {
            logger.warn('Failed to check existing raider', { 
                guildId: interaction.guildId,
                targetUserId: targetUser.id,
                error: checkErr instanceof Error ? checkErr.message : String(checkErr)
            });
            // Continue anyway - don't block on check failure
        }

        // Check if we can change nickname (based on role hierarchy)
        // Allow verification of anyone, but only change nickname if they're lower in hierarchy
        let canChangeNickname = true;
        try {
            const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
                allowSelf: false,
                checkBotPosition: true
            });
            canChangeNickname = targetCheck.canTarget;
        } catch (hierarchyErr) {
            logger.warn('Role hierarchy check failed', { 
                guildId: interaction.guildId,
                actorId: interaction.user.id,
                targetId: targetUser.id,
                error: hierarchyErr instanceof Error ? hierarchyErr.message : String(hierarchyErr)
            });
            canChangeNickname = false;
        }

        // Check if verified_raider role is configured
        let verifiedRaiderRoleId: string | null = null;
        try {
            const { roles } = await getGuildRoles(interaction.guildId);
            verifiedRaiderRoleId = roles.verified_raider;
            
            if (!verifiedRaiderRoleId) {
                await interaction.editReply('❌ **Verified Raider Role Not Configured**\n\nThe verified raider role has not been set up for this server.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the `verified_raider` role\n• This role will be automatically assigned to verified members');
                return;
            }

            // Check if the role exists in Discord
            const roleExists = await interaction.guild.roles.fetch(verifiedRaiderRoleId);
            if (!roleExists) {
                await interaction.editReply(`❌ **Verified Raider Role Not Found**\n\nThe configured verified raider role (<@&${verifiedRaiderRoleId}>) no longer exists in this server.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to update the verified_raider role`);
                return;
            }

            // Check if bot can manage this role
            const botRoleCheck = await canBotManageRole(interaction.guild, verifiedRaiderRoleId);
            if (!botRoleCheck.canManage) {
                await interaction.editReply(`❌ **Cannot Manage Role**\n\n${botRoleCheck.reason}`);
                return;
            }
        } catch (roleCheckErr) {
            logger.error('Failed to check verified_raider role', { 
                guildId: interaction.guildId,
                verifiedRaiderRoleId,
                error: roleCheckErr instanceof Error ? roleCheckErr.message : String(roleCheckErr)
            });
            await interaction.editReply('❌ Failed to verify role configuration. Please try again.');
            return;
        }

        try {
            // Get actor's role IDs for authorization
            const actorRoles = getMemberRoleIds(invokerMember);
            logger.debug('Actor roles retrieved for verification', { 
                guildId: interaction.guildId,
                actorId: interaction.user.id, 
                roleCount: actorRoles.length 
            });
            
            // Call backend to verify raider
            const result = await verifyRaider({
                actor_user_id: interaction.user.id,
                actor_roles: actorRoles,
                guild_id: interaction.guildId,
                user_id: targetUser.id,
                ign,
            });

            // Update the member's nickname to their IGN
            let nicknameUpdated = true;
            let nicknameError = '';
            try {
                // Only change nickname if hierarchy allows it
                if (canChangeNickname) {
                    // Check if they have an alt IGN and preserve it
                    const nickname = existingRaider?.alt_ign 
                        ? `${result.ign} | ${existingRaider.alt_ign}`
                        : result.ign;
                    await targetMember.setNickname(nickname, `Verified by ${interaction.user.tag}`);
                } else {
                    nicknameUpdated = false;
                    nicknameError = 'User has higher or equal role (hierarchy protection)';
                }
            } catch (nickErr: any) {
                nicknameUpdated = false;
                // If we can't change nickname (e.g., user has higher role or bot lacks permission), log but don't fail
                if (nickErr?.code === 50013) {
                    nicknameError = 'Missing permissions (user may have a higher role than the bot)';
                    logger.warn('Cannot set nickname for verified user - Missing Permissions', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        ign: result.ign
                    });
                } else {
                    nicknameError = 'Unknown error';
                    logger.warn('Failed to set nickname for verified user', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        error: nickErr?.message || String(nickErr)
                    });
                }
            }

            // Add verified raider role
            let roleAdded = false;
            let roleError = '';
            try {
                if (verifiedRaiderRoleId) {
                    await targetMember.roles.add(verifiedRaiderRoleId, `Verified by ${interaction.user.tag}`);
                    roleAdded = true;
                }
            } catch (roleErr: any) {
                if (roleErr?.code === 50013) {
                    roleError = 'Missing permissions to assign role';
                    logger.warn('Cannot assign verified raider role - Missing Permissions', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        roleId: verifiedRaiderRoleId
                    });
                } else {
                    roleError = 'Failed to assign role';
                    logger.warn('Failed to assign verified raider role', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        roleId: verifiedRaiderRoleId,
                        error: roleErr?.message || String(roleErr)
                    });
                }
            }

            // Build success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ Member Verified')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                    { name: 'IGN', value: `\`${result.ign}\``, inline: true },
                    { name: 'Verified By', value: `<@${interaction.user.id}>`, inline: true },
                    {
                        name: 'Timestamp',
                        value: time(new Date(result.verified_at), TimestampStyles.RelativeTime),
                        inline: true,
                    }
                )
                .setTimestamp();

            const warnings = [];
            if (!nicknameUpdated) {
                warnings.push(`⚠️ Nickname: ${nicknameError}`);
            }
            if (!roleAdded) {
                warnings.push(`⚠️ Role: ${roleError}`);
            }

            if (warnings.length > 0) {
                embed.setFooter({ text: warnings.join(' | ') });
            } else if (roleAdded) {
                embed.setFooter({ text: '✓ Verified raider role assigned' });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Award moderation points if configured
            try {
                const moderationPointsResult = await awardModerationPointsWithUpdate(
                    interaction.client,
                    interaction.guildId,
                    interaction.user.id,
                    {
                        actor_user_id: interaction.user.id,
                        actor_roles: actorRoles,
                        command_type: 'verify',
                    }
                );
                
                if (moderationPointsResult.points_awarded > 0) {
                    logger.info('Awarded moderation points for verification', { 
                        guildId: interaction.guildId,
                        actorId: interaction.user.id,
                        pointsAwarded: moderationPointsResult.points_awarded
                    });
                }
            } catch (modPointsErr) {
                // Non-critical error - log but don't fail the verification
                logger.warn('Failed to award moderation points', { 
                    guildId: interaction.guildId,
                    actorId: interaction.user.id,
                    error: modPointsErr instanceof Error ? modPointsErr.message : String(modPointsErr)
                });
            }

            // Log to bot-log (brief since detailed log goes to veri_log)
            await logVerificationAction(
                interaction.client,
                interaction.guildId,
                'verified',
                interaction.user.id,
                targetUser.id,
                ign
            );
            await logCommandExecution(interaction.client, interaction, { success: true });

            // Log to veri_log channel if configured
            try {
                const { channels } = await getGuildChannels(interaction.guildId);
                const veriLogChannelId = channels.veri_log;
                
                if (veriLogChannelId) {
                    const veriLogChannel = await interaction.guild.channels.fetch(veriLogChannelId);
                    
                    if (veriLogChannel && veriLogChannel.isTextBased()) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('✅ Member Verified')
                            .setColor(0x00ff00)
                            .addFields(
                                { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: result.user_id, inline: true },
                                { name: 'IGN', value: `\`${result.ign}\``, inline: true },
                                { name: 'Verified By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'Status', value: result.status, inline: true },
                                {
                                    name: 'Timestamp',
                                    value: time(new Date(result.verified_at), TimestampStyles.LongDateTime),
                                    inline: true,
                                }
                            )
                            .setTimestamp();

                        await (veriLogChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                // Don't fail the command if logging fails, just log the error
                logger.warn('Failed to log verification to veri_log channel', { 
                    guildId: interaction.guildId,
                    targetUserId: targetUser.id,
                    ign,
                    error: logErr instanceof Error ? logErr.message : String(logErr)
                });
            }
        } catch (err) {
            // Map backend errors to user-friendly messages
            let errorMessage = '❌ **Failed to verify member**\n\n';
            
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
                    case 'IGN_ALREADY_IN_USE':
                        errorMessage += '**Issue:** This IGN is already linked to another Discord account.\n\n';
                        
                        // Try to get conflict user info from error data
                        const conflictUserId = err.data?.conflictUserId;
                        const conflictIgn = err.data?.conflictIgn || ign;
                        
                        if (conflictUserId) {
                            errorMessage += `The IGN "${conflictIgn}" is currently in use by <@${conflictUserId}>.\n\n`;
                            
                            // Try to fetch user tag for additional context
                            try {
                                const conflictUser = await interaction.client.users.fetch(conflictUserId);
                                errorMessage += `**Discord Tag:** ${conflictUser.tag}\n`;
                                errorMessage += `**User ID:** ${conflictUserId}\n\n`;
                            } catch {
                                errorMessage += `**User ID:** ${conflictUserId}\n\n`;
                            }
                            
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Verify this is the correct IGN\n';
                            errorMessage += '• Check if the mentioned user is still in the server\n';
                            errorMessage += '• If the user left, try again (auto-cleanup may apply)\n';
                            errorMessage += '• Contact an admin for account transfers or corrections';
                        } else {
                            errorMessage += `${err.message}\n\n`;
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• Verify the correct IGN spelling\n';
                            errorMessage += '• Contact an admin if this is an error or account transfer';
                        }
                        break;
                    case 'VALIDATION_ERROR':
                        errorMessage += '**Issue:** The IGN provided is invalid.\n\n';
                        errorMessage += '**Requirements:**\n';
                        errorMessage += '• 1-16 characters long\n';
                        errorMessage += '• Only letters, numbers, spaces, hyphens (-), or underscores (_)';
                        break;
                    default:
                        errorMessage += `**Error:** ${err.message}\n\n`;
                        errorMessage += 'Please try again or contact an administrator if the problem persists.';
                }
            } else {
                logger.error('Verify command error', { 
                    guildId: interaction.guildId,
                    actorId: interaction.user.id,
                    targetId: targetUser.id,
                    ign,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined
                });
                errorMessage += 'An unexpected error occurred. Please try again later.';
            }

            await interaction.editReply(errorMessage);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: err instanceof BackendError ? err.code : 'Unknown error'
            });
        }
    },
};

// bot/src/commands/unverify.ts
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
import { unverifyRaider, BackendError, getGuildChannels, getRaider, getGuildRoles } from '../../../lib/utilities/http.js';
import { logCommandExecution, logVerificationAction } from '../../../lib/logging/bot-logger.js';

/**
 * /unverify - Remove a user from the verification system.
 * Staff-only command (Security role required).
 * Completely removes the raider from the database, freeing up their IGN.
 * Also removes verified raider role and nickname.
 */
export const unverify: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('unverify')
        .setDescription('Remove a member from the verification system (Security only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The Discord member to unverify')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for unverifying (optional)')
                .setRequired(false)
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
        const reason = interaction.options.getString('reason') || 'No reason provided';

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

        // Check if user is verified
        let existingRaider;
        try {
            existingRaider = await getRaider(interaction.guildId, targetUser.id);
            if (!existingRaider) {
                await interaction.editReply(`❌ **Not Verified**\n\n<@${targetUser.id}> is not in the verification system.`);
                return;
            }
            if (existingRaider.status !== 'approved') {
                await interaction.editReply(`❌ **Not Verified**\n\n<@${targetUser.id}> is not currently verified (status: ${existingRaider.status}).`);
                return;
            }
        } catch (checkErr) {
            console.error('[Unverify] Failed to check existing raider:', checkErr);
            await interaction.editReply('❌ Failed to check verification status. Please try again.');
            return;
        }

        // Check role hierarchy: actor must outrank target
        const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
            allowSelf: false,
            checkBotPosition: true
        });
        
        if (!targetCheck.canTarget) {
            await interaction.editReply(targetCheck.reason || '❌ You cannot unverify this member.');
            return;
        }

        try {
            // Get actor's role IDs for authorization
            const actorRoles = getMemberRoleIds(invokerMember);
            
            // Call backend to completely remove raider from database
            const result = await unverifyRaider(interaction.guildId, targetUser.id, {
                actor_user_id: interaction.user.id,
                actor_roles: actorRoles,
                reason,
            });

            // Remove nickname (revert to Discord username)
            let nicknameRemoved = false;
            let nicknameError = '';
            try {
                if (targetMember.nickname) {
                    await targetMember.setNickname(null, `Unverified by ${interaction.user.tag}`);
                    nicknameRemoved = true;
                }
            } catch (nickErr: any) {
                if (nickErr?.code === 50013) {
                    nicknameError = 'Missing permissions';
                    console.warn(`[Unverify] Cannot remove nickname for ${targetUser.id}: Missing Permissions`);
                } else {
                    nicknameError = 'Unknown error';
                    console.warn(`[Unverify] Failed to remove nickname for ${targetUser.id}:`, nickErr?.message || nickErr);
                }
            }

            // Remove all roles the bot can manage
            const rolesRemovalSummary = {
                removedCount: 0,
                failedCount: 0,
                skippedCount: 0,
                errors: [] as string[],
                removedRoles: [] as string[], // Track role mentions for display
            };

            // Get all roles except @everyone
            const rolesToRemove = targetMember.roles.cache.filter(role => role.id !== interaction.guildId);

            if (rolesToRemove.size > 0) {
                for (const [roleId, role] of rolesToRemove) {
                    try {
                        // Check if bot can manage this specific role
                        const botCanManage = await canBotManageRole(interaction.guild, roleId);
                        
                        if (!botCanManage.canManage) {
                            rolesRemovalSummary.skippedCount++;
                            console.warn(`[Unverify] Cannot remove role ${role.name} (${roleId}): ${botCanManage.reason}`);
                            continue;
                        }

                        await targetMember.roles.remove(roleId, `Unverified by ${interaction.user.tag}`);
                        rolesRemovalSummary.removedCount++;
                        rolesRemovalSummary.removedRoles.push(`<@&${roleId}>`);
                    } catch (roleErr: any) {
                        rolesRemovalSummary.failedCount++;
                        const errorMsg = roleErr?.code === 50013 ? 'Missing permissions' : 'Unknown error';
                        rolesRemovalSummary.errors.push(`${role.name}: ${errorMsg}`);
                        console.warn(`[Unverify] Failed to remove role ${role.name} (${roleId}):`, roleErr?.message || roleErr);
                    }
                }
            }

            // Build success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ Member Removed from Verification System')
                .setColor(0xff9900)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'IGN (Freed)', value: `\`${result.ign}\``, inline: true },
                    { name: 'Previous Status', value: existingRaider.status, inline: true },
                    { name: 'Unverified By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                );

            // Add roles removed field if any roles were removed
            if (rolesRemovalSummary.removedRoles.length > 0) {
                // Discord has a 1024 character limit per field value
                const rolesText = rolesRemovalSummary.removedRoles.join(', ');
                const truncatedRolesText = rolesText.length > 1024 
                    ? rolesText.substring(0, 1021) + '...' 
                    : rolesText;
                embed.addFields({ 
                    name: `Roles Removed (${rolesRemovalSummary.removedRoles.length})`, 
                    value: truncatedRolesText, 
                    inline: false 
                });
            }

            embed.setTimestamp();

            // Build footer with detailed summary
            const footerParts = [];
            
            // Role removal summary
            if (rolesRemovalSummary.removedCount > 0) {
                footerParts.push(`✓ ${rolesRemovalSummary.removedCount} role(s) removed`);
            }
            if (rolesRemovalSummary.skippedCount > 0) {
                footerParts.push(`⚠️ ${rolesRemovalSummary.skippedCount} role(s) skipped (bot cannot manage)`);
            }
            if (rolesRemovalSummary.failedCount > 0) {
                footerParts.push(`❌ ${rolesRemovalSummary.failedCount} role(s) failed`);
            }

            // Nickname summary
            if (nicknameRemoved) {
                footerParts.push('✓ Nickname removed');
            } else if (nicknameError) {
                footerParts.push(`⚠️ Nickname: ${nicknameError}`);
            }

            if (footerParts.length > 0) {
                embed.setFooter({ text: footerParts.join(' | ') });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log (brief since detailed log goes to veri_log)
            await logVerificationAction(
                interaction.client,
                interaction.guildId,
                'unverified',
                interaction.user.id,
                targetUser.id,
                existingRaider.ign,
                reason
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
                            .setTitle('❌ Member Removed from Verification System')
                            .setColor(0xff9900)
                            .addFields(
                                { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: targetUser.id, inline: true },
                                { name: 'IGN (Freed)', value: `\`${result.ign}\``, inline: true },
                                { name: 'Previous Status', value: existingRaider.status, inline: true },
                                { name: 'Unverified By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'Reason', value: reason, inline: false },
                                {
                                    name: 'Timestamp',
                                    value: time(new Date(), TimestampStyles.LongDateTime),
                                    inline: false,
                                }
                            )
                            .setTimestamp();

                        await (veriLogChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                // Don't fail the command if logging fails, just log the error
                console.warn(`Failed to log unverification to veri_log channel:`, logErr);
            }
        } catch (err) {
            // Map backend errors to user-friendly messages
            let errorMessage = '❌ **Failed to unverify member**\n\n';
            
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
                    case 'RAIDER_NOT_FOUND':
                        errorMessage += '**Issue:** This member is not in the verification system.\n\n';
                        break;
                    default:
                        errorMessage += `**Error:** ${err.message}\n\n`;
                        errorMessage += 'Please try again or contact an administrator if the problem persists.';
                }
            } else {
                console.error('Unverify command error:', err);
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

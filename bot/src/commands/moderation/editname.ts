// bot/src/commands/editname.ts
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
import { hasInternalRole, getMemberRoleIds, hasHigherRole } from '../../lib/permissions/permissions.js';
import { updateRaiderIGN, BackendError, getGuildChannels } from '../../lib/http.js';

/**
 * /editname - Update a verified raider's IGN and nickname.
 * Security+ command (requires Security role or higher).
 * Updates the backend raider table and changes Discord nickname.
 */
export const editname: SlashCommand = {
    requiredRole: 'security',
    data: new SlashCommandBuilder()
        .setName('editname')
        .setDescription('Update a verified raider\'s IGN and nickname (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The Discord member to update')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('ign')
                .setDescription('The member\'s new ROTMG in-game name')
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

        // Check if invoker has Security role
        const invoker = interaction.member;
        if (!invoker || typeof invoker.permissions === 'string') {
            await interaction.reply({
                content: 'Could not verify your permissions.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const invokerMember = await interaction.guild.members.fetch(interaction.user.id);
        const hasSecurity = await hasInternalRole(invokerMember, 'security');
        
        if (!hasSecurity) {
            await interaction.reply({
                content: '❌ **Missing Permission**\n\nYou need the **Security** role to edit member IGNs.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the Security role\n• Make sure you have the Discord role that\'s mapped to Security',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

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

        // Check role hierarchy
        try {
            // Check if bot can manage the target (Discord role hierarchy) - check this FIRST
            const botMember = await interaction.guild.members.fetchMe();
            if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
                await interaction.editReply('❌ **Cannot Modify Member**\n\nThis member has a higher or equal role than the bot in the Discord role hierarchy.\n\nThe bot cannot manage members with higher roles. Ask a server admin to adjust role positions.');
                return;
            }

            // Check internal role hierarchy - prevent targeting someone with equal or higher role
            const canTarget = await hasHigherRole(invokerMember, targetMember);
            
            if (!canTarget) {
                await interaction.editReply('❌ **Access Denied**\n\nYou cannot edit the IGN of someone with an equal or higher role than you.\n\nThis prevents abuse of moderation permissions in the role hierarchy.');
                return;
            }
        } catch (hierarchyErr) {
            console.error('[Edit Name] Role hierarchy check failed:', hierarchyErr);
            // Continue anyway - don't block on hierarchy check failure
        }

        try {
            // Get actor's role IDs for authorization
            const actorRoles = getMemberRoleIds(invokerMember);
            
            // Call backend to update raider IGN
            const result = await updateRaiderIGN(targetUser.id, {
                actor_user_id: interaction.user.id,
                actor_roles: actorRoles,
                guild_id: interaction.guildId,
                ign,
            });

            // Update the member's nickname to their new IGN
            let nicknameUpdated = true;
            let nicknameError = '';
            try {
                const targetMember = await interaction.guild.members.fetch(targetUser.id);
                await targetMember.setNickname(result.ign, `IGN updated by ${interaction.user.tag}`);
            } catch (nickErr: any) {
                nicknameUpdated = false;
                if (nickErr?.code === 50013) {
                    nicknameError = 'Missing permissions (user may have a higher role than the bot)';
                    console.warn(`[Edit Name] Cannot set nickname for ${targetUser.id}: Missing Permissions`);
                } else {
                    nicknameError = 'Unknown error';
                    console.warn(`[Edit Name] Failed to set nickname for ${targetUser.id}:`, nickErr?.message || nickErr);
                }
            }

            // Build success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ IGN Updated')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                    { name: 'Old IGN', value: `\`${result.old_ign}\``, inline: true },
                    { name: 'New IGN', value: `\`${result.ign}\``, inline: true },
                    { name: 'Updated By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();

            if (!nicknameUpdated) {
                embed.setFooter({ text: `⚠️ Could not update nickname: ${nicknameError}` });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to veri_log channel if configured
            try {
                const { channels } = await getGuildChannels(interaction.guildId);
                const veriLogChannelId = channels.veri_log;
                
                if (veriLogChannelId) {
                    const veriLogChannel = await interaction.guild.channels.fetch(veriLogChannelId);
                    
                    if (veriLogChannel && veriLogChannel.isTextBased()) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('✏️ IGN Updated')
                            .setColor(0xffa500)
                            .addFields(
                                { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: result.user_id, inline: true },
                                { name: 'Old IGN', value: `\`${result.old_ign}\``, inline: true },
                                { name: 'New IGN', value: `\`${result.ign}\``, inline: true },
                                { name: 'Updated By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                {
                                    name: 'Timestamp',
                                    value: time(new Date(), TimestampStyles.LongDateTime),
                                    inline: true,
                                }
                            )
                            .setTimestamp();

                        await (veriLogChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                // Don't fail the command if logging fails, just log the error
                console.warn(`Failed to log IGN update to veri_log channel:`, logErr);
            }
        } catch (err) {
            // Map backend errors to user-friendly messages
            let errorMessage = '❌ **Failed to update IGN**\n\n';
            
            if (err instanceof BackendError) {
                switch (err.code) {
                    case 'NOT_AUTHORIZED':
                    case 'NOT_SECURITY':
                        errorMessage += '**Issue:** You don\'t have the Security role configured for this server.\n\n';
                        errorMessage += '**What to do:**\n';
                        errorMessage += '• Ask a server admin to use `/setroles` to set up the Security role\n';
                        errorMessage += '• Make sure you have the Discord role that\'s mapped to Security';
                        break;
                    case 'RAIDER_NOT_FOUND':
                        errorMessage += '**Issue:** This member is not verified in this server.\n\n';
                        errorMessage += '**What to do:**\n';
                        errorMessage += `• Use \`/verify\` to verify <@${targetUser.id}> first`;
                        break;
                    case 'IGN_ALREADY_IN_USE':
                        errorMessage += '**Issue:** This IGN is already linked to another Discord account.\n\n';
                        errorMessage += `${err.message}\n\n`;
                        errorMessage += '**What to do:**\n';
                        errorMessage += '• Verify the correct IGN spelling\n';
                        errorMessage += '• Contact an admin if this is an error or account transfer';
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
                console.error('Edit name command error:', err);
                errorMessage += 'An unexpected error occurred. Please try again later.';
            }

            await interaction.editReply(errorMessage);
        }
    },
};

// bot/src/commands/moderation/security/addalt.ts
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
import { addRaiderAlt, BackendError, getGuildChannels, getRaider } from '../../../lib/utilities/http.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';
import { createLogger } from '../../../lib/logging/logger.js';

const logger = createLogger('AddAlt');

/**
 * /addalt - Add an alt IGN to a verified raider.
 * Staff-only command (Security role required).
 * Updates the raider's nickname to: <main IGN> | <alt IGN>
 */
export const addalt: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: false,
    data: new SlashCommandBuilder()
        .setName('addalt')
        .setDescription('Add an alt IGN to a verified member (Security only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The Discord member to add an alt for')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('ign')
                .setDescription('The alt ROTMG in-game name')
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
        const altIgn = interaction.options.getString('ign', true).trim();

        // Basic IGN validation (lightweight)
        if (!altIgn || altIgn.length === 0) {
            await interaction.reply({
                content: 'Alt IGN cannot be empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (altIgn.length > 16) {
            await interaction.reply({
                content: 'Alt IGN must be 16 characters or less.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (!/^[A-Za-z0-9 _-]+$/.test(altIgn)) {
            await interaction.reply({
                content: 'Alt IGN can only contain letters, numbers, spaces, - or _.',
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

        // Check if user is verified
        let existingRaider;
        try {
            existingRaider = await getRaider(interaction.guildId, targetUser.id);
            if (!existingRaider) {
                await interaction.editReply(`❌ **Not Verified**\n\n<@${targetUser.id}> is not verified in this server.\n\nUse \`/verify\` to verify them first.`);
                return;
            }
            if (existingRaider.status !== 'approved') {
                await interaction.editReply(`❌ **Not Verified**\n\n<@${targetUser.id}> is not currently verified (status: ${existingRaider.status}).\n\nUse \`/verify\` to verify them first.`);
                return;
            }
        } catch (checkErr) {
            logger.warn('Failed to check existing raider', { 
                guildId: interaction.guildId,
                targetUserId: targetUser.id,
                error: checkErr instanceof Error ? checkErr.message : String(checkErr)
            });
            await interaction.editReply('❌ Failed to check verification status. Please try again.');
            return;
        }

        // Check if we can change nickname (based on role hierarchy)
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

        try {
            // Get actor's role IDs for authorization
            const actorRoles = getMemberRoleIds(invokerMember);
            logger.debug('Actor roles retrieved for add alt', { 
                guildId: interaction.guildId,
                actorId: interaction.user.id, 
                roleCount: actorRoles.length 
            });
            
            // Call backend to add alt IGN
            const result = await addRaiderAlt(targetUser.id, {
                actor_user_id: interaction.user.id,
                actor_roles: actorRoles,
                guild_id: interaction.guildId,
                alt_ign: altIgn,
            });

            // Update the member's nickname to: <main IGN> | <alt IGN>
            const newNickname = `${result.ign} | ${result.alt_ign}`;
            let nicknameUpdated = true;
            let nicknameError = '';
            try {
                // Only change nickname if hierarchy allows it
                if (canChangeNickname) {
                    await targetMember.setNickname(newNickname, `Alt added by ${interaction.user.tag}`);
                } else {
                    nicknameUpdated = false;
                    nicknameError = 'User has higher or equal role (hierarchy protection)';
                }
            } catch (nickErr: any) {
                nicknameUpdated = false;
                if (nickErr?.code === 50013) {
                    nicknameError = 'Missing permissions (user may have a higher role than the bot)';
                    logger.warn('Cannot set nickname for member with alt - Missing Permissions', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        nickname: newNickname
                    });
                } else {
                    nicknameError = 'Unknown error';
                    logger.warn('Failed to set nickname for member with alt', { 
                        guildId: interaction.guildId,
                        targetUserId: targetUser.id,
                        error: nickErr?.message || String(nickErr)
                    });
                }
            }

            // Build success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ Alt IGN Added')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Member', value: `<@${result.user_id}>`, inline: true },
                    { name: 'Main IGN', value: `\`${result.ign}\``, inline: true },
                    { name: 'Alt IGN', value: `\`${result.alt_ign}\``, inline: true },
                    { name: 'Added By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();

            if (result.old_alt_ign) {
                embed.addFields({
                    name: 'Previous Alt IGN',
                    value: `\`${result.old_alt_ign}\``,
                    inline: true
                });
            }

            if (!nicknameUpdated) {
                embed.setFooter({ text: `⚠️ Nickname: ${nicknameError}` });
            } else {
                embed.setFooter({ text: `✓ Nickname updated to: ${newNickname}` });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log
            await logCommandExecution(interaction.client, interaction, { 
                success: true,
                details: {
                    'Target': `<@${targetUser.id}>`,
                    'Main IGN': result.ign,
                    'Alt IGN': result.alt_ign || 'N/A',
                    'Old Alt IGN': result.old_alt_ign || 'N/A'
                }
            });

            // Log to veri_log channel if configured
            try {
                const { channels } = await getGuildChannels(interaction.guildId);
                const veriLogChannelId = channels.veri_log;
                
                if (veriLogChannelId) {
                    const veriLogChannel = await interaction.guild.channels.fetch(veriLogChannelId);
                    
                    if (veriLogChannel && veriLogChannel.isTextBased()) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('🔄 Alt IGN Added')
                            .setColor(0x00ff00)
                            .addFields(
                                { name: 'Member', value: `<@${result.user_id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: result.user_id, inline: true },
                                { name: 'Main IGN', value: `\`${result.ign}\``, inline: true },
                                { name: 'Alt IGN', value: `\`${result.alt_ign}\``, inline: true },
                                { name: 'Added By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                {
                                    name: 'Timestamp',
                                    value: time(new Date(), TimestampStyles.LongDateTime),
                                    inline: true,
                                }
                            )
                            .setTimestamp();

                        if (result.old_alt_ign) {
                            logEmbed.addFields({
                                name: 'Previous Alt IGN',
                                value: `\`${result.old_alt_ign}\``,
                                inline: true
                            });
                        }

                        await (veriLogChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                // Don't fail the command if logging fails, just log the error
                logger.warn('Failed to log alt addition to veri_log channel', { 
                    guildId: interaction.guildId,
                    targetUserId: targetUser.id,
                    altIgn,
                    error: logErr instanceof Error ? logErr.message : String(logErr)
                });
            }
        } catch (err) {
            // Map backend errors to user-friendly messages
            let errorMessage = '❌ **Failed to add alt IGN**\n\n';
            
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
                        errorMessage += '**Issue:** This member is not verified in this server.\n\n';
                        errorMessage += '**What to do:**\n';
                        errorMessage += `• Use \`/verify\` to verify <@${targetUser.id}> first`;
                        break;
                    case 'NOT_VERIFIED':
                        errorMessage += '**Issue:** User must be verified before adding an alt IGN.\n\n';
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
                    case 'DUPLICATE_IGN':
                        errorMessage += '**Issue:** Alt IGN cannot be the same as the main IGN.\n\n';
                        errorMessage += '**What to do:**\n';
                        errorMessage += '• Provide a different IGN for the alt account';
                        break;
                    case 'VALIDATION_ERROR':
                        errorMessage += '**Issue:** The alt IGN provided is invalid.\n\n';
                        errorMessage += '**Requirements:**\n';
                        errorMessage += '• 1-16 characters long\n';
                        errorMessage += '• Only letters, numbers, spaces, hyphens (-), or underscores (_)';
                        break;
                    default:
                        errorMessage += `**Error:** ${err.message}\n\n`;
                        errorMessage += 'Please try again or contact an administrator if the problem persists.';
                }
            } else {
                logger.error('Add alt command error', { 
                    guildId: interaction.guildId,
                    actorId: interaction.user.id,
                    targetId: targetUser.id,
                    altIgn,
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

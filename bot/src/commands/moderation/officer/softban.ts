// bot/src/commands/moderation/officer/softban.ts
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
import { getGuildChannels, unverifyRaider, BackendError } from '../../../lib/utilities/http.js';

/**
 * /softban - Ban and immediately unban a member to delete their messages
 * Officer+ command
 * Used to clean up messages from compromised accounts without permanently banning
 */
export const softban: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('softban')
        .setDescription('Ban then unban a member to delete their messages (Officer+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to soft-ban')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the soft-ban')
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

            // Fetch members
            const invokerMember = await interaction.guild.members.fetch(interaction.user.id);
            const actorRoles = getMemberRoleIds(invokerMember);

            // Get options
            const targetUser = interaction.options.getUser('member', true);
            const reason = interaction.options.getString('reason', true).trim();

            // Can't softban yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot soft-ban yourself.');
                return;
            }

            // Can't softban bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot soft-ban bots.');
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

            // Role hierarchy check
            const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
                allowSelf: false,
                checkBotPosition: true
            });
            if (!targetCheck.canTarget) {
                await interaction.editReply(targetCheck.reason!);
                return;
            }

            // Check if bot has ban permission
            const botMember = await interaction.guild.members.fetchMe();
            if (!botMember.permissions.has('BanMembers')) {
                await interaction.editReply('❌ **Missing Bot Permission**\n\nThe bot lacks the "Ban Members" permission. Ask a server admin to grant this permission.');
                return;
            }

            // Try to DM the user before soft-banning
            let dmSent = false;
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Soft-Banned from Server')
                    .setDescription(`You have been soft-banned from **${interaction.guild.name}**.`)
                    .setColor(0xffa500)
                    .addFields(
                        { name: 'What is a Soft-Ban?', value: 'A soft-ban temporarily bans you to delete your recent messages, then immediately unbans you. You can rejoin the server with an invite link.', inline: false },
                        { name: 'Reason', value: reason },
                        { name: 'Actioned By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Date', value: time(new Date(), TimestampStyles.LongDateTime) }
                    )
                    .setFooter({ text: 'You may rejoin the server if you have an invite link. Your messages have been deleted.' })
                    .setTimestamp();

                await targetUser.send({ embeds: [dmEmbed] });
                dmSent = true;
            } catch (dmErr) {
                console.warn(`[Softban] Failed to DM user ${targetUser.id}:`, dmErr);
            }

            // Perform the soft-ban (ban + unban)
            let banSuccess = false;
            let unbanSuccess = false;
            let errorMessage = '';

            try {
                // Step 1: Ban the member (this deletes their messages)
                await interaction.guild.members.ban(targetUser.id, {
                    reason: `[SOFT-BAN] ${reason} - Soft-banned by ${interaction.user.tag}`,
                    deleteMessageSeconds: 604800 // Delete messages from last 7 days
                });
                banSuccess = true;

                // Step 2: Immediately unban them
                try {
                    await interaction.guild.members.unban(targetUser.id, `[SOFT-BAN] Automatic unban after message deletion - ${interaction.user.tag}`);
                    unbanSuccess = true;
                } catch (unbanErr: any) {
                    console.error('[Softban] Failed to unban after soft-ban:', unbanErr);
                    errorMessage = `⚠️ **Partial Success**\n\nMember was banned but failed to unban automatically. You must manually unban <@${targetUser.id}> (${targetUser.tag}).\n\nUnban error: ${unbanErr?.message || 'Unknown error'}`;
                }
            } catch (banErr: any) {
                console.error('[Softban] Failed to ban member:', banErr);
                let errorMsg = '❌ **Failed to soft-ban member**\n\n';
                if (banErr?.code === 50013) {
                    errorMsg += 'Missing permissions. The bot may not have the "Ban Members" permission, or the target member\'s role is higher than the bot\'s highest role.';
                } else {
                    errorMsg += `Error: ${banErr?.message || 'Unknown error'}`;
                }
                await interaction.editReply(errorMsg);
                return;
            }

            // If the user is verified, remove verification record so IGN is freed
            let verificationCleanupSummary = 'ℹ️ No verification record found';
            try {
                const cleanup = await unverifyRaider(interaction.guildId, targetUser.id, {
                    actor_user_id: interaction.user.id,
                    actor_roles: actorRoles,
                    reason: `Auto-unverify from /softban: ${reason}`,
                });
                verificationCleanupSummary = `✅ Verification removed (IGN freed: ${cleanup.ign})`;
            } catch (cleanupErr) {
                if (cleanupErr instanceof BackendError && cleanupErr.code === 'RAIDER_NOT_FOUND') {
                    verificationCleanupSummary = 'ℹ️ No verification record found';
                } else {
                    verificationCleanupSummary = '⚠️ Failed to remove verification record';
                    console.warn('[Softban] Failed to auto-unverify after soft-ban:', cleanupErr);
                }
            }

            // Build response based on success/failure
            if (unbanSuccess) {
                // Full success
                const responseEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Member Soft-Banned')
                    .setDescription('The member was temporarily banned to delete their messages, then immediately unbanned.')
                    .setColor(0xffa500)
                    .addFields(
                        { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'User Tag', value: targetUser.tag, inline: true },
                        { name: 'User ID', value: targetUser.id, inline: true },
                        { name: 'Actioned By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Message Deletion', value: 'Last 7 days', inline: true },
                        { name: 'Verification Cleanup', value: verificationCleanupSummary, inline: false },
                        { name: 'Reason', value: reason }
                    )
                    .setFooter({ text: dmSent ? '✓ User notified via DM | ✓ User can rejoin' : '⚠️ Could not DM user | ✓ User can rejoin' })
                    .setTimestamp();

                await interaction.editReply({ embeds: [responseEmbed] });
            } else {
                // Partial success - banned but not unbanned
                await interaction.editReply(`${errorMessage}\n\n${verificationCleanupSummary}`);
            }

            // Log to punishment_log channel if configured
            try {
                const { channels } = await getGuildChannels(interaction.guildId);
                const punishmentLogChannelId = channels.punishment_log;

                if (punishmentLogChannelId) {
                    const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                    if (logChannel && logChannel.isTextBased()) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Member Soft-Banned')
                            .setDescription(unbanSuccess 
                                ? 'The member was temporarily banned to delete their messages, then immediately unbanned.'
                                : '⚠️ **Partial Success** - Member was banned but automatic unban failed. Manual unban required.')
                            .setColor(unbanSuccess ? 0xffa500 : 0xff0000)
                            .addFields(
                                { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: targetUser.id, inline: true },
                                { name: 'Actioned By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'Ban Success', value: banSuccess ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Unban Success', value: unbanSuccess ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Message Deletion', value: 'Last 7 days', inline: true },
                                { name: 'Verification Cleanup', value: verificationCleanupSummary, inline: false },
                                { name: 'Reason', value: reason }
                            )
                            .setTimestamp();

                        if (!unbanSuccess) {
                            logEmbed.setFooter({ text: '⚠️ MANUAL UNBAN REQUIRED - Check the user\'s ban status' });
                        }

                        await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                console.warn(`[Softban] Failed to log to punishment_log channel:`, logErr);
            }
        } catch (unhandled) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            } catch { }
            console.error('[Softban] Unhandled error:', unhandled);
        }
    },
};

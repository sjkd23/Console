// bot/src/commands/moderation/officer/ban.ts
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
import { getGuildChannels } from '../../../lib/utilities/http.js';

/**
 * /ban - Permanently ban a member from the server
 * Officer+ command
 */
export const ban: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Permanently ban a member from the server (Officer+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to ban')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the ban')
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

            // Get options
            const targetUser = interaction.options.getUser('member', true);
            const reason = interaction.options.getString('reason', true).trim();

            // Can't ban yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot ban yourself.');
                return;
            }

            // Can't ban bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot ban bots.');
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

            // Try to DM the user before banning
            let dmSent = false;
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('🔨 Banned')
                    .setDescription(`You were permanently banned from **${interaction.guild.name}**.`)
                    .setColor(0xff0000)
                    .addFields(
                        { name: 'Reason', value: reason },
                        { name: 'Banned By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Date', value: time(new Date(), TimestampStyles.LongDateTime) }
                    )
                    .setFooter({ text: 'You may appeal to server administrators' })
                    .setTimestamp();

                await targetUser.send({ embeds: [dmEmbed] });
                dmSent = true;
            } catch (dmErr) {
                console.warn(`[Ban] Failed to DM user ${targetUser.id}:`, dmErr);
            }

            // Perform the ban
            try {
                await targetMember.ban({
                    reason: `${reason} - Banned by ${interaction.user.tag}`,
                    deleteMessageSeconds: 86400 // Delete messages from last 24 hours
                });
            } catch (banErr: any) {
                console.error('[Ban] Failed to ban member:', banErr);
                let errorMsg = '❌ **Failed to ban member**\n\n';
                if (banErr?.code === 50013) {
                    errorMsg += 'Missing permissions. The bot may lack "Ban Members" permission, or the target has a higher role than the bot.';
                } else {
                    errorMsg += `Error: ${banErr?.message || 'Unknown error'}`;
                }
                await interaction.editReply(errorMsg);
                return;
            }

            // Build success response
            const responseEmbed = new EmbedBuilder()
                .setTitle('🔨 Member Banned')
                .setColor(0xff0000)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'User Tag', value: targetUser.tag, inline: true },
                    { name: 'User ID', value: targetUser.id, inline: true },
                    { name: 'Banned By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Message Deletion', value: 'Last 24 hours', inline: true },
                    { name: 'Reason', value: reason }
                )
                .setFooter({ text: dmSent ? 'User notified via DM' : 'Could not DM user' })
                .setTimestamp();

            await interaction.editReply({ embeds: [responseEmbed] });

            // Log to punishment_log channel if configured
            try {
                const { channels } = await getGuildChannels(interaction.guildId);
                const punishmentLogChannelId = channels.punishment_log;

                if (punishmentLogChannelId) {
                    const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                    if (logChannel && logChannel.isTextBased()) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('🔨 Member Banned')
                            .setColor(0xff0000)
                            .addFields(
                                { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: targetUser.id, inline: true },
                                { name: 'Banned By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Message Deletion', value: 'Last 24 hours', inline: true },
                                { name: 'Reason', value: reason }
                            )
                            .setTimestamp();

                        await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                console.warn(`[Ban] Failed to log to punishment_log channel:`, logErr);
            }
        } catch (unhandled) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            } catch { }
            console.error('[Ban] Unhandled error:', unhandled);
        }
    },
};

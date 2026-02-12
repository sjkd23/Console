// bot/src/commands/moderation/officer/kick.ts
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
 * /kick - Remove a member from the server
 * Officer+ command
 */
export const kick: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Remove a member from the server (Officer+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to kick')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for the kick')
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

            // Can't kick yourself
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot kick yourself.');
                return;
            }

            // Can't kick bots
            if (targetUser.bot) {
                await interaction.editReply('❌ You cannot kick bots.');
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

            // Check if bot has kick permission
            const botMember = await interaction.guild.members.fetchMe();
            if (!botMember.permissions.has('KickMembers')) {
                await interaction.editReply('❌ **Missing Bot Permission**\n\nThe bot lacks the "Kick Members" permission. Ask a server admin to grant this permission.');
                return;
            }

            // Try to DM the user before kicking
            let dmSent = false;
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('👢 Kicked from Server')
                    .setDescription(`You have been kicked from **${interaction.guild.name}**.`)
                    .setColor(0xff6b00)
                    .addFields(
                        { name: 'Reason', value: reason },
                        { name: 'Kicked By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Date', value: time(new Date(), TimestampStyles.LongDateTime) }
                    )
                    .setFooter({ text: 'You may rejoin the server if you have an invite link.' })
                    .setTimestamp();

                await targetUser.send({ embeds: [dmEmbed] });
                dmSent = true;
            } catch (dmErr) {
                console.warn(`[Kick] Failed to DM user ${targetUser.id}:`, dmErr);
            }

            // Perform the kick
            try {
                await targetMember.kick(`${reason} - Kicked by ${interaction.user.tag}`);
            } catch (kickErr: any) {
                console.error('[Kick] Failed to kick member:', kickErr);
                let errorMsg = '❌ **Failed to kick member**\n\n';
                if (kickErr?.code === 50013) {
                    errorMsg += 'Missing permissions. The bot may not have the "Kick Members" permission, or the target member\'s role is higher than the bot\'s highest role.';
                } else {
                    errorMsg += `Error: ${kickErr?.message || 'Unknown error'}`;
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
                    reason: `Auto-unverify from /kick: ${reason}`,
                });
                verificationCleanupSummary = `✅ Verification removed (IGN freed: ${cleanup.ign})`;
            } catch (cleanupErr) {
                if (cleanupErr instanceof BackendError && cleanupErr.code === 'RAIDER_NOT_FOUND') {
                    verificationCleanupSummary = 'ℹ️ No verification record found';
                } else {
                    verificationCleanupSummary = '⚠️ Failed to remove verification record';
                    console.warn('[Kick] Failed to auto-unverify after kick:', cleanupErr);
                }
            }

            // Build success response
            const responseEmbed = new EmbedBuilder()
                .setTitle('👢 Member Kicked')
                .setColor(0xff6b00)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'User Tag', value: targetUser.tag, inline: true },
                    { name: 'User ID', value: targetUser.id, inline: true },
                    { name: 'Kicked By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Verification Cleanup', value: verificationCleanupSummary }
                )
                .setFooter({ text: dmSent ? '✓ User notified via DM' : '⚠️ Could not DM user (DMs may be disabled)' })
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
                            .setTitle('👢 Member Kicked')
                            .setColor(0xff6b00)
                            .addFields(
                                { name: 'Member', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                { name: 'User ID', value: targetUser.id, inline: true },
                                { name: 'Kicked By', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                                { name: 'Verification Cleanup', value: verificationCleanupSummary, inline: false },
                                { name: 'Reason', value: reason }
                            )
                            .setTimestamp();

                        await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                    }
                }
            } catch (logErr) {
                console.warn(`[Kick] Failed to log to punishment_log channel:`, logErr);
            }
        } catch (unhandled) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            } catch { }
            console.error('[Kick] Unhandled error:', unhandled);
        }
    },
};

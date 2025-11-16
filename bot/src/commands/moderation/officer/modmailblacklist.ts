// bot/src/commands/moderation/modmailblacklist.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    GuildMember,
    User,
    EmbedBuilder,
    TextChannel,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { blacklistModmail, BackendError, getGuildChannels } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';

export const modmailblacklist: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('modmailblacklist')
        .setDescription('Blacklist a user from using modmail (Officer+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The user to blacklist from modmail')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for blacklisting')
                .setRequired(true)
                .setMaxLength(500)
        )
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // Guild-only check
            if (!interaction.inGuild() || !interaction.guild) {
                await interaction.reply({
                    content: '❌ This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Acknowledge immediately (non-ephemeral)
            await interaction.deferReply();

            // Fetch actor member
            let actorMember: GuildMember;
            try {
                actorMember = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again in a moment.');
                return;
            }

            // Get command options
            const targetUser = interaction.options.getUser('member', true) as User;
            const reason = interaction.options.getString('reason', true);

            // Prevent blacklisting self
            if (targetUser.id === interaction.user.id) {
                await interaction.editReply('❌ You cannot blacklist yourself from modmail.');
                return;
            }

            // Call backend to blacklist user
            try {
                const result = await blacklistModmail({
                    actor_user_id: interaction.user.id,
                    actor_roles: getMemberRoleIds(actorMember),
                    guild_id: interaction.guildId!,
                    user_id: targetUser.id,
                    reason,
                });

                // Build response embed
                const responseEmbed = new EmbedBuilder()
                    .setTitle('🚫 Modmail Blacklist Applied')
                    .setColor(0xff6b6b)
                    .addFields(
                        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
                        { name: 'User ID', value: targetUser.id, inline: true },
                        { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Reason', value: reason }
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [responseEmbed] });

                // Log to punishment_log channel if configured
                try {
                    const { channels } = await getGuildChannels(interaction.guildId!);
                    const punishmentLogChannelId = channels.punishment_log;

                    if (punishmentLogChannelId) {
                        const logChannel = await interaction.guild.channels.fetch(punishmentLogChannelId);

                        if (logChannel && logChannel.isTextBased()) {
                            const logEmbed = new EmbedBuilder()
                                .setTitle('🚫 Modmail Blacklist Applied')
                                .setColor(0xff6b6b)
                                .addFields(
                                    { name: 'User', value: `<@${targetUser.id}> (${targetUser.tag})`, inline: true },
                                    { name: 'User ID', value: targetUser.id, inline: true },
                                    { name: 'Moderator', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                                    { name: 'Reason', value: reason }
                                )
                                .setTimestamp();

                            await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        }
                    }
                } catch (logErr) {
                    console.error('[ModmailBlacklist] Failed to log to punishment_log:', logErr);
                }

                await logCommandExecution(interaction.client, interaction, {
                    success: true,
                    details: {
                        target_user_id: targetUser.id,
                        reason,
                    },
                });
            } catch (err) {
                let msg = '❌ Failed to blacklist user from modmail. Please try again later.';
                
                if (err instanceof BackendError) {
                    if (err.code === 'NOT_OFFICER' || err.code === 'NOT_AUTHORIZED') {
                        // This shouldn't happen since middleware already checked permissions
                        // But if it does, it's likely a backend configuration issue
                        msg = '❌ **Authorization Error**\n\nAuthorization failed on the backend. This is likely a server configuration issue. Contact a server administrator if this persists.';
                    } else if (err.code === 'VALIDATION_ERROR') {
                        msg = `❌ Validation error: ${err.message}`;
                    }
                }

                await interaction.editReply(msg);
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: msg,
                });
            }
        } catch (error) {
            console.error('[ModmailBlacklist] Unhandled error:', error);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ An unexpected error occurred while processing this command.');
                } else {
                    await interaction.reply({
                        content: '❌ An unexpected error occurred.',
                        ephemeral: true,
                    });
                }
            } catch {
                // Ignore if we can't send the error message
            }
        }
    },
};

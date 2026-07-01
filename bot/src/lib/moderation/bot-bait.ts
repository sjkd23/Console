// bot/src/lib/moderation/bot-bait.ts
import {
    Message,
    EmbedBuilder,
    TextChannel,
    PermissionFlagsBits,
    time,
    TimestampStyles,
} from 'discord.js';
import { getGuildChannels, unverifyRaider, BackendError } from '../utilities/http.js';
import { hasRequiredRoleOrHigher } from '../permissions/permissions.js';

/**
 * In-memory guard to prevent duplicate processing while a soft-ban is in progress.
 * Keyed by "guildId:userId".
 */
const inProgress = new Set<string>();

/**
 * Handles a messageCreate event for the bot-bait channel.
 * If the message is sent in the configured bot_bait channel by a non-privileged user,
 * the user is automatically soft-banned and the action is logged to punishment_log.
 */
export async function handleBotBaitMessage(message: Message): Promise<void> {
    // Ignore bots, webhooks, and DMs
    if (!message.guild || !message.guildId || message.author.bot || message.webhookId) return;

    const guildId = message.guildId;
    const guard = `${guildId}:${message.author.id}`;

    // Skip if already processing this user (prevents duplicate events)
    if (inProgress.has(guard)) return;

    try {
        // Fetch configured channels for the guild
        const { channels } = await getGuildChannels(guildId);
        const botBaitChannelId = channels['bot_bait'];

        // No bot-bait channel configured, or message is not in it
        if (!botBaitChannelId || message.channelId !== botBaitChannelId) return;

        // Resolve the member (may already be cached)
        const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) return;

        // Skip users with elevated Discord permissions
        if (
            member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.permissions.has(PermissionFlagsBits.ManageGuild) ||
            member.permissions.has(PermissionFlagsBits.BanMembers)
        ) return;

        // Skip users with any internal staff role (organizer or higher = team/staff role)
        const { hasRole: isStaff } = await hasRequiredRoleOrHigher(member, 'organizer');
        if (isStaff) return;

        // Acquire in-progress guard
        inProgress.add(guard);

        // Snapshot the member's roles before the ban removes them
        const userRoles = member.roles.cache
            .filter(r => r.id !== message.guild!.id) // exclude @everyone
            .map(r => `<@&${r.id}>`)
            .join(', ') || 'None';

        const reason = 'Automatic bot-bait soft ban: user posted in configured bot-bait channel';

        // Ensure the bot has BanMembers permission
        const botMember = await message.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
            console.warn('[BotBait] Bot lacks BanMembers permission in guild', guildId);
            return;
        }

        // Try to DM the user before banning (mirrors /softban behaviour)
        let dmSent = false;
        try {
            const dmEmbed = new EmbedBuilder()
                .setTitle('⚠️ Soft-Banned from Server')
                .setDescription(`You have been soft-banned from **${message.guild.name}**.`)
                .setColor(0xffa500)
                .addFields(
                    { name: 'What is a Soft-Ban?', value: 'A soft-ban temporarily bans you to delete your recent messages, then immediately unbans you. You can rejoin the server with an invite link.', inline: false },
                    { name: 'Reason', value: reason },
                    { name: 'Actioned By', value: `AutoMod / Bot-Bait`, inline: true },
                    { name: 'Date', value: time(new Date(), TimestampStyles.LongDateTime) }
                )
                .setFooter({ text: 'You may rejoin the server if you have an invite link. Your messages have been deleted.' })
                .setTimestamp();

            await message.author.send({ embeds: [dmEmbed] });
            dmSent = true;
        } catch {
            // User has DMs closed — not a failure, continue
        }

        // Perform the soft-ban: ban then immediately unban
        let banSuccess = false;
        let unbanSuccess = false;

        try {
            await message.guild.members.ban(message.author.id, {
                reason: `[BOT-BAIT] ${reason}`,
                deleteMessageSeconds: 604800, // Delete last 7 days of messages
            });
            banSuccess = true;

            try {
                await message.guild.members.unban(
                    message.author.id,
                    '[BOT-BAIT] Automatic unban after message deletion'
                );
                unbanSuccess = true;
            } catch (unbanErr) {
                console.error('[BotBait] Failed to unban after soft-ban:', unbanErr);
            }
        } catch (banErr: any) {
            console.error('[BotBait] Failed to ban member:', banErr);
        }

        // Nothing to log if the ban never happened
        if (!banSuccess) return;

        // Remove verification record so the IGN is freed (mirrors /softban)
        let verificationCleanupSummary = 'ℹ️ No verification record found';
        try {
            const cleanup = await unverifyRaider(guildId, message.author.id, {
                actor_user_id: message.client.user!.id,
                actor_has_admin_permission: true,
                reason: `Auto-unverify from bot-bait: ${reason}`,
            });
            verificationCleanupSummary = `✅ Verification removed (IGN freed: ${cleanup.ign})`;
        } catch (err) {
            if (err instanceof BackendError && err.code === 'RAIDER_NOT_FOUND') {
                verificationCleanupSummary = 'ℹ️ No verification record found';
            } else {
                verificationCleanupSummary = '⚠️ Failed to remove verification record';
                console.warn('[BotBait] Failed to auto-unverify:', err);
            }
        }

        // Log to the punishment_log channel
        const punishmentLogChannelId = channels['punishment_log'];
        if (punishmentLogChannelId) {
            try {
                const logChannel = await message.guild.channels.fetch(punishmentLogChannelId).catch(() => null);
                if (logChannel && logChannel.isTextBased()) {
                    const logEmbed = new EmbedBuilder()
                        .setTitle('🪤 Bot-Bait Auto Soft-Ban')
                        .setDescription(
                            unbanSuccess
                                ? 'A user sent a message in the configured bot-bait channel and was automatically soft-banned.'
                                : '⚠️ **Partial Success** — User was banned but automatic unban failed. Manual unban required.'
                        )
                        .setColor(unbanSuccess ? 0xffa500 : 0xff0000)
                        .addFields(
                            { name: 'Member', value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
                            { name: 'User ID', value: message.author.id, inline: true },
                            { name: 'Actioned By', value: `AutoMod / Bot-Bait (${message.client.user!.tag})`, inline: true },
                            { name: 'Bot-Bait Channel', value: `<#${botBaitChannelId}>`, inline: true },
                            { name: 'Ban Success', value: banSuccess ? '✅ Yes' : '❌ No', inline: true },
                            { name: 'Unban Success', value: unbanSuccess ? '✅ Yes' : '❌ No', inline: true },
                            { name: 'DM Sent', value: dmSent ? '✅ Yes' : '❌ No', inline: true },
                            { name: 'Message Deletion', value: 'Last 7 days', inline: true },
                            { name: 'User Roles at Time of Action', value: userRoles, inline: false },
                            { name: 'Verification Cleanup', value: verificationCleanupSummary, inline: false },
                            { name: 'Reason', value: reason }
                        )
                        .setTimestamp();

                    if (!unbanSuccess) {
                        logEmbed.setFooter({ text: '⚠️ MANUAL UNBAN REQUIRED — Check the user\'s ban status' });
                    }

                    await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                }
            } catch (logErr) {
                console.warn('[BotBait] Failed to log to punishment_log channel:', logErr);
            }
        }
    } catch (err) {
        console.error('[BotBait] Unhandled error:', err);
    } finally {
        inProgress.delete(guard);
    }
}

// bot/src/commands/setchannels.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    GuildMember,
    ChannelType,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { setGuildChannels, BackendError } from '../../lib/utilities/http.js';
import { hasInternalRole, getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { logCommandExecution, logConfigChange } from '../../lib/logging/bot-logger.js';

const CHANNEL_OPTIONS = [
    { key: 'raid', label: 'Raid', description: 'Main channel for raid announcements and coordination' },
    { key: 'veri_log', label: 'Verification Log', description: 'Log channel for verification events' },
    { key: 'manual_verification', label: 'Manual Verification', description: 'Channel for manual verification requests' },
    { key: 'getverified', label: 'Get Verified', description: 'Channel where users initiate verification' },
    { key: 'punishment_log', label: 'Punishment Log', description: 'Log channel for moderation actions' },
    { key: 'raid_log', label: 'Raid Log', description: 'Log channel for raid-related events' },
    { key: 'quota', label: 'Quota', description: 'Channel for quota leaderboard panels and tracking' },
    { key: 'bot_log', label: 'Bot Log', description: 'General bot activity and command execution logs' },
    { key: 'staff_updates', label: 'Staff Updates', description: 'Channel for staff promotion announcements' },
    { key: 'modmail', label: 'Modmail', description: 'Channel for receiving and managing modmail support tickets' },
    { key: 'role_ping', label: 'Role Ping', description: 'Channel for the role ping panel where users can self-assign dungeon ping roles' },
] as const;

export const setchannels: SlashCommand = {
    requiredRole: undefined, // Uses Discord Administrator permission instead
    data: new SlashCommandBuilder()
        .setName('setchannels')
        .setDescription('Configure internal channel mappings for this server (Administrator)')
        .addChannelOption(o => o.setName('raid').setDescription('Raid channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('veri_log').setDescription('Verification log channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('manual_verification').setDescription('Manual verification channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('getverified').setDescription('Get verified channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('punishment_log').setDescription('Punishment log channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('raid_log').setDescription('Raid log channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('quota').setDescription('Quota leaderboard channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('bot_log').setDescription('Bot activity log channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('staff_updates').setDescription('Staff promotion announcements channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('modmail').setDescription('Modmail support tickets channel').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('role_ping').setDescription('Role ping panel channel').addChannelTypes(ChannelType.GuildText))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // 1) Guild-only check (reply immediately if invalid)
            if (!interaction.inGuild() || !interaction.guild) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 2) Check Discord Administrator permission
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to configure bot channels.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 3) ACK ASAP to avoid 3s timeout
            await interaction.deferReply();

            // 4) Fetch member safely (needed for actor_roles)
            let member: GuildMember;
            try {
                member = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again in a moment.');
                return;
            }

            // 5) Collect provided channel updates (partial)
            const updates: Record<string, string | null> = {};
            for (const { key } of CHANNEL_OPTIONS) {
                // getChannel returns Channel | null when option omitted; only include if provided
                const channel = interaction.options.getChannel(key);
                if (channel !== null) {
                    updates[key] = channel ? channel.id : null;
                }
            }

            if (Object.keys(updates).length === 0) {
                await interaction.editReply('⚠️ No channel updates provided. Pick at least one option.');
                return;
            }

            // 6) Backend call
            try {
                const { channels, warnings } = await setGuildChannels(interaction.guildId!, {
                    actor_user_id: interaction.user.id,
                    channels: updates,
                    actor_roles: getMemberRoleIds(member),
                    actor_has_admin_permission: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
                });

                // 7) Build response
                const embed = new EmbedBuilder()
                    .setTitle('✅ Channel configuration updated')
                    .setDescription('Current channel mappings for this server:')
                    .setColor(0x00ff00)
                    .setTimestamp();

                for (const { key, label } of CHANNEL_OPTIONS) {
                    const discordChannelId = channels[key];
                    const value = discordChannelId ? `<#${discordChannelId}>` : '—';
                    embed.addFields({ name: label, value, inline: true });
                }

                const warningText =
                    warnings && warnings.length > 0 ? `⚠️ **Warnings:**\n${warnings.map(w => `• ${w}`).join('\n')}` : undefined;

                await interaction.editReply({
                    content: warningText,
                    embeds: [embed],
                });

                // Log to bot-log
                const changes: Record<string, { old?: string; new?: string }> = {};
                for (const [key, newChannelId] of Object.entries(updates)) {
                    const label = CHANNEL_OPTIONS.find(c => c.key === key)?.label || key;
                    changes[label] = {
                        new: newChannelId ? `<#${newChannelId}>` : 'Removed'
                    };
                }
                await logConfigChange(interaction.client, interaction.guildId!, 'Channel Mappings', interaction.user.id, changes);
                await logCommandExecution(interaction.client, interaction, { success: true });
            } catch (err) {
                let msg = '❌ Failed to update channels. Please try again later.';
                if (err instanceof BackendError) {
                    if (err.code === 'NOT_AUTHORIZED') {
                        msg = '❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to configure bot channels.\n\nMake sure you have the Administrator permission in this server\'s role settings.';
                    } else if (err.code === 'VALIDATION_ERROR') {
                        msg = `❌ Validation error: ${err.message}`;
                    }
                }
                await interaction.editReply(msg);
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: msg
                });
            }
        } catch (unhandled) {
            // Catch any unexpected throw so the interaction is always answered
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
                }
            } catch { }
            // Optional: log unhandled
            console.error('setchannels unhandled error:', unhandled);
        }
    },
};

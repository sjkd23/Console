// bot/src/commands/moderation/officer/addrole.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { getJSON } from '../../../lib/utilities/http.js';
import {
    canActorAddRole,
    getRolesActorCanAdd,
    canBotManageRole,
    type RoleKey,
} from '../../../lib/permissions/permissions.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';

/**
 * /addrole - Add a role to a member (Officer+)
 * Officers can only add roles below their rank (organizer, security)
 * Head Organizers can add officer, organizer, security
 * Moderators+ can add any staff role
 */
export const addrole: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('addrole')
        .setDescription('Add a staff role to a member (Officer+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('Member to promote')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('role')
                .setDescription('Role to add')
                .setRequired(true)
                .addChoices(
                    { name: 'Organizer', value: 'organizer' },
                    { name: 'Security', value: 'security' },
                    { name: 'Officer', value: 'officer' },
                    { name: 'Head Organizer', value: 'head_organizer' },
                    { name: 'Moderator', value: 'moderator' },
                    { name: 'Administrator', value: 'administrator' }
                )
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

            // Defer reply
            await interaction.deferReply();

            // Get command options
            const targetUser = interaction.options.getUser('member', true);
            const roleKey = interaction.options.getString('role', true) as RoleKey;

            // Fetch actor member
            let actor: GuildMember;
            try {
                actor = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again.');
                return;
            }

            // Fetch target member
            let target: GuildMember;
            try {
                target = await interaction.guild.members.fetch(targetUser.id);
            } catch {
                await interaction.editReply('❌ Could not fetch target member. They may not be in this server.');
                return;
            }

            // Check if actor can add this role
            const canAdd = await canActorAddRole(actor, roleKey);
            if (!canAdd) {
                const allowedRoles = await getRolesActorCanAdd(actor);
                await interaction.editReply(
                    '❌ **Permission Denied**\n\n' +
                    `You cannot add the **${roleKey}** role.\n\n` +
                    `You can only add roles below your rank:\n` +
                    (allowedRoles.length > 0 
                        ? allowedRoles.map(r => `• ${r}`).join('\n')
                        : '• None')
                );
                return;
            }

            // Get guild role mappings
            const { roles } = await getJSON<{ roles: Record<string, string | null> }>(
                `/guilds/${interaction.guildId}/roles`
            );

            const discordRoleId = roles[roleKey];
            if (!discordRoleId) {
                await interaction.editReply(
                    `❌ **Role Not Configured**\n\n` +
                    `The **${roleKey}** role is not configured in this server.\n` +
                    `Use \`/setroles\` to configure it first.`
                );
                return;
            }

            // Check if target already has the role
            if (target.roles.cache.has(discordRoleId)) {
                await interaction.editReply(
                    `⚠️ **Already Has Role**\n\n` +
                    `<@${target.id}> already has the <@&${discordRoleId}> role.`
                );
                return;
            }

            // Check if bot can manage this role
            const botCheck = await canBotManageRole(interaction.guild, discordRoleId);
            if (!botCheck.canManage) {
                await interaction.editReply(
                    `❌ **Cannot Manage Role**\n\n` +
                    `${botCheck.reason}\n\n` +
                    `Ask a server administrator to move the bot's role above <@&${discordRoleId}>.`
                );
                return;
            }

            // Add the role
            try {
                await target.roles.add(discordRoleId);
            } catch (err) {
                console.error('[AddRole] Failed to add role:', err);
                await interaction.editReply(
                    '❌ **Failed to Add Role**\n\n' +
                    'An error occurred while adding the role. Please try again.'
                );
                return;
            }

            // Get role name for display
            const role = await interaction.guild.roles.fetch(discordRoleId);
            const roleName = role?.name || roleKey;

            // Send notification to staff-updates channel if configured
            let staffUpdatesMessageLink: string | null = null;
            try {
                const { channels } = await getJSON<{ channels: Record<string, string | null> }>(
                    `/guilds/${interaction.guildId}/channels`
                );

                const staffUpdatesChannelId = channels.staff_updates;
                if (staffUpdatesChannelId) {
                    const staffUpdatesChannel = await interaction.guild.channels.fetch(staffUpdatesChannelId);
                    if (staffUpdatesChannel?.isTextBased()) {
                        const staffUpdateMessage = await staffUpdatesChannel.send(
                            `<@${target.id}> has been promoted to **${roleName}**!`
                        );
                        // Create message link
                        staffUpdatesMessageLink = `https://discord.com/channels/${interaction.guildId}/${staffUpdatesChannelId}/${staffUpdateMessage.id}`;
                    }
                }
            } catch (err) {
                console.error('[AddRole] Failed to send staff-updates notification:', err);
                // Don't fail the command if notification fails
            }

            // Send success message with link to staff-updates message if available
            const successMessage = staffUpdatesMessageLink
                ? `✅ **Role Added**\n\n<@${target.id}> has been promoted to **${roleName}**!\n\n[View announcement in staff-updates](${staffUpdatesMessageLink})`
                : `✅ **Role Added**\n\n<@${target.id}> has been promoted to **${roleName}**!`;
            
            await interaction.editReply(successMessage);

            // Log command execution
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    target_user_id: target.id,
                    role_key: roleKey,
                    role_id: discordRoleId,
                },
            });

        } catch (err) {
            console.error('[AddRole] Unexpected error:', err);
            const content = '❌ An unexpected error occurred. Please try again.';
            
            if (interaction.deferred) {
                await interaction.editReply(content);
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral });
            }
        }
    },
};

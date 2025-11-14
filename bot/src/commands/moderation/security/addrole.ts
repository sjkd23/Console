// bot/src/commands/moderation/security/addrole.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { canActorTargetMember, getMemberRoleIds, canBotManageRole } from '../../../lib/permissions/permissions.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';

/**
 * /addrole - Manually add a Discord role to a member.
 * Security+ command (requires Security role or higher).
 * Checks role hierarchy to ensure both bot and invoker can manage the role.
 */
export const addrole: SlashCommand = {
    requiredRole: 'security',
    mutatesRoles: true,
    data: new SlashCommandBuilder()
        .setName('addrole')
        .setDescription('Add a Discord role to a member (Security+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The Discord member to add the role to')
                .setRequired(true)
        )
        .addRoleOption(option =>
            option
                .setName('role')
                .setDescription('The role to add')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('reason')
                .setDescription('Reason for adding this role')
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
        let invokerMember: GuildMember;
        try {
            invokerMember = await interaction.guild.members.fetch(interaction.user.id);
        } catch {
            await interaction.reply({
                content: '❌ Could not fetch your member information.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Get options
        const targetUser = interaction.options.getUser('member', true);
        const role = interaction.options.getRole('role', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';

        // Validate role is actually a Role
        if (!role || typeof role === 'string') {
            await interaction.reply({
                content: '❌ Invalid role specified.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Ensure target is in this guild
        let targetMember: GuildMember;
        try {
            targetMember = await interaction.guild.members.fetch(targetUser.id);
        } catch {
            await interaction.reply({
                content: `❌ <@${targetUser.id}> is not a member of this server.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Check if member already has the role
        if (targetMember.roles.cache.has(role.id)) {
            await interaction.reply({
                content: `❌ <@${targetUser.id}> already has the role <@&${role.id}>.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Defer reply (role operations may take a moment)
        await interaction.deferReply();

        // Check if invoker can target the member (role hierarchy)
        try {
            const targetCheck = await canActorTargetMember(invokerMember, targetMember, {
                allowSelf: true,
                checkBotPosition: true
            });
            if (!targetCheck.canTarget) {
                await interaction.editReply(`❌ **Cannot Target Member**\n\n${targetCheck.reason}`);
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: 'Cannot target member due to role hierarchy'
                });
                return;
            }
        } catch (hierarchyErr) {
            console.error('[AddRole] Role hierarchy check failed:', hierarchyErr);
            await interaction.editReply('❌ Failed to verify role hierarchy. Please try again.');
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Role hierarchy check failed'
            });
            return;
        }

        // Check if the role exists in Discord
        const roleExists = await interaction.guild.roles.fetch(role.id);
        if (!roleExists) {
            await interaction.editReply(`❌ **Role Not Found**\n\nThe role <@&${role.id}> no longer exists in this server.`);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Role not found'
            });
            return;
        }

        // Check if bot can manage this role
        const botRoleCheck = await canBotManageRole(interaction.guild, role.id);
        if (!botRoleCheck.canManage) {
            await interaction.editReply(`❌ **Cannot Manage Role**\n\n${botRoleCheck.reason}`);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Cannot manage role'
            });
            return;
        }

        // Check if invoker can manage this role (their highest role must be above the target role)
        const invokerHighestRole = invokerMember.roles.highest;
        if (role.position >= invokerHighestRole.position && interaction.guild.ownerId !== interaction.user.id) {
            await interaction.editReply(`❌ **Cannot Manage Role**\n\nYou cannot assign a role that is equal to or higher than your highest role.\n\nYour highest role: <@&${invokerHighestRole.id}> (position ${invokerHighestRole.position})\nTarget role: <@&${role.id}> (position ${role.position})`);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Invoker role position too low'
            });
            return;
        }

        try {
            // Add the role
            const auditReason = `Added by ${interaction.user.tag} - ${reason}`;
            await targetMember.roles.add(role.id, auditReason);

            // Build success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ Role Added')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Role', value: `<@&${role.id}>`, inline: true },
                    { name: 'Added By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    'Target': `<@${targetUser.id}>`,
                    'Role': `<@&${role.id}>`,
                    'Reason': reason
                }
            });
        } catch (err: any) {
            let errorMessage = '❌ **Failed to add role**\n\n';
            
            if (err?.code === 50013) {
                errorMessage += '**Issue:** Missing permissions to assign role.\n\n';
                errorMessage += 'The bot may lack **Manage Roles** permission, or the role may be higher than the bot\'s highest role.';
            } else {
                console.error('[AddRole] Failed to add role:', err);
                errorMessage += 'An unexpected error occurred. Please try again later.';
            }

            await interaction.editReply(errorMessage);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: err?.code === 50013 ? 'Missing permissions' : 'Unknown error'
            });
        }
    },
};

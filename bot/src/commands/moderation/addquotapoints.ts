// bot/src/commands/moderation/addquotapoints.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { adjustQuotaPoints } from '../../lib/http.js';
import { ensureGuildContext, validateGuildMember, fetchGuildMember } from '../../lib/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/error-handler.js';
import { logCommandExecution, logQuotaAction } from '../../lib/bot-logger.js';

/**
 * /addquotapoints - Manually adjust quota points for a member.
 * Officer+ command (requires Officer role or higher).
 * Supports negative values to deduct points.
 */
export const addquotapoints: SlashCommand = {
    requiredRole: 'officer',
    data: new SlashCommandBuilder()
        .setName('addquotapoints')
        .setDescription('Manually adjust quota points for a member (Officer+)')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to add (use negative numbers to subtract)')
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to adjust points for (defaults to yourself)')
                .setRequired(false)
        ),

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Get options
        const amount = interaction.options.getInteger('amount', true);
        const targetUser = interaction.options.getUser('member') || interaction.user;

        // Validation
        if (amount === 0) {
            await interaction.reply({
                content: '❌ Amount cannot be 0.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Ensure target is in this guild
        const targetMember = await validateGuildMember(interaction, guild, targetUser.id, `<@${targetUser.id}>`);
        if (!targetMember) return;

        // Defer reply (backend call may take a moment, permission check done by middleware)
        await interaction.deferReply();

        try {
            // Fetch invoker member for actor_roles
            const invokerMember = await fetchGuildMember(guild, interaction.user.id);
            if (!invokerMember) {
                await interaction.editReply('❌ Could not fetch your member information.');
                return;
            }
            
            const actorRoles = getMemberRoleIds(invokerMember);
            
            // Call backend to adjust quota points
            const result = await adjustQuotaPoints(
                guild.id,
                targetUser.id,
                {
                    actor_user_id: interaction.user.id,
                    actor_roles: actorRoles,
                    amount,
                }
            );

            // Build success embed
            const actionText = amount > 0 ? 'Added' : 'Deducted';
            const actionEmoji = amount > 0 ? '➕' : '➖';
            
            const embed = new EmbedBuilder()
                .setTitle(`${actionEmoji} Quota Points ${actionText}`)
                .setColor(amount > 0 ? 0x00ff00 : 0xff9900)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Amount Adjusted', value: `${amount > 0 ? '+' : ''}${amount}`, inline: true },
                    { name: 'New Total', value: `${result.new_total}`, inline: true },
                    { name: 'Adjusted By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log
            await logQuotaAction(
                interaction.client,
                guild.id,
                'Manual Adjustment',
                interaction.user.id,
                targetUser.id,
                amount
            );
            await logCommandExecution(interaction.client, interaction, { success: true });
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to adjust quota points',
            });
            await interaction.editReply(errorMessage);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Failed to adjust quota points'
            });
        }
    },
};

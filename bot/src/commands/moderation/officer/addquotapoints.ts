// bot/src/commands/moderation/addquotapoints.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { adjustQuotaPoints } from '../../../lib/utilities/http.js';
import { ensureGuildContext, validateGuildMember, fetchGuildMember } from '../../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../../lib/errors/error-handler.js';
import { logCommandExecution, logQuotaAction } from '../../../lib/logging/bot-logger.js';
import { validateAndCapAmount, CAPS } from '../../../lib/validation/amount-validation.js';

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
        .addNumberOption(option =>
            option
                .setName('amount')
                .setDescription(`Amount to add (max: ${CAPS.POINTS_QUOTA}, use negative to subtract)`)
                .setMinValue(-CAPS.POINTS_QUOTA)
                .setMaxValue(CAPS.POINTS_QUOTA)
                .setRequired(true)
        )
        .addRoleOption(option => option
            .setName('quota_role')
            .setDescription('Quota role whose accounting should receive this correction')
            .setRequired(true))
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
        let amount = interaction.options.getNumber('amount', true);
        const quotaRole = interaction.options.getRole('quota_role', true);
        const targetUser = interaction.options.getUser('member') || interaction.user;

        // Validate and cap amount
        const cappedAmount = validateAndCapAmount(amount, CAPS.POINTS_QUOTA);
        if (cappedAmount === null) {
            await interaction.reply({
                content: '❌ Amount cannot be 0.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Track if amount was capped
        const wasCapped = cappedAmount !== amount;
        amount = cappedAmount;

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
                    actor_has_admin_permission: invokerMember.permissions.has(PermissionFlagsBits.Administrator),
                    amount,
                    quota_role_id: quotaRole.id,
                }
            );

            // Build success embed
            const adjustedAmount = result.amount_adjusted;
            const actionText = adjustedAmount > 0 ? 'Added' : adjustedAmount < 0 ? 'Deducted' : 'Unchanged';
            const actionEmoji = adjustedAmount > 0 ? '➕' : adjustedAmount < 0 ? '➖' : 'ℹ️';
            
            const embed = new EmbedBuilder()
                .setTitle(`${actionEmoji} Quota Points ${actionText}`)
                .setColor(adjustedAmount > 0 ? 0x00ff00 : adjustedAmount < 0 ? 0xff9900 : 0x808080)
                .addFields(
                    { name: 'Member', value: `<@${targetUser.id}>`, inline: true },
                    { name: 'Amount Adjusted', value: `${adjustedAmount > 0 ? '+' : ''}${adjustedAmount}`, inline: true },
                    { name: 'New Total', value: `${result.new_total}`, inline: true },
                    { name: 'Quota Role', value: `<@&${quotaRole.id}>`, inline: true },
                    { name: 'Adjusted By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();

            // Add warning footer if amount was capped
            if (wasCapped) {
                embed.setFooter({ text: `⚠️ Amount was capped at ${CAPS.POINTS_QUOTA} (max allowed)` });
            }

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
                adjustedAmount
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

import {
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { ensureGuildContext } from '../../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../../lib/errors/error-handler.js';
import { recoverOrganizerMinutes } from '../../../lib/utilities/http.js';
import { formatPoints } from '../../../lib/utilities/format-helpers.js';
import { updateQuotaPanelForRole } from '../../../lib/ui/quota-panel.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';

export const logminutes: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('logminutes')
        .setDescription('Recover your minute quota for an ended run')
        .addIntegerOption(option => option
            .setName('run')
            .setDescription('Run reference from the organizer minute record')
            .setMinValue(1)
            .setRequired(true))
        .addIntegerOption(option => option
            .setName('minutes')
            .setDescription('Minutes to log, up to the recorded run duration')
            .setMinValue(1)
            .setRequired(true)),

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const runId = interaction.options.getInteger('run', true);
        const selectedMinutes = interaction.options.getInteger('minutes', true);
        try {
            const { settlement, alreadyConfirmed } = await recoverOrganizerMinutes(runId, guild.id, {
                actorId: interaction.user.id,
                selectedMinutes,
            });

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(alreadyConfirmed ? 'Minutes Already Logged' : '✅ Minute Quota Logged')
                    .setColor(0x00a86b)
                    .setDescription(
                        `${alreadyConfirmed ? 'These minutes have already been logged.' : 'Your minutes have been logged.'}\n\n` +
                        `**Run:** ${settlement.runId}\n` +
                        `**Logged:** ${settlement.selectedMinutes} ${settlement.selectedMinutes === 1 ? 'minute' : 'minutes'}\n` +
                        `**Awarded:** ${formatPoints(settlement.selectedPoints)} quota points`
                    )
                    .setTimestamp()],
            });

            await updateQuotaPanelForRole(interaction.client, guild.id, settlement.quotaRoleId);
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    Run: String(settlement.runId),
                    Minutes: String(settlement.selectedMinutes),
                    'Quota Points': formatPoints(settlement.selectedPoints),
                    Result: alreadyConfirmed ? 'Already logged' : 'Logged',
                },
            }).catch(error => console.warn('[LogMinutes] Failed to write command log:', error));
        } catch (error) {
            await interaction.editReply(formatErrorMessage({
                error,
                baseMessage: 'Failed to log minute quota',
                errorHandlers: {
                    NOT_ORIGINAL_ORGANIZER: 'Only the original organizer can log minutes for this run.',
                    SETTLEMENT_CANCELLED: 'Minute logging was cancelled and cannot be recovered with `/logminutes`.',
                },
            }));
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Failed to log minute quota',
            }).catch(logError => console.warn('[LogMinutes] Failed to write command error log:', logError));
        }
    },
};

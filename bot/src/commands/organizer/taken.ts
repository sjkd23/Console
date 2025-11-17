import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { postJSON, getActiveRunsByOrganizer } from '../../lib/utilities/http.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { logScreenshotSubmission } from '../../lib/logging/raid-logger.js';
import { createLogger } from '../../lib/logging/logger.js';

const logger = createLogger('TakenCommand');

export const taken: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('taken')
        .setDescription('Submit an Oryx 3 completion screenshot for your currently active run (Organizer only).')
        .addAttachmentOption(o =>
            o.setName('screenshot')
                .setDescription('Fullscreen taken screenshot with /who and /server visible in chat')
                .setRequired(true)
        ),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Fetch member for role IDs (permission check done by middleware)
        const member = await fetchGuildMember(guild, interaction.user.id);
        if (!member) {
            await interaction.reply({
                content: 'Could not fetch your member information.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Get the screenshot attachment
        const screenshot = interaction.options.getAttachment('screenshot', true);

        // Validate that it's an image
        if (!screenshot.contentType?.startsWith('image/')) {
            await interaction.editReply(
                '❌ **Invalid file type**\n\n' +
                'Please upload a valid image file (PNG, JPG, GIF, or WebP).'
            );
            return;
        }

        // Find the organizer's currently active run
        let activeRun: {
            id: number;
            dungeonLabel: string;
            status: string;
            createdAt: string;
            channelId: string;
            postMessageId: string | null;
        } | null = null;

        try {
            const { activeRuns } = await getActiveRunsByOrganizer(guild.id, interaction.user.id);
            
            if (activeRuns.length === 0) {
                await interaction.editReply(
                    '❌ **No Active Run Found**\n\n' +
                    'You don\'t currently have an active run. Start an Oryx 3 run first, then use `/taken` to submit your screenshot.'
                );
                return;
            }

            if (activeRuns.length > 1) {
                // This shouldn't happen due to the one-run-per-organizer rule, but handle it gracefully
                logger.error('Multiple active runs detected for organizer', {
                    guildId: guild.id,
                    organizerId: interaction.user.id,
                    activeRunCount: activeRuns.length
                });
                await interaction.editReply(
                    '❌ **Multiple Active Runs Detected**\n\n' +
                    'This is unexpected. Please contact a server admin for assistance.\n\n' +
                    '**Technical info:** You have multiple active runs, but the system should only allow one at a time.'
                );
                return;
            }

            activeRun = activeRuns[0];

            // Verify it's an Oryx 3 run (optional but good UX)
            // The backend will also enforce this, but we can give better feedback upfront
            // Note: We don't have dungeonKey in the activeRun response, but we can check the label
            if (!activeRun.dungeonLabel.toLowerCase().includes('oryx') || !activeRun.dungeonLabel.includes('3')) {
                await interaction.editReply(
                    '❌ **Not an Oryx 3 Run**\n\n' +
                    `Your active run is for **${activeRun.dungeonLabel}**, which doesn\'t require a completion screenshot.\n\n` +
                    'Screenshot submissions are only required for Oryx 3 runs.'
                );
                return;
            }
        } catch (err) {
            logger.error('Failed to fetch active runs', {
                guildId: guild.id,
                organizerId: interaction.user.id,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
            });
            await interaction.editReply(
                '❌ **Failed to check your active runs**\n\n' +
                'There was an error checking your runs. Please try again in a moment.'
            );
            return;
        }

        // Submit the screenshot to the backend
        try {
            await postJSON(
                `/runs/${activeRun.id}/screenshot`,
                {
                    actorId: interaction.user.id,
                    actorRoles: getMemberRoleIds(member),
                    screenshotUrl: screenshot.url,
                },
                { guildId: guild.id }
            );

            // Log to raid-log thread
            try {
                await logScreenshotSubmission(
                    interaction.client,
                    {
                        guildId: guild.id,
                        organizerId: interaction.user.id,
                        organizerUsername: interaction.user.username,
                        dungeonName: activeRun.dungeonLabel,
                        type: 'run',
                        runId: activeRun.id
                    },
                    screenshot.url,
                    interaction.user.id
                );
            } catch (e) {
                logger.error('Failed to log screenshot to raid-log', {
                    guildId: guild.id,
                    runId: activeRun.id,
                    userId: interaction.user.id,
                    error: e instanceof Error ? e.message : String(e)
                });
            }

            // Success!
            await interaction.editReply(
                '✅ **Oryx 3 Completion Screenshot Received**\n\n' +
                'Your screenshot has been submitted and linked to your current run.\n\n' +
                '**Important:** Make sure it was fullscreen and shows `/who` and `/server` in chat—staff will review it.\n\n' +
                'You can now start your run using the "Start" button in the Organizer Panel.'
            );

            logger.info('Screenshot submitted via /taken command', {
                guildId: guild.id,
                runId: activeRun.id,
                userId: interaction.user.id,
                dungeonName: activeRun.dungeonLabel,
                screenshotUrl: screenshot.url,
                screenshotSize: screenshot.size,
                screenshotType: screenshot.contentType
            });
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to submit screenshot',
                errorHandlers: {
                    'NOT_ORGANIZER': '**Issue:** You don\'t have permission to submit a screenshot for this run.\n\n**What to do:**\n• Make sure you\'re the organizer of the active run\n• Contact a server admin if you believe this is an error',
                    'RUN_NOT_FOUND': '**Issue:** Could not find your active run.\n\n**What to do:**\n• Make sure your run is still active (not ended or cancelled)\n• Try creating a new run if needed',
                },
            });
            await interaction.editReply(errorMessage);

            logger.error('Failed to submit screenshot via /taken command', {
                guildId: guild.id,
                runId: activeRun?.id,
                userId: interaction.user.id,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined
            });
        }
    }
};

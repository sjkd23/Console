import { ButtonInteraction, MessageFlags } from 'discord.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getJSON } from '../../../lib/utilities/http.js';

/**
 * Handle the "Submit Screenshot" button click.
 * Shows an ephemeral message with instructions to use /taken command.
 */
export async function handleScreenshotButton(btn: ButtonInteraction, runId: string) {
    const guildId = btn.guildId;
    if (!guildId || !btn.guild) {
        await btn.reply({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Fetch run details
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);

    if (!run) {
        await btn.reply({
            content: '❌ Could not fetch run details.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Authorization check
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.reply({
            content: accessCheck.errorMessage,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Check if screenshot already submitted
    if (run.screenshotUrl) {
        await btn.reply({
            content: '✅ Screenshot has already been submitted for this run.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Show instructions for using /taken command
    await btn.reply({
        content:
            '📸 **Submit Your Oryx 3 Completion Screenshot**\n\n' +
            'To submit your screenshot, use the `/taken` command in this channel:\n\n' +
            '**How to submit:**\n' +
            '1. Type `/taken` in this channel\n' +
            '2. Attach your screenshot using the `screenshot` option\n' +
            '3. Make sure the screenshot is **fullscreen** and shows both `/who` and `/server` commands visible in the in-game chat\n\n' +
            '**Why is this required?**\n' +
            'Oryx 3 runs require completion proof for verification purposes. ' +
            'The screenshot must be fullscreen with `/who` and `/server` visible in chat so staff can verify the completion.\n\n' +
            '⏱️ **You must submit a screenshot before starting the run.**',
        flags: MessageFlags.Ephemeral
    });
}

import { ButtonInteraction, MessageFlags } from 'discord.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getJSON } from '../../../lib/utilities/http.js';
import { sendRunPing } from '../../../lib/utilities/run-ping.js';

/**
 * Handles the "Ping Raiders" button in the organizer panel.
 * Sends a ping message mentioning the run role and linking to the raid panel.
 */
export async function handlePingRaiders(btn: ButtonInteraction, runId: string) {
    // Defer the update so we can send a follow-up message
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    // Fetch run details for authorization
    const run = await getJSON<{
        organizerId: string;
        status: string;
        dungeonLabel: string;
    }>(`/runs/${runId}`).catch(() => null);

    if (!run) {
        await btn.editReply('Could not fetch run details.');
        return;
    }

    // Authorization check
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply(accessCheck.errorMessage || 'You do not have permission to perform this action.');
        return;
    }

    // Check that the run is live
    if (run.status !== 'live') {
        await btn.editReply('❌ You can only ping raiders when the run is live.');
        return;
    }

    if (!btn.guild) {
        await btn.editReply('This command can only be used in a server.');
        return;
    }

    // Send the ping message
    const pingMessageId = await sendRunPing(btn.client, parseInt(runId), btn.guild, 'ping');

    if (pingMessageId) {
        await btn.editReply('✅ Raiders have been pinged!');
    } else {
        await btn.editReply('❌ Failed to send ping message. Check bot permissions.');
    }
}

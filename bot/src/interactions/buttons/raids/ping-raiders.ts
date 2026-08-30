import { ButtonInteraction, MessageFlags } from 'discord.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getRunDetails } from '../../../lib/utilities/http.js';
import { sendRunPing } from '../../../lib/utilities/run-ping.js';
import { refreshOrganizerPanel } from './organizer-panel.js';

/**
 * Handles the "Ping Raiders" button in the organizer panel.
 * Sends a ping message mentioning the run role and linking to the raid panel.
 */
export async function handlePingRaiders(btn: ButtonInteraction, runId: string) {
    // Defer the update so we can edit the organizer panel
    await btn.deferUpdate();

    // Fetch run details for authorization
    const run = await getRunDetails(runId, btn.guildId ?? undefined).catch(() => null);

    if (!run) {
        await btn.editReply({
            content: 'Could not fetch run details.',
            embeds: [],
            components: []
        });
        return;
    }

    // Authorization check
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply({
            content: accessCheck.errorMessage || 'You do not have permission to perform this action.',
            embeds: [],
            components: []
        });
        return;
    }

    // Check that the run is live
    if (run.status !== 'live') {
        await refreshOrganizerPanel(btn, runId, '❌ You can only ping raiders when the run is live.');
        return;
    }

    if (!btn.guild) {
        await btn.editReply({
            content: 'This command can only be used in a server.',
            embeds: [],
            components: []
        });
        return;
    }

    // Send the ping message
    const pingMessageId = await sendRunPing(btn.client, parseInt(runId), btn.guild, 'ping');

    if (pingMessageId) {
        await refreshOrganizerPanel(btn, runId, '✅ Raiders have been pinged!');
    } else {
        await refreshOrganizerPanel(btn, runId, '❌ Failed to send ping message. Check bot permissions.');
    }
}

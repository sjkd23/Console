import { ButtonInteraction, MessageFlags } from 'discord.js';
import { getRunDetails, patchJSON } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { updateRunPublicPanel } from '../../../lib/utilities/run-public-panel-updater.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { withButtonLock, getRunLockKey } from '../../../lib/utilities/button-mutex.js';

const logger = createLogger('LockJoin');

/**
 * Handle the Lock/Unlock Join button press.
 * Toggles the join_locked state for a run, preventing or allowing users to join.
 */
export async function handleLockJoin(btn: ButtonInteraction, runId: string) {
    // Defer update so we can edit the organizer panel
    await btn.deferUpdate();

    // CRITICAL: Wrap in mutex to prevent concurrent state changes
    const executed = await withButtonLock(btn, getRunLockKey('lockjoin', runId), async () => {
        await handleLockJoinInternal(btn, runId);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

async function handleLockJoinInternal(btn: ButtonInteraction, runId: string) {
    const guildId = btn.guildId;
    if (!guildId) {
        await btn.editReply({ content: '❌ This command can only be used in a server.', components: [] });
        return;
    }

    // Fetch run info to check authorization and current state
    const run = await getRunDetails(runId, guildId).catch(() => null);

    if (!run) {
        await btn.editReply({ content: '❌ Could not fetch run details.', components: [] });
        return;
    }

    // Check if run is still active
    if (run.status === 'ended') {
        await btn.editReply({ content: '❌ This run has ended.', components: [] });
        return;
    }

    // Authorization check using centralized helper
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply({
            content: accessCheck.errorMessage,
            components: []
        });
        return;
    }

    // Toggle the join_locked state
    const newLockState = !run.joinLocked;

    try {
        // Get member for role IDs (guild is guaranteed to exist at this point)
        if (!btn.guild) {
            await btn.editReply({ content: '❌ This command can only be used in a server.', components: [] });
            return;
        }
        
        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        
        // Update the backend with authorization
        await patchJSON(`/runs/${runId}/join-locked`, {
            actorId: btn.user.id,
            actorRoles: getMemberRoleIds(member),
            joinLocked: newLockState
        }, { guildId });

        // Refresh the organizer panel with confirmation message
        const confirmationMessage = newLockState 
            ? '🔒 **Join button locked.** New users cannot join.'
            : '🔓 **Join button unlocked.** Users can now join.';
        
        await refreshOrganizerPanel(btn, runId, confirmationMessage);

        // Update the public run panel to reflect the new join button state
        if (run.channelId && run.postMessageId) {
            await updateRunPublicPanel(
                btn.client,
                guildId,
                run.channelId,
                run.postMessageId,
                parseInt(runId)
            );
        }

        logger.info('Join lock toggled', {
            guildId,
            runId,
            organizerId: btn.user.id,
            newState: newLockState
        });
    } catch (err) {
        logger.error('Failed to toggle join lock', {
            guildId,
            runId,
            error: err instanceof Error ? err.message : String(err)
        });

        await btn.editReply({
            content: '❌ Failed to update join lock state. Please try again.',
            components: []
        });
    }
}

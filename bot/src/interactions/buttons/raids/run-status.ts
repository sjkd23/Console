import { ButtonInteraction, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getJSON, patchJSON, deleteJSON, BackendError, getRolePositions } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/utilities/key-emoji-helpers.js';
import { logRunStatusChange, clearLogThreadCache, updateThreadStarterWithEndTime } from '../../../lib/logging/raid-logger.js';
import { deleteRunRole } from '../../../lib/utilities/run-role-manager.js';
import { sendRunPing } from '../../../lib/utilities/run-ping.js';
import { withButtonLock, getRunLockKey } from '../../../lib/utilities/button-mutex.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { clearRunReactions } from '../../../lib/utilities/run-reactions.js';
import { updateQuotaPanelsForUser } from '../../../lib/ui/quota-panel.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { clearOrganizerPanelsForRun } from '../../../lib/state/organizer-panel-tracker.js';
import { transitionRunEmbed } from '../../../lib/utilities/run-panel-builder.js';

const logger = createLogger('RunStatus');

export async function handleStatus(
    btn: ButtonInteraction,
    runId: string,
    status: 'live' | 'ended' | 'cancelled'
) {
    // For button interactions, use deferUpdate so we can edit the original ephemeral panel later.
    await btn.deferUpdate();

    // CRITICAL: Wrap in mutex to prevent concurrent status changes
    const executed = await withButtonLock(btn, getRunLockKey(status, runId), async () => {
        await handleStatusInternal(btn, runId, status);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

/**
 * Internal handler for run status changes (protected by mutex).
 */
async function handleStatusInternal(
    btn: ButtonInteraction,
    runId: string,
    status: 'live' | 'ended' | 'cancelled'
) {

    // Fetch run info first to check authorization
    const run = await getJSON<{
        channelId: string | null;
        postMessageId: string | null;
        dungeonKey: string;
        dungeonLabel: string;
        organizerId: string;
        status: string;
        startedAt: string | null;
        endedAt: string | null;
        createdAt: string;
        autoEndMinutes: number;
        keyWindowEndsAt: string | null;
        party: string | null;
        location: string | null;
        description: string | null;
        roleId: string | null;
        pingMessageId: string | null;
        keyPopCount: number;
        chainAmount: number | null;
    }>(`/runs/${runId}`).catch(() => null);

    if (!run) {
        await btn.editReply({ content: 'Could not fetch run details.', components: [] });
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

    // Get member for role IDs
    if (!btn.guild) {
        await btn.editReply({ content: 'This command can only be used in a server.', components: [] });
        return;
    }

    const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
    const organizerMember = await btn.guild.members.fetch(run.organizerId).catch(() => null);
    const guildId = btn.guildId!;

    // 1) Update backend status (PATCH for live/ended, DELETE for cancelled) with actorId
    //    Backend will verify that btn.user.id === run.organizer_id OR has organizer role
    try {
        if (status === 'cancelled') {
            await deleteJSON(`/runs/${runId}`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member)
            }, { guildId });
        } else {
            await patchJSON(`/runs/${runId}`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member),
                actorRolePositions: member ? getRolePositions(member) : undefined,
                organizerRoles: organizerMember ? getMemberRoleIds(organizerMember) : undefined,
                organizerRolePositions: organizerMember ? getRolePositions(organizerMember) : undefined,
                status
            }, { guildId });
        }

        // Auto-update quota panels for the organizer after run ends
        // This awards quota points via the backend transaction and updates the panel
        if (status === 'ended') {
            logger.debug('Triggering quota panel update for organizer after run end', {
                runId,
                guildId,
                organizerId: run.organizerId
            });
            
            // Run asynchronously to not block the response
            updateQuotaPanelsForUser(
                btn.client,
                guildId,
                run.organizerId
            ).then(() => {
                logger.debug('Successfully updated quota panel after run end', {
                    runId,
                    guildId,
                    organizerId: run.organizerId
                });
            }).catch(err => {
                logger.error('Failed to auto-update quota panel after run end', {
                    runId,
                    guildId,
                    organizerId: run.organizerId,
                    error: err instanceof Error ? err.message : String(err)
                });
            });
        }
    } catch (err) {
        if (err instanceof BackendError) {
            if (err.code === 'NOT_ORGANIZER') {
                // This is a critical auth error, can close the panel
                await btn.editReply({ content: 'Only the organizer can perform this action.', components: [] });
                return;
            }
            if (err.code === 'MISSING_PARTY_LOCATION') {
                const errorData = (err as any).data;
                const missing: string[] = [];
                if (errorData?.missing?.party) missing.push('**Party**');
                if (errorData?.missing?.location) missing.push('**Location**');

                logger.info('Run start blocked - missing party/location', {
                    runId,
                    guildId,
                    userId: btn.user.id,
                    missingParty: errorData?.missing?.party,
                    missingLocation: errorData?.missing?.location
                });

                // Show error in the panel itself
                await refreshOrganizerPanel(
                    btn, 
                    runId, 
                    `❌ **Cannot Start Run**\n\n` +
                    `You must set ${missing.join(' and ')} before starting the run.\n\n` +
                    `**How to fix:**\n` +
                    `• Use the "Set Party/Loc" button to enter party and location\n` +
                    `• Then try clicking "Start" again`
                );
                return;
            }
            if (err.code === 'MISSING_SCREENSHOT') {
                logger.info('Oryx 3 run start blocked - missing screenshot', {
                    runId,
                    guildId,
                    userId: btn.user.id
                });

                // Show error in the panel itself
                await refreshOrganizerPanel(
                    btn,
                    runId,
                    `❌ **Cannot Start Oryx 3 Run**\n\n` +
                    `You must submit a completion screenshot before starting Oryx 3 runs.\n\n` +
                    `**How to submit:**\n` +
                    `• Use the \`/taken\` command in the raid channel\n` +
                    `• Attach your screenshot with the \`screenshot\` option\n` +
                    `• Screenshot must be fullscreen showing \`/who\` and \`/server\` in chat\n\n` +
                    `**Why is this required?**\n` +
                    'O3 runs require a taken screenshot to prove that our organizers made sure to check if the location was available.\n\n' +
                    '⏱️ **You must submit a screenshot before starting the run.**'
                );
                return;
            }
        }

        // Other errors - these are unexpected, so we can close the panel
        logger.error('Failed to update run status', {
            runId,
            guildId,
            userId: btn.user.id,
            status,
            error: err instanceof Error ? err.message : String(err)
        });
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await btn.editReply({ content: `Error: ${msg}`, components: [] });
        return;
    }

    // 2) Find the public run message (channelId + postMessageId from backend)
    if (!run.channelId || !run.postMessageId) {
        await btn.editReply({ content: 'Run record missing channel/message id.', components: [] });
        return;
    }

    const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) {
        await btn.editReply({ content: 'Could not locate run channel.', components: [] });
        return;
    }

    const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
    if (!pubMsg) {
        await btn.editReply({ content: 'Public run message no longer exists.', components: [] });
        return;
    }

    const embeds = pubMsg.embeds ?? [];
    if (!embeds.length) {
        await btn.editReply({ content: 'Could not find run embed.', components: [] });
        return;
    }

    // 3) Apply UI changes
    if (status === 'live') {
        // Transition to Live: update embed with LIVE badge and started time
        const liveEmbed = transitionRunEmbed(embeds[0], 'live', run);

        // Update the public message content with party/location
        let content = '@here';
        if (run.party && run.location) {
            content += ` Party: **${run.party}** | Location: **${run.location}**`;
        } else if (run.party) {
            content += ` Party: **${run.party}**`;
        } else if (run.location) {
            content += ` Location: **${run.location}**`;
        }

        await pubMsg.edit({ content, embeds: [liveEmbed, ...embeds.slice(1)] });

        // Send ping message to notify raiders
        await sendRunPing(btn.client, parseInt(runId), btn.guild);

        // Log status change to raid-log
        try {
            await logRunStatusChange(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                status,
                btn.user.id
            );
        } catch (e) {
            console.error('Failed to log status change to raid-log:', e);
        }

        // Update the organizer panel to show Live buttons using the shared helper
        // This ensures consistency and includes all buttons (including lock/unlock join)
        await refreshOrganizerPanel(btn, runId, '✅ **Run is LIVE!**');
    } else {
        // status === 'ended' or 'cancelled'
        const endLabel = status === 'cancelled' ? 'Cancelled' : 'Ended';
        const icon = status === 'cancelled' ? '❌' : '✅';

        // Delete the run role if it exists
        if (run.roleId && btn.guild) {
            const roleDeleted = await deleteRunRole(btn.guild, run.roleId);
            if (!roleDeleted) {
                console.warn('Failed to delete run role on manual end:', {
                    runId,
                    roleId: run.roleId,
                    guildId: btn.guild.id
                });
            }
        }

        // Delete the ping message if it exists
        if (run.pingMessageId) {
            try {
                const channel = await btn.client.channels.fetch(run.channelId!).catch(() => null);
                if (channel && channel.isTextBased() && !channel.isDMBased()) {
                    const pingMessage = await (channel as any).messages.fetch(run.pingMessageId).catch(() => null);
                    if (pingMessage && pingMessage.deletable) {
                        await pingMessage.delete();
                    }
                }
            } catch (err) {
                console.error('Failed to delete ping message on run end:', err);
            }
        }

        // Build ended embed
        const endedEmbed = transitionRunEmbed(embeds[0], status === 'cancelled' ? 'cancelled' : 'ended', run);

        // Change PUBLIC MESSAGE content and remove buttons
        await pubMsg.edit({ content: endLabel, embeds: [endedEmbed, ...embeds.slice(1)], components: [] });

        // Clear all reactions from the run message
        try {
            await clearRunReactions(pubMsg);
        } catch (err) {
            logger.error('Failed to clear reactions on run end', {
                runId,
                guildId: btn.guild.id,
                messageId: pubMsg.id,
                error: err instanceof Error ? err.message : String(err)
            });
            // Don't fail the end operation if reaction clearing fails
        }

        // Clear all active organizer panels for this run
        clearOrganizerPanelsForRun(runId);

        // Log status change to raid-log
        try {
            await logRunStatusChange(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                status,
                btn.user.id
            );

            // Update the thread starter message with ended time
            await updateThreadStarterWithEndTime(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                }
            );

            // DON'T clear thread cache when ending - keep it for key logging phase
            // Thread cache will be cleared after key logging is complete or if run is cancelled
        } catch (e) {
            console.error('Failed to log status change to raid-log:', e);
        }

        // If run ended, show key logging panel
        // Calculate total keys based on dungeon configuration:
        // - For dungeons with multiple key types (e.g., Oryx 3 with 4 runes): use keyReactions.length
        // - For regular dungeons: use key_pop_count (number of times "Key Popped" was clicked, defaults to 1)
        if (status === 'ended') {
            let totalKeys = Math.max(1, run.keyPopCount);
            
            // Check if this dungeon has multiple distinct key types
            const dungeonData = await import('../../../constants/dungeons/dungeon-helpers.js')
                .then(m => m.dungeonByCode[run.dungeonKey]);
            
            if (dungeonData?.keyReactions && dungeonData.keyReactions.length > 1) {
                // For dungeons with multiple key types (like Oryx 3 with 4 runes),
                // use the number of key types defined in the dungeon configuration
                // This ensures the organizer logs all runes regardless of button clicks
                totalKeys = dungeonData.keyReactions.length;
            }
            
            logger.info('Run ended, showing key logging panel', {
                runId,
                keyPopCount: run.keyPopCount,
                totalKeys,
            });

            // Import showKeyLoggingPanel dynamically to avoid circular dependencies
            const { showKeyLoggingPanel } = await import('./key-logging.js');

            await showKeyLoggingPanel(
                btn,
                parseInt(runId),
                guildId,
                run.organizerId,
                run.dungeonKey,
                run.dungeonLabel,
                totalKeys
            );
            return;
        }

        // For cancelled runs, clear the thread cache immediately since there's no key logging phase
        if (status === 'cancelled') {
            try {
                clearLogThreadCache({
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                });
            } catch (e) {
                console.error('Failed to clear thread cache for cancelled run:', e);
            }
        }

        // Close the organizer panel with clear message
        const closureEmbed = new EmbedBuilder()
            .setTitle(`${icon} Run ${endLabel}`)
            .setDescription(`The run has ${endLabel.toLowerCase()}. This panel is now closed.`)
            .setColor(status === 'cancelled' ? 0xff0000 : 0x00ff00)
            .setTimestamp(new Date());

        await btn.editReply({ embeds: [closureEmbed], components: [] });
    }
}

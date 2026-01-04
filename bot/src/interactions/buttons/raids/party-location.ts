import {
    ButtonInteraction,
    ChannelType,
    EmbedBuilder
} from 'discord.js';
import { getJSON, patchJSON, BackendError } from '../../../lib/utilities/http.js';
import { logRunInfoUpdate } from '../../../lib/logging/raid-logger.js';
import {
    createSimpleModal,
    awaitModalSubmission,
    ensureGuildButtonContext,
    fetchMemberWithRoles,
    getModalFieldValues
} from '../../../lib/utilities/modal-helpers.js';
import { buildRunMessageContent } from '../../../lib/utilities/run-message-helpers.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { notifyKeyReactors } from '../../../lib/utilities/key-reactor-notifications.js';
import { sendEarlyLocNotification } from '../../../lib/utilities/early-loc-notifier.js';

interface RunDetails {
    channelId: string | null;
    postMessageId: string | null;
    status: string;
    dungeonKey: string;
    dungeonLabel: string;
    organizerId: string;
    startedAt: string | null;
    keyWindowEndsAt: string | null;
    party: string | null;
    location: string | null;
    description: string | null;
}

/**
 * Notifies key reactors if both party and location are now set
 * @param btn - The button interaction
 * @param runId - The run ID
 * @param run - The run details
 * @param isUpdate - Whether this is an update (true) or initial set (false)
 */
async function notifyKeyReactorsIfReady(
    btn: ButtonInteraction,
    runId: string,
    run: RunDetails,
    isUpdate: boolean
): Promise<void> {
    // Only notify if both party and location are set
    if (!run.party || !run.location) {
        return;
    }

    // Send DMs to all key reactors
    await notifyKeyReactors(
        btn.client,
        runId,
        btn.guildId!,
        run.dungeonLabel,
        run.organizerId,
        run.party,
        run.location,
        isUpdate
    );
}

/**
 * Updates the public run message content if the run is live
 */
async function updatePublicRunMessage(
    btn: ButtonInteraction,
    run: RunDetails
): Promise<void> {
    if (run.status !== 'live' || !run.channelId || !run.postMessageId) {
        return;
    }

    const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) {
        const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
        if (pubMsg) {
            const content = buildRunMessageContent(run.party, run.location);
            await pubMsg.edit({ content });
        }
    }
}

/**
 * Handle "Set Party/Loc" button press.
 * Shows a modal with both party and location inputs, updates backend, and refreshes the public message.
 * Both fields are required when using this button.
 */
export async function handleSetPartyLocation(btn: ButtonInteraction, runId: string) {
    const modal = createSimpleModal(
        `modal:partyloc:${runId}`,
        'Set Party & Location',
        [
            {
                customId: 'party',
                label: 'Party Name',
                placeholder: 'e.g., USW3, EUW2, USS, etc.',
                required: true,
                maxLength: 100
            },
            {
                customId: 'location',
                label: 'Location/Server',
                placeholder: 'e.g., O3, Bazaar, Realm, etc.',
                required: true,
                maxLength: 100
            }
        ]
    );

    const submitted = await awaitModalSubmission(btn, modal);
    if (!submitted) return;

    await submitted.deferUpdate();

    const guildCtx = await ensureGuildButtonContext(submitted);
    if (!guildCtx) return;

    const memberData = await fetchMemberWithRoles(submitted);
    if (!memberData) {
        await submitted.followUp({ content: 'Could not fetch your member information.', ephemeral: true });
        return;
    }

    const values = getModalFieldValues(submitted, ['party', 'location']);
    const party = values.party;
    const location = values.location;

    // Both fields are now required, so we always update both
    // Capture early-loc notification info from the responses
    let earlyLocNotificationData: any = null;

    try {
        const partyResponse = await patchJSON<{ ok: boolean; party: string; earlyLocNotification?: any }>(
            `/runs/${runId}/party`,
            {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                party
            },
            { guildId: guildCtx.guildId }
        );
        
        // Capture early-loc info if present
        if (partyResponse.earlyLocNotification) {
            earlyLocNotificationData = partyResponse.earlyLocNotification;
        }
    } catch (err) {
        if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
            await submitted.followUp({ content: 'Only the organizer can update party.', ephemeral: true });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await submitted.followUp({ content: `Error updating party: ${msg}`, ephemeral: true });
        return;
    }

    try {
        const locationResponse = await patchJSON<{ ok: boolean; location: string; earlyLocNotification?: any }>(
            `/runs/${runId}/location`,
            {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                location
            },
            { guildId: guildCtx.guildId }
        );
        
        // ALWAYS prefer location's notification when both are being updated
        // because it will have both the updated party AND location values
        if (locationResponse.earlyLocNotification) {
            earlyLocNotificationData = locationResponse.earlyLocNotification;
        }
    } catch (err) {
        if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
            await submitted.followUp({ content: 'Only the organizer can update location.', ephemeral: true });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await submitted.followUp({ content: `Error updating location: ${msg}`, ephemeral: true });
        return;
    }

    // Fetch updated run details
    const run = await getJSON<RunDetails>(`/runs/${runId}`);

    if (!run.channelId || !run.postMessageId) {
        await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
        return;
    }

    // Update the public message content with party/location ONLY if run is live
    await updatePublicRunMessage(btn, run);

    // Log updates to raid-log
    if (btn.guild) {
        try {
            await logRunInfoUpdate(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'party',
                party
            );
            await logRunInfoUpdate(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'location',
                location
            );
        } catch (e) {
            console.error('Failed to log party/location update to raid-log:', e);
        }
    }

    // Build confirmation message
    const confirmMsg = `✅ **Updated:**\n• Party: **${party}**\n• Location: **${location}**`;

    // Send early-loc notification if needed
    if (earlyLocNotificationData && btn.guild) {
        sendEarlyLocNotification(
            btn.client,
            btn.guild.id,
            run.organizerId,
            run.dungeonKey,
            run.dungeonLabel,
            run.channelId,
            run.postMessageId,
            earlyLocNotificationData
        ).catch(err => {
            console.error('Failed to send early-loc notification:', err);
        });
    }

    // Notify key reactors now that both party and location are set
    // The early-loc notification already told us if this was an initial SET or CHANGED
    // Use that same logic: if it was initial set, this is NOT an update for key reactors
    const isUpdate = earlyLocNotificationData ? !earlyLocNotificationData.isInitialSet : false;
    notifyKeyReactorsIfReady(btn, runId, run, isUpdate).catch(err => {
        console.error('Failed to notify key reactors:', err);
    });

    // Refresh organizer panel with confirmation message
    await refreshOrganizerPanel(submitted, runId, confirmMsg);
}

/**
 * Handle "Set Party" button press (legacy handler, kept for backwards compatibility).
 * Shows a modal for party input, updates backend, and refreshes the public message.
 */
export async function handleSetParty(btn: ButtonInteraction, runId: string) {
    const modal = createSimpleModal(
        `modal:party:${runId}`,
        'Set Party Name',
        [
            {
                customId: 'party',
                label: 'Party Name',
                placeholder: 'e.g., USW3, EUW2, USS, etc.',
                required: false,
                maxLength: 100
            }
        ]
    );

    const submitted = await awaitModalSubmission(btn, modal);
    if (!submitted) return;

    await submitted.deferUpdate();

    const guildCtx = await ensureGuildButtonContext(submitted);
    if (!guildCtx) return;

    const memberData = await fetchMemberWithRoles(submitted);
    if (!memberData) {
        await submitted.followUp({ content: 'Could not fetch your member information.', ephemeral: true });
        return;
    }

    const values = getModalFieldValues(submitted, ['party']);
    const party = values.party;

    // Update backend and capture early-loc notification info
    let earlyLocNotificationData: any = null;
    
    try {
        const partyResponse = await patchJSON<{ ok: boolean; party: string; earlyLocNotification?: any }>(
            `/runs/${runId}/party`,
            {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                party: party || ''
            },
            { guildId: guildCtx.guildId }
        );
        
        // Capture early-loc info if present
        if (partyResponse.earlyLocNotification) {
            earlyLocNotificationData = partyResponse.earlyLocNotification;
        }
    } catch (err) {
        if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
            await submitted.followUp({ content: 'Only the organizer can update party.', ephemeral: true });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await submitted.followUp({ content: `Error: ${msg}`, ephemeral: true });
        return;
    }

    // Fetch updated run details
    const run = await getJSON<RunDetails>(`/runs/${runId}`);

    if (!run.channelId || !run.postMessageId) {
        await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
        return;
    }

    // Update the public message content with party/location ONLY if run is live
    await updatePublicRunMessage(btn, run);

    // Log party update to raid-log
    if (party && btn.guild) {
        try {
            await logRunInfoUpdate(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'party',
                party
            );
        } catch (e) {
            console.error('Failed to log party update to raid-log:', e);
        }
    }

    // Refresh organizer panel with confirmation message
    const confirmMsg = party ? `✅ **Updated Party:** ${party}` : '✅ Party cleared';
    
    // Send early-loc notification if needed
    if (earlyLocNotificationData && btn.guild) {
        sendEarlyLocNotification(
            btn.client,
            btn.guild.id,
            run.organizerId,
            run.dungeonKey,
            run.dungeonLabel,
            run.channelId,
            run.postMessageId,
            earlyLocNotificationData
        ).catch(err => {
            console.error('Failed to send early-loc notification:', err);
        });
    }
    
    // Notify key reactors if both party and location are NOW set
    const isNowBothSet = !!(run.party && run.location);
    if (isNowBothSet) {
        // Use early-loc notification to determine if this was initial or update
        const isUpdate = earlyLocNotificationData ? !earlyLocNotificationData.isInitialSet : false;
        notifyKeyReactorsIfReady(btn, runId, run, isUpdate).catch(err => {
            console.error('Failed to notify key reactors:', err);
        });
    }
    
    await refreshOrganizerPanel(submitted, runId, confirmMsg);
}

/**
 * Handle "Set Location" button press.
 * Shows a modal for location input, updates backend, and refreshes the public message.
 */
export async function handleSetLocation(btn: ButtonInteraction, runId: string) {
    const modal = createSimpleModal(
        `modal:location:${runId}`,
        'Set Location',
        [
            {
                customId: 'location',
                label: 'Location/Server',
                placeholder: 'e.g., O3, Bazaar, Realm, etc.',
                required: false,
                maxLength: 100
            }
        ]
    );

    const submitted = await awaitModalSubmission(btn, modal);
    if (!submitted) return;

    await submitted.deferUpdate();

    const guildCtx = await ensureGuildButtonContext(submitted);
    if (!guildCtx) return;

    const memberData = await fetchMemberWithRoles(submitted);
    if (!memberData) {
        await submitted.followUp({ content: 'Could not fetch your member information.', ephemeral: true });
        return;
    }

    const values = getModalFieldValues(submitted, ['location']);
    const location = values.location;

    // Update backend and capture early-loc notification info
    let earlyLocNotificationData: any = null;
    
    try {
        const locationResponse = await patchJSON<{ ok: boolean; location: string; earlyLocNotification?: any }>(
            `/runs/${runId}/location`,
            {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                location: location || ''
            },
            { guildId: guildCtx.guildId }
        );
        
        // Capture early-loc info if present
        if (locationResponse.earlyLocNotification) {
            earlyLocNotificationData = locationResponse.earlyLocNotification;
        }
    } catch (err) {
        if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
            await submitted.followUp({ content: 'Only the organizer can update location.', ephemeral: true });
            return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await submitted.followUp({ content: `Error: ${msg}`, ephemeral: true });
        return;
    }

    // Fetch updated run details
    const run = await getJSON<RunDetails>(`/runs/${runId}`);

    if (!run.channelId || !run.postMessageId) {
        await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
        return;
    }

    // Update the public message content with party/location only if the run is live
    await updatePublicRunMessage(btn, run);

    // Log location update to raid-log
    if (location && btn.guild) {
        try {
            await logRunInfoUpdate(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'location',
                location
            );
        } catch (e) {
            console.error('Failed to log location update to raid-log:', e);
        }
    }

    // Refresh organizer panel with confirmation message
    const confirmMsg = location ? `✅ **Updated Location:** ${location}` : '✅ Location cleared';
    
    // Send early-loc notification if needed
    if (earlyLocNotificationData && btn.guild) {
        sendEarlyLocNotification(
            btn.client,
            btn.guild.id,
            run.organizerId,
            run.dungeonKey,
            run.dungeonLabel,
            run.channelId,
            run.postMessageId,
            earlyLocNotificationData
        ).catch(err => {
            console.error('Failed to send early-loc notification:', err);
        });
    }
    
    // Notify key reactors if both party and location are NOW set
    const isNowBothSet = !!(run.party && run.location);
    if (isNowBothSet) {
        // Use early-loc notification to determine if this was initial or update
        const isUpdate = earlyLocNotificationData ? !earlyLocNotificationData.isInitialSet : false;
        notifyKeyReactorsIfReady(btn, runId, run, isUpdate).catch(err => {
            console.error('Failed to notify key reactors:', err);
        });
    }
    
    await refreshOrganizerPanel(submitted, runId, confirmMsg);
}

/**
 * Handle "Chain Amount" button press.
 * Shows a modal for chain amount input, updates backend, and refreshes the public message.
 */
export async function handleSetChainAmount(btn: ButtonInteraction, runId: string) {
    const modal = createSimpleModal(
        `modal:chain:${runId}`,
        'Set Chain Amount',
        [
            {
                customId: 'chain',
                label: 'Total Chains',
                placeholder: 'e.g., 5 for a 5-chain',
                required: true,
                minLength: 1,
                maxLength: 2
            }
        ]
    );

    const submitted = await awaitModalSubmission(btn, modal);
    if (!submitted) return;

    // Try to defer - may fail if user took too long to submit modal (>3s timeout)
    let deferred = false;
    try {
        await submitted.deferUpdate();
        deferred = true;
    } catch (err) {
        // Interaction token expired - user took too long to submit modal
        // We can still process the request, just need to use reply instead of followUp
        console.warn('Modal submission interaction expired, will use reply instead of followUp');
    }

    const values = getModalFieldValues(submitted, ['chain']);
    const chainStr = values.chain;
    const chainAmount = parseInt(chainStr);

    // Validate input
    if (isNaN(chainAmount) || chainAmount < 1 || chainAmount > 99) {
        const msg = '❌ Chain amount must be a number between 1 and 99';
        if (deferred) {
            await submitted.followUp({ content: msg, ephemeral: true });
        } else {
            await submitted.reply({ content: msg, ephemeral: true });
        }
        return;
    }

    const guildCtx = await ensureGuildButtonContext(submitted);
    if (!guildCtx) return;

    const memberData = await fetchMemberWithRoles(submitted);
    if (!memberData) {
        const msg = 'Could not fetch your member information.';
        if (deferred) {
            await submitted.followUp({ content: msg, ephemeral: true });
        } else {
            await submitted.reply({ content: msg, ephemeral: true });
        }
        return;
    }

    // Update backend
    try {
        await patchJSON(`/runs/${runId}/chain-amount`, {
            actorId: btn.user.id,
            actorRoles: memberData.roleIds,
            chainAmount
        }, { guildId: guildCtx.guildId });
    } catch (err) {
        const msg = err instanceof BackendError && err.code === 'NOT_ORGANIZER' 
            ? 'Only the organizer can set chain amount.'
            : `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        if (deferred) {
            await submitted.followUp({ content: msg, ephemeral: true });
        } else {
            await submitted.reply({ content: msg, ephemeral: true });
        }
        return;
    }

    // Fetch updated run details
    const run = await getJSON<{
        channelId: string | null;
        postMessageId: string | null;
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        keyPopCount: number;
        chainAmount: number | null;
        keyWindowEndsAt: string | null;
    }>(`/runs/${runId}`);

    if (!run.channelId || !run.postMessageId) {
        const msg = 'Run record missing channel/message id.';
        if (deferred) {
            await submitted.followUp({ content: msg, ephemeral: true });
        } else {
            await submitted.reply({ content: msg, ephemeral: true });
        }
        return;
    }

    // Update public message title to include chain tracking
    const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) {
        const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
        if (pubMsg) {
            const embeds = pubMsg.embeds ?? [];
            if (embeds.length > 0) {
                const embed = EmbedBuilder.from(embeds[0]);
                
                // Build title with chain tracking (preserving current key_pop_count)
                const statusEmoji = run.status === 'live' ? '🟢' : '📋';
                const statusText = run.status === 'live' ? 'LIVE' : 'Starting';
                let chainText = '';
                if (run.dungeonKey !== 'ORYX_3' && run.keyPopCount > 0) {
                    if (run.chainAmount && run.keyPopCount <= run.chainAmount) {
                        chainText = ` | Chain ${run.keyPopCount}/${run.chainAmount}`;
                    } else {
                        chainText = ` | Chain ${run.keyPopCount}`;
                    }
                }
                embed.setTitle(`${statusEmoji} ${statusText}: ${run.dungeonLabel}${chainText}`);
                
                await pubMsg.edit({ embeds: [embed, ...embeds.slice(1)] });
            }
        }
    }

    // Refresh organizer panel with confirmation message
    const successMsg = `✅ **Chain amount set:** ${chainAmount}\n\nThe raid title will now show "Chain ${run.keyPopCount}/${chainAmount}" (updates as you press Key popped)`;
    if (deferred) {
        await refreshOrganizerPanel(submitted, runId, successMsg);
    } else {
        await submitted.reply({ content: successMsg, ephemeral: true });
    }
}

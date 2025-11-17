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

interface RunDetails {
    channelId: string | null;
    postMessageId: string | null;
    status: string;
    dungeonLabel: string;
    organizerId: string;
    startedAt: string | null;
    keyWindowEndsAt: string | null;
    party: string | null;
    location: string | null;
    description: string | null;
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
 * Both fields are optional and can be left blank.
 */
export async function handleSetPartyLocation(btn: ButtonInteraction, runId: string) {
    const modal = createSimpleModal(
        `modal:partyloc:${runId}`,
        'Set Party & Location',
        [
            {
                customId: 'party',
                label: 'Party Name (optional)',
                placeholder: 'e.g., USW3, EUW2, USS, etc.',
                required: false,
                maxLength: 100
            },
            {
                customId: 'location',
                label: 'Location/Server (optional)',
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

    const values = getModalFieldValues(submitted, ['party', 'location']);
    const party = values.party;
    const location = values.location;

    // Track which fields were actually updated (not empty)
    let updatedParty = false;
    let updatedLocation = false;

    // Update party only if user entered a value (not empty)
    if (party) {
        try {
            await patchJSON(`/runs/${runId}/party`, {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                party
            }, { guildId: guildCtx.guildId });
            updatedParty = true;
        } catch (err) {
            if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
                await submitted.followUp({ content: 'Only the organizer can update party.', ephemeral: true });
                return;
            }
            const msg = err instanceof Error ? err.message : 'Unknown error';
            await submitted.followUp({ content: `Error updating party: ${msg}`, ephemeral: true });
            return;
        }
    }

    // Update location only if user entered a value (not empty)
    if (location) {
        try {
            await patchJSON(`/runs/${runId}/location`, {
                actorId: btn.user.id,
                actorRoles: memberData.roleIds,
                location
            }, { guildId: guildCtx.guildId });
            updatedLocation = true;
        } catch (err) {
            if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
                await submitted.followUp({ content: 'Only the organizer can update location.', ephemeral: true });
                return;
            }
            const msg = err instanceof Error ? err.message : 'Unknown error';
            await submitted.followUp({ content: `Error updating location: ${msg}`, ephemeral: true });
            return;
        }
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
            if (updatedParty) {
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
            }
            if (updatedLocation) {
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
            }
        } catch (e) {
            console.error('Failed to log party/location update to raid-log:', e);
        }
    }

    // Build confirmation message
    let confirmMsg = '';
    if (updatedParty && updatedLocation) {
        confirmMsg = `✅ Updated:\n• Party: **${party}**\n• Location: **${location}**`;
    } else if (updatedParty) {
        confirmMsg = `✅ Updated party: **${party}**`;
    } else if (updatedLocation) {
        confirmMsg = `✅ Updated location: **${location}**`;
    } else {
        confirmMsg = '⚠️ No changes made (both fields left blank)';
    }

    await submitted.followUp({ 
        content: confirmMsg, 
        ephemeral: true 
    });
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

    // Update backend
    try {
        await patchJSON(`/runs/${runId}/party`, {
            actorId: btn.user.id,
            actorRoles: memberData.roleIds,
            party: party || ''
        }, { guildId: guildCtx.guildId });
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

    await submitted.followUp({ 
        content: party ? `✅ Party set to: **${party}**` : '✅ Party cleared', 
        ephemeral: true 
    });
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

    // Update backend
    try {
        await patchJSON(`/runs/${runId}/location`, {
            actorId: btn.user.id,
            actorRoles: memberData.roleIds,
            location: location || ''
        }, { guildId: guildCtx.guildId });
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

    await submitted.followUp({ 
        content: location ? `✅ Location set to: **${location}**` : '✅ Location cleared', 
        ephemeral: true 
    });
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

    const successMsg = `✅ Chain amount set to: **${chainAmount}**\n\nThe raid title will now show "Chain ${run.keyPopCount}/${chainAmount}" (updates as you press Key popped)`;
    if (deferred) {
        await submitted.followUp({ content: successMsg, ephemeral: true });
    } else {
        await submitted.reply({ content: successMsg, ephemeral: true });
    }
}

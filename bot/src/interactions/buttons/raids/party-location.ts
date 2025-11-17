import {
    ButtonInteraction,
    ChannelType,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ModalActionRowComponentBuilder
} from 'discord.js';
import { getJSON, patchJSON, BackendError } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib//permissions/permissions.js';
import { logRunInfoUpdate } from '../../../lib/logging/raid-logger.js';

/**
 * Handle "Set Party/Loc" button press.
 * Shows a modal with both party and location inputs, updates backend, and refreshes the public message.
 * Both fields are optional and can be left blank.
 */
export async function handleSetPartyLocation(btn: ButtonInteraction, runId: string) {
    // Show modal for party and location input
    const modal = new ModalBuilder()
        .setCustomId(`modal:partyloc:${runId}`)
        .setTitle('Set Party & Location');

    const partyInput = new TextInputBuilder()
        .setCustomId('party')
        .setLabel('Party Name (optional)')
        .setPlaceholder('e.g., USW3, EUW2, USS, etc.')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

    const locationInput = new TextInputBuilder()
        .setCustomId('location')
        .setLabel('Location/Server (optional)')
        .setPlaceholder('e.g., O3, Bazaar, Realm, etc.')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

    const row1 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(partyInput);
    const row2 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(locationInput);
    modal.addComponents(row1, row2);

    await btn.showModal(modal);

    // Wait for modal submission
    try {
        const submitted = await btn.awaitModalSubmit({
            time: 120000, // 2 minutes
            filter: i => i.customId === `modal:partyloc:${runId}` && i.user.id === btn.user.id
        });

        await submitted.deferUpdate();

        const party = submitted.fields.getTextInputValue('party').trim();
        const location = submitted.fields.getTextInputValue('location').trim();

        // Get member for role IDs
        if (!btn.guild) {
            await submitted.followUp({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        const guildId = btn.guildId!;

        // Update party if provided
        if (party !== undefined) {
            try {
                await patchJSON(`/runs/${runId}/party`, {
                    actorId: btn.user.id,
                    actorRoles: getMemberRoleIds(member),
                    party: party || ''
                }, { guildId });
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

        // Update location if provided
        if (location !== undefined) {
            try {
                await patchJSON(`/runs/${runId}/location`, {
                    actorId: btn.user.id,
                    actorRoles: getMemberRoleIds(member),
                    location: location || ''
                }, { guildId });
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
        const run = await getJSON<{
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
        }>(`/runs/${runId}`);

        if (!run.channelId || !run.postMessageId) {
            await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
            return;
        }

        // Update the public message content with party/location ONLY if run is live
        if (run.status === 'live') {
            const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
            if (ch && ch.type === ChannelType.GuildText) {
                const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
                if (pubMsg) {
                    let content = '@here';
                    if (run.party && run.location) {
                        content += ` Party: **${run.party}** | Location: **${run.location}**`;
                    } else if (run.party) {
                        content += ` Party: **${run.party}**`;
                    } else if (run.location) {
                        content += ` Location: **${run.location}**`;
                    }
                    await pubMsg.edit({ content });
                }
            }
        }

        // Log updates to raid-log
        if (btn.guild) {
            try {
                if (party) {
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
                if (location) {
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
        let confirmMsg = '✅ Updated:';
        if (party) confirmMsg += `\n• Party: **${party}**`;
        if (location) confirmMsg += `\n• Location: **${location}**`;
        if (!party && !location) confirmMsg = '✅ No changes made (both fields left blank)';

        await submitted.followUp({ 
            content: confirmMsg, 
            ephemeral: true 
        });
    } catch (err) {
        // Modal timeout or other error - no need to handle, Discord shows timeout message
    }
}

/**
 * Handle "Set Party" button press (legacy handler, kept for backwards compatibility).
 * Shows a modal for party input, updates backend, and refreshes the public message.
 */
export async function handleSetParty(btn: ButtonInteraction, runId: string) {
    // Show modal for party input
    const modal = new ModalBuilder()
        .setCustomId(`modal:party:${runId}`)
        .setTitle('Set Party Name');

    const partyInput = new TextInputBuilder()
        .setCustomId('party')
        .setLabel('Party Name')
        .setPlaceholder('e.g., USW3, EUW2, USS, etc.')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

    const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(partyInput);
    modal.addComponents(row);

    await btn.showModal(modal);

    // Wait for modal submission
    try {
        const submitted = await btn.awaitModalSubmit({
            time: 120000, // 2 minutes
            filter: i => i.customId === `modal:party:${runId}` && i.user.id === btn.user.id
        });

        await submitted.deferUpdate();

        const party = submitted.fields.getTextInputValue('party').trim();

        // Get member for role IDs
        if (!btn.guild) {
            await submitted.followUp({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        const guildId = btn.guildId!;

        // Update backend
        try {
            await patchJSON(`/runs/${runId}/party`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member),
                party: party || ''
            }, { guildId });
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
        const run = await getJSON<{
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
        }>(`/runs/${runId}`);

        if (!run.channelId || !run.postMessageId) {
            await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
            return;
        }

        // Update the public message content with party/location ONLY if run is live
        if (run.status === 'live') {
            const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
            if (ch && ch.type === ChannelType.GuildText) {
                const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
                if (pubMsg) {
                    let content = '@here';
                    if (run.party && run.location) {
                        content += ` Party: **${run.party}** | Location: **${run.location}**`;
                    } else if (run.party) {
                        content += ` Party: **${run.party}**`;
                    } else if (run.location) {
                        content += ` Location: **${run.location}**`;
                    }
                    await pubMsg.edit({ content });
                }
            }
        }

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
    } catch (err) {
        // Modal timeout or other error - no need to handle, Discord shows timeout message
    }
}

/**
 * Handle "Set Location" button press.
 * Shows a modal for location input, updates backend, and refreshes the public message.
 */
export async function handleSetLocation(btn: ButtonInteraction, runId: string) {
    // Show modal for location input
    const modal = new ModalBuilder()
        .setCustomId(`modal:location:${runId}`)
        .setTitle('Set Location');

    const locationInput = new TextInputBuilder()
        .setCustomId('location')
        .setLabel('Location/Server')
        .setPlaceholder('e.g., O3, Bazaar, Realm, etc.')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);

    const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(locationInput);
    modal.addComponents(row);

    await btn.showModal(modal);

    // Wait for modal submission
    try {
        const submitted = await btn.awaitModalSubmit({
            time: 120000, // 2 minutes
            filter: i => i.customId === `modal:location:${runId}` && i.user.id === btn.user.id
        });

        await submitted.deferUpdate();

        const location = submitted.fields.getTextInputValue('location').trim();

        // Get member for role IDs
        if (!btn.guild) {
            await submitted.followUp({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        if (!btn.guild) {
            await submitted.followUp({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        const guildId = btn.guildId!;

        // Update backend
        try {
            await patchJSON(`/runs/${runId}/location`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member),
                location: location || ''
            }, { guildId });
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
        const run = await getJSON<{
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
        }>(`/runs/${runId}`);

        if (!run.channelId || !run.postMessageId) {
            await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
            return;
        }

        // Update the public message content with party/location only if the run is live
        if (run.status === 'live') {
            const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
            if (ch && ch.type === ChannelType.GuildText) {
                const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
                if (pubMsg) {
                    let content = '@here';
                    if (run.party && run.location) {
                        content += ` Party: **${run.party}** | Location: **${run.location}**`;
                    } else if (run.party) {
                        content += ` Party: **${run.party}**`;
                    } else if (run.location) {
                        content += ` Location: **${run.location}**`;
                    }
                    await pubMsg.edit({ content });
                }
            }
        }

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
    } catch (err) {
        // Modal timeout or other error - no need to handle, Discord shows timeout message
    }
}

/**
 * Handle "Chain Amount" button press.
 * Shows a modal for chain amount input, updates backend, and refreshes the public message.
 */
export async function handleSetChainAmount(btn: ButtonInteraction, runId: string) {
    // Show modal for chain amount input
    const modal = new ModalBuilder()
        .setCustomId(`modal:chain:${runId}`)
        .setTitle('Set Chain Amount');

    const chainInput = new TextInputBuilder()
        .setCustomId('chain')
        .setLabel('Total Chains')
        .setPlaceholder('e.g., 5 for a 5-chain')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2);

    const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(chainInput);
    modal.addComponents(row);

    await btn.showModal(modal);

    // Wait for modal submission
    try {
        const submitted = await btn.awaitModalSubmit({
            time: 120000, // 2 minutes
            filter: i => i.customId === `modal:chain:${runId}` && i.user.id === btn.user.id
        });

        await submitted.deferUpdate();

        const chainStr = submitted.fields.getTextInputValue('chain').trim();
        const chainAmount = parseInt(chainStr);

        // Validate input
        if (isNaN(chainAmount) || chainAmount < 1 || chainAmount > 99) {
            await submitted.followUp({ 
                content: '❌ Chain amount must be a number between 1 and 99', 
                ephemeral: true 
            });
            return;
        }

        // Get member for role IDs
        if (!btn.guild) {
            await submitted.followUp({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        const guildId = btn.guildId!;

        // Update backend
        try {
            await patchJSON(`/runs/${runId}/chain-amount`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member),
                chainAmount
            }, { guildId });
        } catch (err) {
            if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
                await submitted.followUp({ content: 'Only the organizer can set chain amount.', ephemeral: true });
                return;
            }
            const msg = err instanceof Error ? err.message : 'Unknown error';
            await submitted.followUp({ content: `Error: ${msg}`, ephemeral: true });
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
            await submitted.followUp({ content: 'Run record missing channel/message id.', ephemeral: true });
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
                    
                    // Build title with chain tracking
                    const statusEmoji = run.status === 'live' ? '🟢' : '📋';
                    const statusText = run.status === 'live' ? 'LIVE' : 'Starting';
                    const chainText = run.chainAmount ? ` | Chain ${run.keyPopCount}/${run.chainAmount}` : '';
                    embed.setTitle(`${statusEmoji} ${statusText}: ${run.dungeonLabel}${chainText}`);
                    
                    await pubMsg.edit({ embeds: [embed, ...embeds.slice(1)] });
                }
            }
        }

        await submitted.followUp({ 
            content: `✅ Chain amount set to: **${chainAmount}**\n\nThe raid title will now show "Chain 0/${chainAmount}" (updates as you press Key popped)`, 
            ephemeral: true 
        });
    } catch (err) {
        // Modal timeout or other error - no need to handle, Discord shows timeout message
    }
}


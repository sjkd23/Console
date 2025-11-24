import { ButtonInteraction, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { getJSON, patchJSON, deleteJSON, BackendError } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib//permissions/permissions.js';
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
        const liveEmbed = buildLiveEmbed(embeds[0], run, btn);

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

        // Update the organizer panel to show Live buttons
        const firstEmbed = btn.message.embeds?.[0];
        const dungeonTitle = firstEmbed?.title?.replace('Organizer Panel — ', '') ?? run.dungeonLabel;

        const panelEmbed = new EmbedBuilder()
            .setTitle(`Organizer Panel — ${dungeonTitle}`)
            .setDescription('✅ **Run is LIVE!**\n\nManage the raid below.')
            .setTimestamp(new Date())
            .setColor(0x00ff00); // Green color for live

        // For Oryx 3, use "Realm Score %" instead of "Key popped"
        const actionButton = run.dungeonKey === 'ORYX_3'
            ? new ButtonBuilder()
                .setCustomId(`run:realmscore:${runId}`)
                .setLabel('Realm Score %')
                .setStyle(ButtonStyle.Success)
            : (() => {
                // Build the "Key popped" button with the appropriate emoji
                const keyPoppedButton = new ButtonBuilder()
                    .setCustomId(`run:keypop:${runId}`)
                    .setLabel('Key popped')
                    .setStyle(ButtonStyle.Success);

                // Add emoji from the dungeon's first key reaction if available
                const keyEmojiIdentifier = getDungeonKeyEmojiIdentifier(run.dungeonKey);
                if (keyEmojiIdentifier) {
                    keyPoppedButton.setEmoji(keyEmojiIdentifier);
                }

                return keyPoppedButton;
            })();

        const liveControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:end:${runId}`)
                .setLabel('End Run')
                .setStyle(ButtonStyle.Danger),
            actionButton
        );

        // For Oryx 3, don't show Chain Amount button
        const liveControls2Components = [
            new ButtonBuilder()
                .setCustomId(`run:setpartyloc:${runId}`)
                .setLabel('Set Party/Loc')
                .setStyle(ButtonStyle.Secondary)
        ];

        if (run.dungeonKey !== 'ORYX_3') {
            liveControls2Components.push(
                new ButtonBuilder()
                    .setCustomId(`run:setchain:${runId}`)
                    .setLabel('Chain Amount')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        liveControls2Components.push(
            new ButtonBuilder()
                .setCustomId(`run:cancel:${runId}`)
                .setLabel('Cancel Run')
                .setStyle(ButtonStyle.Danger)
        );

        const liveControls2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...liveControls2Components);

        await btn.editReply({ embeds: [panelEmbed], components: [liveControls, liveControls2] });
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
        const endedEmbed = buildEndedEmbed(embeds[0], run, endLabel);

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

            // Clear thread cache since run is ending
            clearLogThreadCache({
                guildId: btn.guild.id,
                organizerId: run.organizerId,
                organizerUsername: '',
                dungeonName: run.dungeonLabel,
                type: 'run',
                runId: parseInt(runId)
            });
        } catch (e) {
            console.error('Failed to log status change to raid-log:', e);
        }

        // If run ended, show key logging panel
        // Calculate total keys based on key reactions:
        // - For dungeons with multiple key types (e.g., Oryx 3): count unique users across ALL key types
        // - For regular dungeons: use key_pop_count (number of times "Key Popped" was clicked)
        // - Always log at least 1 key (the organizer's key to start the run)
        if (status === 'ended') {
            let totalKeys = Math.max(1, run.keyPopCount);
            
            // Check if this dungeon has multiple distinct key types
            const dungeonData = await import('../../../constants/dungeons/dungeon-helpers.js')
                .then(m => m.dungeonByCode[run.dungeonKey]);
            
            if (dungeonData?.keyReactions && dungeonData.keyReactions.length > 1) {
                // For dungeons with multiple key types (like Oryx 3), fetch ALL key reactions
                // and count the TOTAL number of unique key clicks across all types
                try {
                    const keyReactionData = await getJSON<{ keyUsers: Record<string, string[]> }>(
                        `/runs/${runId}/key-reaction-users`,
                        { guildId }
                    );
                    
                    // Count total unique key reactions across all key types
                    let totalKeyReactions = 0;
                    for (const userIds of Object.values(keyReactionData.keyUsers)) {
                        totalKeyReactions += userIds.length;
                    }
                    
                    // Use the total key reactions if greater than 1
                    if (totalKeyReactions > 0) {
                        totalKeys = totalKeyReactions;
                    }
                } catch (err) {
                    logger.warn('Failed to fetch key reactions for multi-key dungeon', {
                        runId,
                        dungeonKey: run.dungeonKey,
                        error: err
                    });
                    // Fall back to key_pop_count
                }
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
                run.dungeonKey,
                run.dungeonLabel,
                totalKeys
            );
            return;
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

/**
 * Build the Live phase embed with optional key window line.
 */
function buildLiveEmbed(
    original: any,
    run: {
        dungeonKey: string;
        dungeonLabel: string;
        organizerId: string;
        startedAt: string | null;
        keyWindowEndsAt: string | null;
        party: string | null;
        location: string | null;
        description: string | null;
        keyPopCount: number;
        chainAmount: number | null;
    },
    btn: ButtonInteraction
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);

    // Set title with LIVE badge and optional chain tracking (not for Oryx 3)
    let chainText = '';
    if (run.dungeonKey !== 'ORYX_3' && run.keyPopCount > 0) {
        if (run.chainAmount && run.keyPopCount <= run.chainAmount) {
            // Show Chain X/Y only if chain amount is set AND not exceeded
            chainText = ` | Chain ${run.keyPopCount}/${run.chainAmount}`;
        } else {
            // Show Chain X if no chain amount set OR if count exceeded amount
            chainText = ` | Chain ${run.keyPopCount}`;
        }
    }
    embed.setTitle(`🟢 LIVE: ${run.dungeonLabel}${chainText}`);

    // Build description with organizer and key window if active
    let desc = `Organizer: <@${run.organizerId}>`;

    // Add key window if end time is in the future
    if (run.keyWindowEndsAt) {
        const endsUnix = Math.floor(new Date(run.keyWindowEndsAt).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);

        if (endsUnix > now) {
            // Get the dungeon-specific key emoji
            const keyEmoji = getDungeonKeyEmoji(run.dungeonKey);

            desc += `\n\n${keyEmoji} **Key popped**\nParty join window closes <t:${endsUnix}:R>`;
        }
    }

    embed.setDescription(desc);

    // Keep existing fields (Raiders, Keys, etc.) but remove Party/Location and Classes
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    // Merge separate key fields into a single Keys field when going live
    const headcountKeysIdx = fields.findIndex(f => (f.name ?? '').includes('Headcount Keys'));
    const raidKeysIdx = fields.findIndex(f => (f.name ?? '').includes('Raid Keys'));
    const keysIdx = fields.findIndex(f => (f.name ?? '') === 'Keys');

    if (headcountKeysIdx >= 0 || raidKeysIdx >= 0) {
        // We have separate key fields - merge them into one "Keys" field
        const mergedKeyLines: string[] = [];

        // Add headcount keys if present
        if (headcountKeysIdx >= 0) {
            const headcountValue = fields[headcountKeysIdx].value;
            if (headcountValue && headcountValue !== 'None') {
                mergedKeyLines.push(headcountValue);
            }
        }

        // Add raid keys if present
        if (raidKeysIdx >= 0) {
            const raidValue = fields[raidKeysIdx].value;
            if (raidValue && raidValue !== 'None') {
                mergedKeyLines.push(raidValue);
            }
        }

        // Determine final value
        const finalValue = mergedKeyLines.length > 0 
            ? mergedKeyLines.join('\n') 
            : 'None';

        // Remove both separate key fields if they exist
        const indicesToRemove = [headcountKeysIdx, raidKeysIdx].filter(i => i >= 0).sort((a, b) => b - a);
        for (const idx of indicesToRemove) {
            fields.splice(idx, 1);
        }

        // Add or update the single "Keys" field
        const newKeysIdx = fields.findIndex(f => (f.name ?? '') === 'Keys');
        if (newKeysIdx >= 0) {
            fields[newKeysIdx] = { ...fields[newKeysIdx], value: finalValue };
        } else {
            // Insert Keys field after Raiders field
            const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
            const insertIdx = raidersIdx >= 0 ? raidersIdx + 1 : fields.length;
            fields.splice(insertIdx, 0, { name: 'Keys', value: finalValue, inline: false });
        }
    }

    // Remove Party field if present
    const partyIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
    if (partyIdx >= 0) {
        fields.splice(partyIdx, 1);
    }

    // Remove Location field if present
    const locIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'location');
    if (locIdx >= 0) {
        fields.splice(locIdx, 1);
    }

    // Remove Classes field if present
    const classIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (classIdx >= 0) {
        fields.splice(classIdx, 1);
    }

    // Update or add Organizer Note field
    if (run.description) {
        const noteIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'organizer note');
        if (noteIdx >= 0) {
            fields[noteIdx] = { ...fields[noteIdx], value: run.description };
        }
    }

    return embed.setFields(fields as any);
}

/**
 * Build the Ended phase embed.
 */
function buildEndedEmbed(
    original: any,
    run: {
        dungeonKey: string;
        dungeonLabel: string;
        organizerId: string;
        startedAt: string | null;
        endedAt: string | null;
        keyPopCount: number;
        chainAmount: number | null;
    },
    label: string
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);

    // Set title with appropriate icon
    const icon = label === 'Cancelled' ? '❌' : '✅';
    embed.setTitle(`${icon} ${label}: ${run.dungeonLabel}`);

    // Build description with organizer and timestamps
    let desc = `Organizer: <@${run.organizerId}>`;

    if (run.endedAt) {
        const endedUnix = Math.floor(new Date(run.endedAt).getTime() / 1000);
        desc += `\n${label} <t:${endedUnix}:R>`;
    }

    // Calculate duration if we have both timestamps
    if (run.startedAt && run.endedAt) {
        const durationMs = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
        const durationMin = Math.floor(durationMs / 60000);
        const durationSec = Math.floor((durationMs % 60000) / 1000);
        desc += `\nDuration: ${durationMin}m ${durationSec}s`;
    }

    // Add final chain count if chain tracking was enabled (not for Oryx 3)
    if (run.dungeonKey !== 'ORYX_3' && run.keyPopCount > 0) {
        if (run.chainAmount && run.keyPopCount <= run.chainAmount) {
            desc += `\n\n**Chains Completed:** ${run.keyPopCount}/${run.chainAmount}`;
        } else {
            desc += `\n\n**Chains Completed:** ${run.keyPopCount}`;
        }
    }

    embed.setDescription(desc);

    // Keep Raiders field from original
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    // Keep only Raiders and Keys fields, remove others
    const keepFields = fields.filter(f => {
        const name = (f.name ?? '').toLowerCase();
        return name === 'raiders' || name === 'keys';
    });

    return embed.setFields(keepFields as any);
}

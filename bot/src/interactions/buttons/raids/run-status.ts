import { ButtonInteraction, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getJSON, patchJSON, deleteJSON, BackendError } from '../../../lib/http.js';
import { getMemberRoleIds } from '../../../lib//permissions/permissions.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/key-emoji-helpers.js';
import { logRunStatusChange, clearLogThreadCache, updateThreadStarterWithEndTime } from '../../../lib/raid-logger.js';

export async function handleStatus(
    btn: ButtonInteraction,
    runId: string,
    status: 'live' | 'ended' | 'cancelled'
) {
    // For button interactions, use deferUpdate so we can edit the original ephemeral panel later.
    await btn.deferUpdate();

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

    // 1) Update backend status (PATCH for live/ended, DELETE for cancelled) with actorId
    //    Backend will verify that btn.user.id === run.organizer_id OR has organizer role
    try {
        if (status === 'cancelled') {
            await deleteJSON(`/runs/${runId}`, { 
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member)
            });
        } else {
            await patchJSON(`/runs/${runId}`, { 
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(member),
                status 
            });
        }
    } catch (err) {
        if (err instanceof BackendError && err.code === 'NOT_ORGANIZER') {
            await btn.editReply({ content: 'Only the organizer can perform this action.', components: [] });
            return;
        }
        // Other errors
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
            .setDescription('✅ **Run is now LIVE!**\n\nUse the controls below to manage the raid.')
            .setTimestamp(new Date())
            .setColor(0x00ff00); // Green color for live
        
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
        
        const liveControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:end:${runId}`)
                .setLabel('End Run')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`run:ping:${runId}`)
                .setLabel('Ping Raiders')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`run:note:${runId}`)
                .setLabel('Update Note')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            keyPoppedButton
        );
        
        const liveControls2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:setparty:${runId}`)
                .setLabel('Set Party')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setlocation:${runId}`)
                .setLabel('Set Location')
                .setStyle(ButtonStyle.Secondary)
        );
        
        await btn.editReply({ embeds: [panelEmbed], components: [liveControls, liveControls2] });
    } else {
        // status === 'ended' or 'cancelled'
        const endLabel = status === 'cancelled' ? 'Cancelled' : 'Ended';
        const icon = status === 'cancelled' ? '❌' : '✅';
        
        // Build ended embed
        const endedEmbed = buildEndedEmbed(embeds[0], run, endLabel);
        
        // Change PUBLIC MESSAGE content and remove buttons
        await pubMsg.edit({ content: endLabel, embeds: [endedEmbed, ...embeds.slice(1)], components: [] });

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

        // Close the organizer panel with clear message
        const closureEmbed = new EmbedBuilder()
            .setTitle(`${icon} Run ${endLabel}`)
            .setDescription(`The run has been ${endLabel.toLowerCase()}. This organizer panel is now closed.`)
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
    },
    btn: ButtonInteraction
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);
    
    // Set title with LIVE badge
    embed.setTitle(`🟢 LIVE: ${run.dungeonLabel}`);
    
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
    
    // Keep existing fields (Raiders, Classes, etc.) but update Party/Location if needed
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];
    
    // Update or add Party field
    const partyIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
    if (run.party) {
        if (partyIdx >= 0) {
            fields[partyIdx] = { ...fields[partyIdx], value: run.party };
        } else {
            // Add new Party field after Raiders
            const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
            const insertIdx = raidersIdx >= 0 ? raidersIdx + 1 : fields.length;
            fields.splice(insertIdx, 0, { name: 'Party', value: run.party, inline: true });
        }
    } else if (partyIdx >= 0) {
        // Remove Party field if empty
        fields.splice(partyIdx, 1);
    }
    
    // Update or add Location field
    const locIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'location');
    if (run.location) {
        if (locIdx >= 0) {
            fields[locIdx] = { ...fields[locIdx], value: run.location };
        } else {
            // Add new Location field after Party (if exists) or Raiders
            const partyFieldIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
            const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
            const insertIdx = partyFieldIdx >= 0 ? partyFieldIdx + 1 : (raidersIdx >= 0 ? raidersIdx + 1 : fields.length);
            fields.splice(insertIdx, 0, { name: 'Location', value: run.location, inline: true });
        }
    } else if (locIdx >= 0) {
        // Remove Location field if empty
        fields.splice(locIdx, 1);
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
        dungeonLabel: string;
        organizerId: string;
        startedAt: string | null;
        endedAt: string | null;
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
    
    embed.setDescription(desc);
    
    // Keep Raiders field from original
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];
    
    // Keep only Raiders, Classes, and Keys fields, remove others
    const keepFields = fields.filter(f => {
        const name = (f.name ?? '').toLowerCase();
        return name === 'raiders' || name === 'classes' || name === 'keys';
    });
    
    return embed.setFields(keepFields as any);
}

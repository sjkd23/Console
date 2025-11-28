/**
 * Handles join button interactions for headcount panels.
 * Tracks participants by showing/hiding their mention in the embed description.
 */

import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { setEmbedField } from '../../../lib/ui/embed-builders.js';
import { getParticipants, updateParticipantsList, getOrganizerId } from '../../../lib/state/headcount-state.js';
import { logRaidJoin } from '../../../lib/logging/raid-logger.js';
import { getActiveHeadcountPanels } from '../../../lib/state/headcount-panel-tracker.js';
import { updateHeadcountOrganizerPanel } from './headcount-organizer-panel.js';

/**
 * Handle join button click for headcount panel.
 */
export async function handleHeadcountJoin(btn: ButtonInteraction, panelTimestamp: string) {
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    const msg = btn.message;
    const embeds = msg.embeds ?? [];
    if (!embeds.length) {
        await btn.editReply('❌ Headcount panel not found.');
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const participants = getParticipants(embed, msg.id);

    // Toggle participation
    const userId = btn.user.id;
    let message: string;

    if (participants.has(userId)) {
        participants.delete(userId);
        message = '✅ **You left the headcount.**';
    } else {
        participants.add(userId);
        message = '✅ **You joined the headcount!** Click Join again to leave.';
    }

    // Update embed - this now only cleans up any legacy "Joined:" sections
    let updatedEmbed = updateParticipantsList(embed, participants);
    
    // Participant count field hidden from public panel (only shown in organizer panel)
    // const participantsFieldIdx = updatedEmbed.data.fields?.findIndex(f => 
    //     f.name === 'Participants' || f.name === 'Interested'
    // ) ?? -1;
    // 
    // if (participantsFieldIdx >= 0 && updatedEmbed.data.fields) {
    //     updatedEmbed.data.fields[participantsFieldIdx].value = String(participants.size);
    // }

    await msg.edit({ embeds: [updatedEmbed, ...embeds.slice(1)] });

    // Log to raid-log thread (extract dungeon name from title and organizer from description)
    if (btn.guild) {
        try {
            const dungeonName = embed.data.title?.replace('🎯 Headcount', '').trim() || 'Unknown';
            const organizerMatch = embed.data.description?.match(/Organizer: <@(\d+)>/);
            const organizerId = organizerMatch ? organizerMatch[1] : '';
            
            if (organizerId) {
                await logRaidJoin(
                    btn.client,
                    {
                        guildId: btn.guild.id,
                        organizerId,
                        organizerUsername: '',
                        dungeonName,
                        type: 'headcount',
                        panelTimestamp: panelTimestamp
                    },
                    btn.user.id,
                    participants.has(userId) ? 'joined' : 'left',
                    participants.size
                );
            }
        } catch (e) {
            console.error('Failed to log headcount join to raid-log:', e);
        }
    }

    // Auto-refresh all active headcount organizer panels for this message
    // This ensures the participant count updates in real-time when someone joins/leaves
    const activePanels = getActiveHeadcountPanels(msg.id);
    if (activePanels.length > 0) {
        // Extract dungeon codes from the button components
        const dungeonCodes: string[] = [];
        for (const row of msg.components) {
            if ('components' in row) {
                for (const component of row.components) {
                    if ('customId' in component && component.customId?.startsWith('headcount:key:')) {
                        const parts = component.customId.split(':');
                        const dungeonCode = parts[3];
                        if (dungeonCode && !dungeonCodes.includes(dungeonCode)) {
                            dungeonCodes.push(dungeonCode);
                        }
                    }
                }
            }
        }
        
        // Update all registered panel handles
        for (const handle of activePanels) {
            try {
                await updateHeadcountOrganizerPanel(handle, msg, embed, dungeonCodes);
            } catch (e) {
                console.error('Failed to refresh headcount organizer panel on join/leave:', e);
            }
        }
    }

    await btn.editReply(message);
}

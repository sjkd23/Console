/**
 * Handles join button interactions for headcount panels.
 * Tracks participants by showing/hiding their mention in the embed description.
 */

import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { setEmbedField } from '../../../lib/embed-builders.js';
import { getParticipants, updateParticipantsList } from '../../../lib/headcount-state.js';
import { logRaidJoin } from '../../../lib/raid-logger.js';

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
    const participants = getParticipants(embed);

    // Toggle participation
    const userId = btn.user.id;
    let message: string;

    if (participants.has(userId)) {
        participants.delete(userId);
        message = '✅ **You have left the headcount.**';
    } else {
        participants.add(userId);
        message = '✅ **You have joined the headcount!**\n\nThe organizer will use this to plan upcoming runs.';
    }

    // Update embed
    let updatedEmbed = updateParticipantsList(embed, participants);
    updatedEmbed = setEmbedField(updatedEmbed, 'Participants', String(participants.size), true);

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

    await btn.editReply(message);
}

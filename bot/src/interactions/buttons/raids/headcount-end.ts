/**
 * Handles ending a headcount panel.
 * Removes all interactive buttons and updates the embed to show it's closed.
 */

import {
    ButtonInteraction,
    EmbedBuilder,
    ChannelType
} from 'discord.js';
import { getOrganizerId } from '../../../lib/headcount-state.js';
import { clearKeyOffers } from './headcount-key.js';
import { logRunStatusChange, clearLogThreadCache, updateThreadStarterWithEndTime } from '../../../lib/raid-logger.js';

export async function handleHeadcountEnd(btn: ButtonInteraction, publicMessageId: string) {
    await btn.deferUpdate();

    // Fetch the public headcount message
    if (!btn.channel || btn.channel.type !== ChannelType.GuildText) {
        await btn.editReply({ content: 'Could not locate headcount channel.', components: [] });
        return;
    }

    const publicMsg = await btn.channel.messages.fetch(publicMessageId).catch(() => null);
    if (!publicMsg) {
        await btn.editReply({ content: 'Could not find headcount panel message.', components: [] });
        return;
    }

    const embeds = publicMsg.embeds ?? [];
    if (!embeds.length) {
        await btn.editReply({ content: 'Could not find headcount panel.', components: [] });
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const organizerId = getOrganizerId(embed);

    // Authorization check - only organizer can end
    if (!organizerId || organizerId !== btn.user.id) {
        await btn.editReply({
            content: '❌ Only the headcount organizer can end this headcount.',
            components: []
        });
        return;
    }

    // Update the embed to show it's ended
    const endedEmbed = EmbedBuilder.from(embed)
        .setTitle('❌ Headcount Ended')
        .setColor(0xff0000);

    // Keep the existing description but add an ended notice at the top
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Add ended notice after the organizer line
    const lines = description.split('\n');
    const organizerLineIdx = lines.findIndex(l => l.includes('Organizer:'));
    
    if (organizerLineIdx >= 0) {
        lines.splice(organizerLineIdx + 1, 0, '\n**Status:** This headcount has ended');
        description = lines.join('\n');
    } else {
        description = '**Status:** This headcount has ended\n\n' + description;
    }
    
    endedEmbed.setDescription(description);

    // Remove all buttons from the public message
    await publicMsg.edit({ embeds: [endedEmbed], components: [] });

    // Log headcount ending to raid-log
    if (btn.guild) {
        try {
            const dungeonName = embed.data.title?.replace('🎯 Headcount', '').trim() || 'Unknown';
            
            const context = {
                guildId: btn.guild.id,
                organizerId,
                organizerUsername: '',
                dungeonName,
                type: 'headcount' as const,
                panelTimestamp: publicMessageId
            };
            
            await logRunStatusChange(
                btn.client,
                context,
                'ended',
                btn.user.id
            );
            
            // Update the thread starter message with ended time
            await updateThreadStarterWithEndTime(btn.client, context);
            
            // Clear thread cache since headcount is ending
            clearLogThreadCache(context);
        } catch (e) {
            console.error('Failed to log headcount end to raid-log:', e);
        }
    }

    // Clear key offers from memory
    clearKeyOffers(publicMsg.id);

    // Close the organizer panel
    const closureEmbed = new EmbedBuilder()
        .setTitle('✅ Headcount Ended')
        .setDescription('The headcount has been closed and all buttons have been removed.')
        .setColor(0x00ff00)
        .setTimestamp(new Date());

    await btn.editReply({ embeds: [closureEmbed], components: [] });
}

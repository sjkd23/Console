/**
 * Handles ending a headcount panel.
 * Removes all interactive buttons and updates the embed to show it's closed.
 */

import {
    ButtonInteraction,
    EmbedBuilder,
    ChannelType
} from 'discord.js';
import { getOrganizerId } from '../../../lib/state/headcount-state.js';
import { clearKeyOffers } from './headcount-key.js';
import { logRunStatusChange, clearLogThreadCache, updateThreadStarterWithEndTime } from '../../../lib/logging/raid-logger.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { withButtonLock, getHeadcountLockKey } from '../../../lib/utilities/button-mutex.js';
import { unregisterHeadcount } from '../../../lib/state/active-headcount-tracker.js';

export async function handleHeadcountEnd(btn: ButtonInteraction, publicMessageId: string) {
    await btn.deferUpdate();

    // CRITICAL: Wrap in mutex to prevent concurrent ending
    const executed = await withButtonLock(btn, getHeadcountLockKey('end', publicMessageId), async () => {
        await handleHeadcountEndInternal(btn, publicMessageId);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

/**
 * Internal handler for headcount ending (protected by mutex).
 */
async function handleHeadcountEndInternal(btn: ButtonInteraction, publicMessageId: string) {

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

    if (!organizerId) {
        await btn.editReply({
            content: 'Could not determine the headcount organizer.',
            components: []
        });
        return;
    }

    // Authorization check using centralized helper
    const accessCheck = await checkOrganizerAccess(btn, organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply({
            content: accessCheck.errorMessage,
            components: []
        });
        return;
    }

    // Update the embed to show it's ended
    const originalTitle = embed.data.title || '';
    const isSingleDungeon = originalTitle.includes('Headcount:') || originalTitle.includes('—');
    
    const endedEmbed = EmbedBuilder.from(embed)
        .setTitle(originalTitle.replace('🎯', '❌').replace('Headcount', 'Headcount Ended'))
        .setColor(0xff0000)
        .setTimestamp(new Date());

    // Simplify the description - remove extra sections
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Extract just the organizer line and participants
    const lines = description.split('\n');
    const organizerLine = lines.find(l => l.includes('Organizer:')) || '';
    const joinedLine = lines.find(l => l.includes('**Joined:**')) || '';
    
    // For multi-dungeon, keep the dungeons list
    const dungeonsLine = lines.find(l => l.includes('**Dungeons:**')) || '';
    
    // Rebuild clean description
    let cleanDescription = organizerLine;
    
    // Add dungeons for multi-dungeon headcounts
    if (dungeonsLine) {
        cleanDescription += `\n\n${dungeonsLine}`;
    }
    
    if (joinedLine) {
        cleanDescription += `\n\n${joinedLine}`;
    }
    
    endedEmbed.setDescription(cleanDescription);
    
    // Keep interested/participant count and keys fields
    const fields = data.fields || [];
    const interestedField = fields.find(f => f.name === 'Interested' || f.name === 'Participants');
    const keysField = fields.find(f => f.name === 'Keys' || f.name === 'Total Keys');
    
    const fieldsToKeep = [];
    if (interestedField) fieldsToKeep.push(interestedField);
    if (keysField) fieldsToKeep.push(keysField);
    
    if (fieldsToKeep.length > 0) {
        endedEmbed.setFields(fieldsToKeep);
    }

    // Remove all buttons from the public message
    await publicMsg.edit({ embeds: [endedEmbed], components: [] });

    // Unregister the active headcount
    if (btn.guild) {
        unregisterHeadcount(btn.guild.id, organizerId);
    }

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

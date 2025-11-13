/**
 * Handles organizer panel interactions for headcount panels.
 * Shows organizer-only controls for managing headcounts and converting to runs.
 */

import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    ComponentType
} from 'discord.js';
import { getParticipants, getOrganizerId } from '../../../lib/headcount-state.js';
import { getKeyOffers } from './headcount-key.js';
import { dungeonByCode } from '../../../constants/dungeon-helpers.js';
import { getDungeonKeyEmoji } from '../../../lib/key-emoji-helpers.js';

export async function handleHeadcountOrganizerPanel(btn: ButtonInteraction, panelTimestamp: string) {
    // btn.message is the PUBLIC headcount panel message
    const publicMsg = btn.message;
    const embeds = publicMsg.embeds ?? [];
    
    if (!embeds.length) {
        await btn.reply({
            content: 'Could not fetch headcount panel details.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const organizerId = getOrganizerId(embed);

    // Authorization check - only organizer can access
    if (!organizerId || organizerId !== btn.user.id) {
        await btn.reply({
            content: '❌ Only the headcount organizer can access this panel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Extract dungeon codes from the button components
    const dungeonCodes: string[] = [];
    for (const row of publicMsg.components) {
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

    // Get headcount state
    const participants = getParticipants(embed);
    const keyOffers = getKeyOffers(publicMsg.id);

    // Build organizer panel embed
    const panelEmbed = new EmbedBuilder()
        .setTitle('🎯 Headcount Organizer Panel')
        .setColor(0x5865F2)
        .setTimestamp(new Date());

    // Build description with participants and key offers
    let description = `**Participants:** ${participants.size}\n`;
    
    if (participants.size > 0) {
        const mentions = Array.from(participants).map(id => `<@${id}>`).join(', ');
        description += `\n${mentions}\n`;
    }

    description += '\n**Key Offers by Dungeon:**\n';

    if (dungeonCodes.length === 0) {
        description += '_No dungeons found_';
    } else {
        let hasKeys = false;
        for (const dungeonCode of dungeonCodes) {
            const dungeon = dungeonByCode[dungeonCode];
            const dungeonName = dungeon?.dungeonName || dungeonCode;
            const userIds = keyOffers.get(dungeonCode);
            const count = userIds?.size || 0;

            // Get the dungeon-specific key emoji
            const keyEmoji = getDungeonKeyEmoji(dungeonCode);

            if (count > 0) {
                hasKeys = true;
                const mentions = Array.from(userIds!).map(id => `<@${id}>`).join(', ');
                description += `\n${keyEmoji} **${dungeonName}** (${count}): ${mentions}`;
            } else {
                description += `\n${keyEmoji} **${dungeonName}**: _No keys_`;
            }
        }
    }

    description += '\n\n**Actions:**\n• Click **End** to close this headcount\n• Click **Convert to Run** to turn a dungeon into a run panel';

    panelEmbed.setDescription(description);

    // Build control buttons - pass the public message ID so handlers can find it
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`headcount:end:${publicMsg.id}`)
            .setLabel('End Headcount')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`headcount:convert:${publicMsg.id}`)
            .setLabel('Convert to Run')
            .setStyle(ButtonStyle.Success)
            .setDisabled(dungeonCodes.length === 0)
    );

    await btn.reply({
        embeds: [panelEmbed],
        components: [row1],
        flags: MessageFlags.Ephemeral
    });
}

/**
 * Handles key offer button interactions for headcount panels.
 * Tracks per-dungeon key offers in memory.
 */

import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { setEmbedField } from '../../../lib/embed-builders.js';
import { dungeonByCode } from '../../../constants/dungeon-helpers.js';
import { getDungeonKeyEmoji } from '../../../lib/key-emoji-helpers.js';
import { logKeyReaction } from '../../../lib/raid-logger.js';

/**
 * In-memory storage for key offers per headcount panel.
 * Map structure: messageId -> dungeonCode -> Set<userId>
 */
const keyOffersStore = new Map<string, Map<string, Set<string>>>();

/**
 * Get key offers for a specific headcount panel.
 * EXPORTED for use by headcount organizer panel.
 */
export function getKeyOffers(messageId: string): Map<string, Set<string>> {
    let keyMap = keyOffersStore.get(messageId);
    if (!keyMap) {
        keyMap = new Map<string, Set<string>>();
        keyOffersStore.set(messageId, keyMap);
    }
    return keyMap;
}

/**
 * Clear key offers for a specific headcount panel.
 * Used when converting to a run or ending the headcount.
 */
export function clearKeyOffers(messageId: string): void {
    keyOffersStore.delete(messageId);
}

/**
 * Update the "Total Keys" field to show total count across all dungeons.
 */
function updateTotalKeys(embed: EmbedBuilder, keyOffers: Map<string, Set<string>>): EmbedBuilder {
    let totalKeys = 0;
    for (const userIds of keyOffers.values()) {
        totalKeys += userIds.size;
    }
    return setEmbedField(embed, 'Total Keys', String(totalKeys), true);
}

/**
 * Update the embed description to show per-dungeon key counts.
 */
function updateKeyCountsInDescription(embed: EmbedBuilder, keyOffers: Map<string, Set<string>>): EmbedBuilder {
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Remove existing "Key Counts:" section
    description = description.replace(/\n\n\*\*Key Counts:\*\*\n[\s\S]*?(?=\n\n|$)/, '');
    
    // Build key counts section with emojis only
    const keyCountLines: string[] = [];
    for (const [dungeonCode, userIds] of keyOffers.entries()) {
        if (userIds.size > 0) {
            const dungeon = dungeonByCode[dungeonCode];
            const dungeonName = dungeon?.dungeonName || dungeonCode;
            
            // Get the dungeon-specific key emoji
            const keyEmoji = getDungeonKeyEmoji(dungeonCode);
            
            keyCountLines.push(`${keyEmoji} ${dungeonName}: **${userIds.size}**`);
        }
    }
    
    if (keyCountLines.length > 0) {
        description += '\n\n**Key Counts:**\n' + keyCountLines.join('\n');
    }
    
    return new EmbedBuilder(data).setDescription(description);
}

/**
 * Handle key button click for headcount panel.
 */
export async function handleHeadcountKey(
    btn: ButtonInteraction,
    panelTimestamp: string,
    dungeonCode: string
) {
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    const msg = btn.message;
    const embeds = msg.embeds ?? [];
    if (!embeds.length) {
        await btn.editReply('❌ Headcount panel not found.');
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const keyOffers = getKeyOffers(msg.id);

    // Get or create the set for this dungeon
    let dungeonKeys = keyOffers.get(dungeonCode);
    if (!dungeonKeys) {
        dungeonKeys = new Set<string>();
        keyOffers.set(dungeonCode, dungeonKeys);
    }

    // Toggle key offer for this user & dungeon
    const userId = btn.user.id;
    let message: string;

    const dungeon = dungeonByCode[dungeonCode];
    const dungeonName = dungeon?.dungeonName || dungeonCode;

    if (dungeonKeys.has(userId)) {
        dungeonKeys.delete(userId);
        message = `✅ **Key offer removed for ${dungeonName}**`;
    } else {
        dungeonKeys.add(userId);
        message = `✅ **You have offered a key for ${dungeonName}!**\n\nThe organizer can see your key offer.`;
    }

    // Update embed description with new state
    let updatedEmbed = updateKeyCountsInDescription(embed, keyOffers);
    updatedEmbed = updateTotalKeys(updatedEmbed, keyOffers);

    await msg.edit({ embeds: [updatedEmbed, ...embeds.slice(1)] });

    // Log to raid-log thread
    if (btn.guild) {
        try {
            const organizerMatch = embed.data.description?.match(/Organizer: <@(\d+)>/);
            const organizerId = organizerMatch ? organizerMatch[1] : '';
            
            if (organizerId) {
                await logKeyReaction(
                    btn.client,
                    {
                        guildId: btn.guild.id,
                        organizerId,
                        organizerUsername: '',
                        dungeonName: dungeonName,
                        type: 'headcount',
                        panelTimestamp: panelTimestamp
                    },
                    btn.user.id,
                    dungeonName,
                    dungeonKeys.has(userId) ? 'added' : 'removed',
                    dungeonKeys.size
                );
            }
        } catch (e) {
            console.error('Failed to log headcount key to raid-log:', e);
        }
    }

    await btn.editReply(message);
}

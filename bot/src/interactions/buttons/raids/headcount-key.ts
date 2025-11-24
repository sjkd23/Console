/**
 * Handles key offer button interactions for headcount panels.
 * Tracks per-dungeon key offers in memory.
 */

import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { setEmbedField } from '../../../lib/ui/embed-builders.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { getDungeonKeyEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyReaction } from '../../../lib/logging/raid-logger.js';
import { getReactionInfo } from '../../../constants/emojis/MappedAfkCheckReactions.js';
import { getActiveHeadcountPanels } from '../../../lib/state/headcount-panel-tracker.js';
import { showHeadcountPanel } from './headcount-organizer-panel.js';
import { getOrganizerId, getParticipants } from '../../../lib/state/headcount-state.js';

/**
 * In-memory storage for key offers per headcount panel.
 * Map structure: messageId -> dungeonCode -> mapKey -> Set<userId>
 * This supports multiple key types per dungeon (e.g., Oryx 3 with 4 different keys)
 */
const keyOffersStore = new Map<string, Map<string, Map<string, Set<string>>>>();

/**
 * Get key offers for a specific headcount panel.
 * EXPORTED for use by headcount organizer panel.
 */
export function getKeyOffers(messageId: string): Map<string, Map<string, Set<string>>> {
    let keyMap = keyOffersStore.get(messageId);
    if (!keyMap) {
        keyMap = new Map<string, Map<string, Set<string>>>();
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
 * Update the "Total Keys" or "Keys" field to show total count.
 * Handles both multi-dungeon ("Total Keys") and single-dungeon ("Keys") formats.
 */
function updateTotalKeys(embed: EmbedBuilder, keyOffers: Map<string, Map<string, Set<string>>>): EmbedBuilder {
    let totalKeys = 0;
    for (const mapKeyMap of keyOffers.values()) {
        for (const userIds of mapKeyMap.values()) {
            totalKeys += userIds.size;
        }
    }
    
    // Try to update "Total Keys" first (multi-dungeon), then "Keys" (single-dungeon)
    const data = embed.toJSON();
    const fields = data.fields || [];
    
    const totalKeysIdx = fields.findIndex(f => f.name === 'Total Keys');
    const keysIdx = fields.findIndex(f => f.name === 'Keys');
    
    if (totalKeysIdx >= 0) {
        fields[totalKeysIdx].value = String(totalKeys);
    } else if (keysIdx >= 0) {
        fields[keysIdx].value = String(totalKeys);
    }
    
    return new EmbedBuilder(data);
}

/**
 * Update the embed description to show per-dungeon key counts.
 * For dungeons with multiple key types (like Oryx 3), shows each key type separately.
 */
function updateKeyCountsInDescription(embed: EmbedBuilder, keyOffers: Map<string, Map<string, Set<string>>>): EmbedBuilder {
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Remove existing "Key Counts:" section
    description = description.replace(/\n\n\*\*Key Counts:\*\*\n[\s\S]*?(?=\n\n|$)/, '');
    
    // Build key counts section with individual key types
    const keyCountLines: string[] = [];
    
    for (const [dungeonCode, mapKeyMap] of keyOffers.entries()) {
        const dungeon = dungeonByCode[dungeonCode];
        const dungeonName = dungeon?.dungeonName || dungeonCode;
        
        // Check if this dungeon has multiple key types defined (not just how many have reactions)
        const dungeonHasMultipleKeyTypes = dungeon?.keyReactions && dungeon.keyReactions.length > 1;
        
        for (const [mapKey, userIds] of mapKeyMap.entries()) {
            if (userIds.size > 0) {
                // Get emoji for this specific key type
                const keyEmoji = getEmojiDisplayForKeyType(mapKey);
                
                // Format the key type name
                const keyTypeName = formatKeyTypeForDisplay(mapKey);
                
                // For dungeons with multiple key types (like Oryx 3), show just "Key Type: count"
                // For single-key dungeons, show "Dungeon: count"
                let displayText: string;
                if (dungeonHasMultipleKeyTypes) {
                    displayText = `${keyEmoji} ${keyTypeName}: **${userIds.size}**`;
                } else {
                    displayText = `${keyEmoji} ${dungeonName}: **${userIds.size}**`;
                }
                
                keyCountLines.push(displayText);
            }
        }
    }
    
    if (keyCountLines.length > 0) {
        description += '\n\n**Key Counts:**\n' + keyCountLines.join('\n');
    }
    
    return new EmbedBuilder(data).setDescription(description);
}

/**
 * Get emoji display string for a key type.
 */
function getEmojiDisplayForKeyType(keyType: string): string {
    const reactionInfo = getReactionInfo(keyType);
    if (!reactionInfo?.emojiInfo?.identifier) return '🗝️';

    const idOrChar = reactionInfo.emojiInfo.identifier;

    if (reactionInfo.emojiInfo.isCustom) {
        return `<:key:${idOrChar}>`;
    }

    return idOrChar;
}

/**
 * Format key type for user-friendly display
 */
function formatKeyTypeForDisplay(mapKey: string): string {
    const specialCases: Record<string, string> = {
        'WC_INC': 'Wine Cellar Incantation',
        'SHIELD_RUNE': 'Shield Rune',
        'SWORD_RUNE': 'Sword Rune',
        'HELM_RUNE': 'Helm Rune',
    };
    
    return specialCases[mapKey] || mapKey.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Handle key button click for headcount panel.
 * @param btn The button interaction
 * @param panelTimestamp The timestamp from the button custom ID
 * @param dungeonCode The dungeon code (e.g., "ORYX_3")
 * @param mapKey Optional specific key type (e.g., "WC_INC", "SHIELD_RUNE"). If not provided, uses first key reaction.
 */
export async function handleHeadcountKey(
    btn: ButtonInteraction,
    panelTimestamp: string,
    dungeonCode: string,
    mapKey?: string
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

    // Get dungeon info
    const dungeon = dungeonByCode[dungeonCode];
    const dungeonName = dungeon?.dungeonName || dungeonCode;

    // Determine which key type to use
    let actualMapKey = mapKey;
    if (!actualMapKey && dungeon?.keyReactions && dungeon.keyReactions.length > 0) {
        // If no mapKey provided, use the first key reaction (backward compatibility)
        actualMapKey = dungeon.keyReactions[0].mapKey;
    }
    
    if (!actualMapKey) {
        await btn.editReply('❌ Invalid key type.');
        return;
    }

    // Get or create the nested map for this dungeon
    let dungeonKeyMap = keyOffers.get(dungeonCode);
    if (!dungeonKeyMap) {
        dungeonKeyMap = new Map<string, Set<string>>();
        keyOffers.set(dungeonCode, dungeonKeyMap);
    }

    // Get or create the set for this specific key type
    let keyTypeSet = dungeonKeyMap.get(actualMapKey);
    if (!keyTypeSet) {
        keyTypeSet = new Set<string>();
        dungeonKeyMap.set(actualMapKey, keyTypeSet);
    }

    // Toggle key offer for this user
    const userId = btn.user.id;
    let message: string;

    // Format key type for display
    const keyTypeDisplay = formatKeyTypeForDisplay(actualMapKey);

    if (keyTypeSet.has(userId)) {
        keyTypeSet.delete(userId);
        message = `✅ **${keyTypeDisplay} removed for ${dungeonName}.**`;
    } else {
        keyTypeSet.add(userId);
        message = `✅ **${keyTypeDisplay} added for ${dungeonName}!** Click again to remove.\n\n⚠️ **Important:** Please make sure to re-react with your key/rune when the raid starts to receive the party and location information.`;
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
                // Count total keys for this dungeon
                let totalDungeonKeys = 0;
                if (dungeonKeyMap) {
                    for (const userIds of dungeonKeyMap.values()) {
                        totalDungeonKeys += userIds.size;
                    }
                }
                
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
                    keyTypeDisplay,
                    keyTypeSet.has(userId) ? 'added' : 'removed',
                    totalDungeonKeys
                );
            }
        } catch (e) {
            console.error('Failed to log headcount key to raid-log:', e);
        }
    }

    await btn.editReply(message);
    
    // Auto-refresh all active headcount organizer panels for this message
    const activePanels = getActiveHeadcountPanels(msg.id);
    if (activePanels.length > 0) {
        // Extract dungeon codes from the button components (same way as handleHeadcountOrganizerPanel)
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
        
        const organizerId = getOrganizerId(embed);
        if (organizerId) {
            for (const panelInteraction of activePanels) {
                try {
                    await showHeadcountPanel(panelInteraction, msg, embed, organizerId, dungeonCodes);
                } catch (e) {
                    console.error('Failed to refresh headcount organizer panel:', e);
                }
            }
        }
    }
}

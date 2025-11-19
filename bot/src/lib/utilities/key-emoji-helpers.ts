import { ButtonInteraction } from 'discord.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';

/**
 * Format key labels for display (convert snake_case to Title Case)
 */
export function formatKeyLabel(keyType: string): string {
    // Special cases for common abbreviations
    const specialCases: Record<string, string> = {
        'WC_INC': 'Inc',
        'SHIELD_RUNE': 'Shield Rune',
        'SWORD_RUNE': 'Sword Rune',
        'HELM_RUNE': 'Helm Rune',
        'MSEAL': 'MSeal',
        'VIAL_OF_PURE_DARKNESS': 'Vial',
    };

    if (specialCases[keyType]) {
        return specialCases[keyType];
    }

    // Convert SNAKE_CASE to Title Case
    return keyType
        .split('_')
        .map(word => word.charAt(0) + word.slice(1).toLowerCase())
        .join(' ')
        .replace(' Key', ''); // Remove "Key" suffix if present
}

/**
 * Get the proper key type suffix (Key, Rune, or Incantation)
 */
export function getKeyTypeSuffix(keyType: string): string {
    if (keyType === 'WC_INC') {
        return 'Wine Cellar Incantation';
    } else if (keyType.includes('RUNE')) {
        return 'Rune';
    } else {
        return 'Key';
    }
}

/**
 * Get emoji display string for a key type.
 * For custom emojis, uses the format <:name:id> where the name doesn't matter (ID is what counts).
 * For unicode emojis, returns the character directly.
 * 
 * @param keyType The key type identifier (e.g., "NEST_KEY")
 * @returns The emoji string ready for display in embeds/messages, or empty string if not found
 */
export function getEmojiDisplayForKeyType(keyType: string): string {
    const reactionInfo = getReactionInfo(keyType);
    if (!reactionInfo?.emojiInfo?.identifier) return '';

    const idOrChar = reactionInfo.emojiInfo.identifier;

    if (reactionInfo.emojiInfo.isCustom) {
        // Custom emoji: build <:name:id> markup.
        // The *name* part doesn't actually need to match Discord's emoji name; ID is what matters.
        return `<:key:${idOrChar}>`;
    }

    // Unicode emoji: just return the character
    return idOrChar;
}

/**
 * Get emoji display string for a key type, using cache for better reliability.
 * This is more reliable than getEmojiDisplayForKeyType as it uses the actual emoji object.
 * 
 * @param keyType The key type identifier (e.g., "NEST_KEY")
 * @param btn The button interaction to access emoji cache
 * @returns The emoji string ready for display, or empty string if not found
 */
export function getEmojiDisplayFromCache(keyType: string, btn: ButtonInteraction): string {
    const reactionInfo = getReactionInfo(keyType);
    if (!reactionInfo?.emojiInfo?.identifier) return '';

    if (reactionInfo.emojiInfo.isCustom) {
        // Try to get emoji from cache first (has correct name)
        const cachedEmoji = btn.guild?.emojis.cache.get(reactionInfo.emojiInfo.identifier)
                         || btn.client.emojis.cache.get(reactionInfo.emojiInfo.identifier);
        if (cachedEmoji) {
            return cachedEmoji.toString();
        }
        // If not in cache, fallback to manual format
        return getEmojiDisplayForKeyType(keyType);
    }

    // Use unicode emoji directly
    return reactionInfo.emojiInfo.identifier;
}

/**
 * Get the dungeon-specific key emoji for a given dungeon.
 * This is the SINGLE SOURCE OF TRUTH for which key emoji to display.
 * Uses the same logic as the working key buttons.
 * 
 * @param dungeonKey The dungeon code name (e.g., "FUNGAL_CAVERN", "NEST")
 * @returns The emoji string ready for display, or '🗝️' fallback if not found
 */
export function getDungeonKeyEmoji(dungeonKey: string): string {
    const dungeonData = dungeonByCode[dungeonKey];
    
    // Get the first key reaction emoji if available
    if (dungeonData?.keyReactions && dungeonData.keyReactions.length > 0) {
        const firstKeyReaction = dungeonData.keyReactions[0];
        const emoji = getEmojiDisplayForKeyType(firstKeyReaction.mapKey);
        if (emoji) {
            return emoji;
        }
    }
    
    // Fallback to generic key emoji
    return '🗝️';
}

/**
 * Get the dungeon-specific key emoji identifier for a given dungeon.
 * Returns the raw emoji identifier (emoji ID for custom emojis, unicode for standard emojis).
 * Used for setting button emojis.
 * 
 * @param dungeonKey The dungeon code name (e.g., "FUNGAL_CAVERN", "NEST")
 * @returns The emoji identifier string, or undefined if not found
 */
export function getDungeonKeyEmojiIdentifier(dungeonKey: string): string | undefined {
    const dungeonData = dungeonByCode[dungeonKey];
    
    // Get the first key reaction emoji if available
    if (dungeonData?.keyReactions && dungeonData.keyReactions.length > 0) {
        const firstKeyReaction = dungeonData.keyReactions[0];
        const reactionInfo = getReactionInfo(firstKeyReaction.mapKey);
        return reactionInfo?.emojiInfo?.identifier;
    }
    
    return undefined;
}

import { Message } from 'discord.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('RunReactions');

/**
 * Add reactions (otherReactions only) to a run message
 * based on the dungeon's configuration.
 * 
 * Key reactions are excluded - users should use the key buttons instead.
 * 
 * Handles errors gracefully - missing emojis or permission issues won't crash,
 * they'll just be logged and skipped.
 * 
 * @param message - The Discord message to add reactions to
 * @param dungeonKey - The dungeon code name (e.g., "FUNGAL_CAVERN")
 * 
 * NOTE: Currently disabled - reactions are not added to run messages.
 */
export async function addRunReactions(message: Message, dungeonKey: string): Promise<void> {
    // Reactions disabled - return early without adding any reactions
    logger.debug('Reactions disabled for run message', {
        dungeonKey,
        messageId: message.id
    });
}

/**
 * Remove all reactions from a run message.
 * This is called when a run ends or is cancelled.
 * 
 * @param message - The Discord message to clear reactions from
 */
export async function clearRunReactions(message: Message): Promise<void> {
    try {
        logger.info('Clearing reactions from run message', {
            messageId: message.id,
            channelId: message.channelId
        });

        // Check if message is already fetched and has reactions
        if (!message.reactions.cache.size) {
            logger.debug('No reactions to clear', { messageId: message.id });
            return;
        }

        // Remove all reactions at once
        await message.reactions.removeAll();
        
        logger.info('Successfully cleared reactions', {
            messageId: message.id
        });
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        // Log but don't throw - reactions are non-critical
        if (errorMessage.includes('Missing Permissions')) {
            logger.warn('Bot lacks permission to clear reactions', {
                messageId: message.id,
                error: errorMessage
            });
        } else {
            logger.error('Failed to clear reactions', {
                messageId: message.id,
                error: errorMessage
            });
        }
    }
}

import { Message } from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { getReactionEmoji } from '../../constants/emojis/MappedAfkCheckReactions.js';
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
 */
export async function addRunReactions(message: Message, dungeonKey: string): Promise<void> {
    const dungeon = dungeonByCode[dungeonKey];
    if (!dungeon) {
        logger.warn('Cannot add reactions - unknown dungeon', { dungeonKey });
        return;
    }

    // Only use otherReactions - keyReactions are handled via buttons
    const allReactions = [
        ...(dungeon.otherReactions || [])
    ];

    if (allReactions.length === 0) {
        logger.debug('No reactions to add for dungeon', { dungeonKey });
        return;
    }

    logger.info('Adding reactions to run message', {
        dungeonKey,
        messageId: message.id,
        reactionCount: allReactions.length
    });

    // Add each reaction in sequence
    for (const reaction of allReactions) {
        try {
            const emojiIdentifier = getReactionEmoji(reaction.mapKey);
            
            if (!emojiIdentifier) {
                logger.warn('No emoji found for reaction', {
                    dungeonKey,
                    mapKey: reaction.mapKey,
                    messageId: message.id
                });
                continue;
            }

            // Try to add the reaction
            await message.react(emojiIdentifier);
            
            logger.debug('Added reaction', {
                dungeonKey,
                mapKey: reaction.mapKey,
                emojiIdentifier,
                messageId: message.id
            });
        } catch (err) {
            // Log and continue - don't let one failed reaction break the rest
            const errorMessage = err instanceof Error ? err.message : String(err);
            
            // Check if it's a known Discord API error
            if (errorMessage.includes('Unknown Emoji')) {
                logger.warn('Emoji not available to bot', {
                    dungeonKey,
                    mapKey: reaction.mapKey,
                    messageId: message.id,
                    error: 'Unknown Emoji'
                });
            } else if (errorMessage.includes('Missing Permissions')) {
                logger.error('Bot lacks permission to add reactions', {
                    dungeonKey,
                    messageId: message.id,
                    error: errorMessage
                });
                // If we lack permissions, no point trying more reactions
                break;
            } else {
                logger.error('Failed to add reaction', {
                    dungeonKey,
                    mapKey: reaction.mapKey,
                    messageId: message.id,
                    error: errorMessage
                });
            }
        }
    }

    logger.info('Finished adding reactions', {
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

import { createLogger } from '../logging/logger.js';

const logger = createLogger('ActiveHeadcountTracker');

/**
 * In-memory tracking of active headcounts
 * Key: `${guildId}:${organizerId}`
 * Value: { messageId, channelId, createdAt, dungeons }
 */
const activeHeadcounts = new Map<string, {
    messageId: string;
    channelId: string;
    createdAt: Date;
    dungeons: string[];
}>();

/**
 * Register a new active headcount
 */
export function registerHeadcount(
    guildId: string,
    organizerId: string,
    messageId: string,
    channelId: string,
    dungeons: string[]
): void {
    const key = `${guildId}:${organizerId}`;
    activeHeadcounts.set(key, {
        messageId,
        channelId,
        createdAt: new Date(),
        dungeons
    });
    
    logger.info('Registered active headcount', {
        guildId,
        organizerId,
        messageId,
        dungeonCount: dungeons.length
    });
}

/**
 * Remove a headcount from active tracking
 */
export function unregisterHeadcount(
    guildId: string,
    organizerId: string
): void {
    const key = `${guildId}:${organizerId}`;
    const removed = activeHeadcounts.delete(key);
    
    if (removed) {
        logger.info('Unregistered headcount', {
            guildId,
            organizerId
        });
    }
}

/**
 * Get active headcount for an organizer
 */
export function getActiveHeadcount(
    guildId: string,
    organizerId: string
): {
    messageId: string;
    channelId: string;
    createdAt: Date;
    dungeons: string[];
} | null {
    const key = `${guildId}:${organizerId}`;
    return activeHeadcounts.get(key) || null;
}

/**
 * Check if organizer has an active headcount
 */
export function hasActiveHeadcount(
    guildId: string,
    organizerId: string
): boolean {
    const key = `${guildId}:${organizerId}`;
    return activeHeadcounts.has(key);
}

/**
 * Clean up stale headcounts (older than 24 hours)
 * This prevents memory leaks if headcounts aren't properly cleaned up
 */
export function cleanupStaleHeadcounts(): void {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    for (const [key, headcount] of activeHeadcounts.entries()) {
        if (headcount.createdAt < twentyFourHoursAgo) {
            activeHeadcounts.delete(key);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        logger.info('Cleaned up stale headcounts', { count: cleanedCount });
    }
}

// Run cleanup every hour
setInterval(cleanupStaleHeadcounts, 60 * 60 * 1000);

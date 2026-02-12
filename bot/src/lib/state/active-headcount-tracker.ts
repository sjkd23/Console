import { createLogger } from '../logging/logger.js';
import { getDefaultAutoEndMinutes } from '../../config/raid-config.js';

const logger = createLogger('ActiveHeadcountTracker');
const HEADCOUNT_AUTO_END_MINUTES = getDefaultAutoEndMinutes();

/**
 * In-memory tracking of active headcounts
 * Key: `${guildId}:${organizerId}`
 * Value: { messageId, channelId, createdAt, dungeons }
 */
const activeHeadcounts = new Map<string, {
    messageId: string;
    channelId: string;
    createdAt: Date;
    autoEndAt: Date;
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
    const createdAt = new Date();
    const autoEndAt = new Date(createdAt.getTime() + HEADCOUNT_AUTO_END_MINUTES * 60 * 1000);

    activeHeadcounts.set(key, {
        messageId,
        channelId,
        createdAt,
        autoEndAt,
        dungeons
    });
    
    logger.info('Registered active headcount', {
        guildId,
        organizerId,
        messageId,
        dungeonCount: dungeons.length,
        autoEndMinutes: HEADCOUNT_AUTO_END_MINUTES,
        autoEndAt: autoEndAt.toISOString()
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
    autoEndAt: Date;
    dungeons: string[];
} | null {
    const key = `${guildId}:${organizerId}`;
    return activeHeadcounts.get(key) || null;
}

/**
 * Get all active headcounts with guild/organizer metadata.
 * Used by scheduled tasks for automatic expiration.
 */
export function getAllActiveHeadcounts(): Array<{
    guildId: string;
    organizerId: string;
    messageId: string;
    channelId: string;
    createdAt: Date;
    autoEndAt: Date;
    dungeons: string[];
}> {
    const entries: Array<{
        guildId: string;
        organizerId: string;
        messageId: string;
        channelId: string;
        createdAt: Date;
        autoEndAt: Date;
        dungeons: string[];
    }> = [];

    for (const [key, value] of activeHeadcounts.entries()) {
        const separatorIndex = key.indexOf(':');
        if (separatorIndex === -1) {
            continue;
        }

        const guildId = key.substring(0, separatorIndex);
        const organizerId = key.substring(separatorIndex + 1);

        entries.push({
            guildId,
            organizerId,
            messageId: value.messageId,
            channelId: value.channelId,
            createdAt: value.createdAt,
            autoEndAt: value.autoEndAt,
            dungeons: value.dungeons,
        });
    }

    return entries;
}

/**
 * Check if a tracked headcount is expired based on its configured auto-end time.
 */
export function isHeadcountExpired(headcount: { autoEndAt: Date }, now: Date = new Date()): boolean {
    return headcount.autoEndAt.getTime() <= now.getTime();
}

/**
 * Get default auto-end duration for headcounts (in minutes).
 */
export function getHeadcountAutoEndMinutes(): number {
    return HEADCOUNT_AUTO_END_MINUTES;
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

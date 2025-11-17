/**
 * Central raid configuration for the bot.
 *
 * This module defines raid behavior constants (timeouts, limits, etc.)
 * so raid/run logic doesn't rely on scattered magic numbers.
 *
 * NOTE: These values should align with backend/src/config/raid-config.ts
 * to ensure consistent behavior across both services.
 *
 * Dungeon metadata is kept in bot/src/constants/dungeons/* as it requires
 * Discord-specific data (emojis, colors, images, etc.).
 */

// ============================================================================
// Raid Behavior Configuration
// ============================================================================

/**
 * Raid behavior constants that control timeouts, limits, and other
 * "magic numbers" used throughout the bot for run/raid management.
 */
export interface RaidBehaviorConfig {
    /** Default auto-end duration for runs (in minutes). Must match backend. */
    defaultAutoEndMinutes: number;

    /** Maximum auto-end duration allowed for runs (in minutes). Must match backend. */
    maxAutoEndMinutes: number;

    /** Default key window duration (in seconds). Time window for raiders to join after key pop. */
    defaultKeyWindowSeconds: number;

    /** Maximum key window duration allowed (in seconds). Must match backend. */
    maxKeyWindowSeconds: number;
}

/**
 * Central raid behavior configuration for the bot.
 *
 * These values control run/raid behavior and should match the backend config
 * to ensure consistent behavior across services.
 *
 * Current defaults:
 * - Auto-end: 120 minutes (2 hours) by default, max 1440 (24 hours)
 * - Key window: 25 seconds by default, max 300 (5 minutes)
 */
export const RAID_BEHAVIOR: Readonly<RaidBehaviorConfig> = {
    defaultAutoEndMinutes: 120,   // 2 hours - matches backend
    maxAutoEndMinutes: 1440,      // 24 hours - matches backend
    defaultKeyWindowSeconds: 25,  // 25 seconds - matches backend
    maxKeyWindowSeconds: 300,     // 5 minutes - matches backend
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the default auto-end minutes for new runs.
 */
export function getDefaultAutoEndMinutes(): number {
    return RAID_BEHAVIOR.defaultAutoEndMinutes;
}

/**
 * Get the default key window duration in seconds.
 */
export function getDefaultKeyWindowSeconds(): number {
    return RAID_BEHAVIOR.defaultKeyWindowSeconds;
}

/**
 * Validate an auto-end duration is within allowed bounds.
 * Returns the validated value, or the default if out of range.
 */
export function validateAutoEndMinutes(minutes: number): number {
    if (minutes < 1 || minutes > RAID_BEHAVIOR.maxAutoEndMinutes) {
        return RAID_BEHAVIOR.defaultAutoEndMinutes;
    }
    return minutes;
}

/**
 * Validate a key window duration is within allowed bounds.
 * Returns the validated value, or the default if out of range.
 */
export function validateKeyWindowSeconds(seconds: number): number {
    if (seconds < 1 || seconds > RAID_BEHAVIOR.maxKeyWindowSeconds) {
        return RAID_BEHAVIOR.defaultKeyWindowSeconds;
    }
    return seconds;
}

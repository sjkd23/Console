/**
 * Party State Manager
 * 
 * Manages active party tracking and enforces rate limits for party creation.
 * 
 * Features:
 * - Tracks one active party per user (prevents duplicates)
 * - Rate limiting: 3 parties per 30-minute window
 * - Automatic cleanup of expired rate limit records
 * - In-memory storage (resets on bot restart)
 * 
 * Rate Limit Behavior:
 * - Users can create 3 parties within any 30-minute window
 * - After 30 minutes, the oldest creation expires and a new slot becomes available
 * - Rate limit tracking persists even after party is closed
 * 
 * Bot Restart Behavior:
 * - Active party tracking is lost (user can create new party)
 * - Rate limit history is lost (rate limits reset)
 * - Existing party messages remain visible but buttons still work
 * - This is acceptable as parties are typically short-lived
 */

interface PartyCreationRecord {
    timestamp: number;
}

// Map: userId -> messageId of active party
const activeParties = new Map<string, string>();

// Map: userId -> array of party creation timestamps
const partyCreationHistory = new Map<string, PartyCreationRecord[]>();

// Rate limit configuration
const MAX_PARTIES_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes in milliseconds (not a full hour)

/**
 * Check if user has an active party
 */
export function hasActiveParty(userId: string): boolean {
    return activeParties.has(userId);
}

/**
 * Get user's active party message ID
 */
export function getActivePartyMessageId(userId: string): string | undefined {
    return activeParties.get(userId);
}

/**
 * Check if user has exceeded rate limit
 * 
 * @param userId - Discord user ID to check
 * @returns Object containing:
 *   - allowed: Whether user can create a new party
 *   - remainingSlots: Number of parties user can still create in current window
 *   - nextAvailableTime: Unix timestamp (ms) when next slot becomes available (only if at limit)
 * 
 * @example
 * const check = checkRateLimit('123456789');
 * if (!check.allowed) {
 *   console.log(`Try again at ${new Date(check.nextAvailableTime!)}`);
 * }
 */
export function checkRateLimit(userId: string): { 
    allowed: boolean; 
    remainingSlots: number; 
    nextAvailableTime?: number;
} {
    const now = Date.now();
    const history = partyCreationHistory.get(userId) || [];
    
    // Filter out records older than the rate limit window (30 minutes)
    const recentCreations = history.filter(
        record => now - record.timestamp < RATE_LIMIT_WINDOW_MS
    );
    
    // Update the history with only recent creations
    if (recentCreations.length > 0) {
        partyCreationHistory.set(userId, recentCreations);
    } else {
        partyCreationHistory.delete(userId);
    }
    
    const remainingSlots = MAX_PARTIES_PER_HOUR - recentCreations.length;
    
    if (recentCreations.length >= MAX_PARTIES_PER_HOUR) {
        // Find the oldest creation and calculate when it expires
        const oldestCreation = recentCreations[0];
        const nextAvailableTime = oldestCreation.timestamp + RATE_LIMIT_WINDOW_MS;
        
        return {
            allowed: false,
            remainingSlots: 0,
            nextAvailableTime
        };
    }
    
    return {
        allowed: true,
        remainingSlots
    };
}

/**
 * Record a new party creation
 * 
 * Adds the party to active tracking and records the creation timestamp
 * for rate limit enforcement.
 * 
 * @param userId - Discord user ID who created the party
 * @param messageId - Discord message ID of the party post
 */
export function recordPartyCreation(userId: string, messageId: string): void {
    const now = Date.now();
    
    // Add to active parties
    activeParties.set(userId, messageId);
    
    // Add to creation history
    const history = partyCreationHistory.get(userId) || [];
    history.push({ timestamp: now });
    partyCreationHistory.set(userId, history);
}

/**
 * Remove a party from active tracking when it's closed
 * 
 * Note: This does NOT remove the creation from rate limit history.
 * The creation timestamp remains for rate limit enforcement.
 * 
 * @param userId - Discord user ID whose party is being removed
 */
export function removeActiveParty(userId: string): void {
    activeParties.delete(userId);
}

/**
 * Clean up expired rate limit records
 * 
 * Removes creation timestamps older than the rate limit window to prevent
 * memory leaks. Called automatically every 10 minutes.
 * 
 * This is a maintenance function and doesn't affect active party tracking.
 */
export function cleanupExpiredRecords(): void {
    const now = Date.now();
    
    for (const [userId, history] of partyCreationHistory.entries()) {
        const recentCreations = history.filter(
            record => now - record.timestamp < RATE_LIMIT_WINDOW_MS
        );
        
        if (recentCreations.length > 0) {
            partyCreationHistory.set(userId, recentCreations);
        } else {
            partyCreationHistory.delete(userId);
        }
    }
}

// Run cleanup every 10 minutes to prevent memory leaks
// This is safe to run frequently as it only processes in-memory data
setInterval(cleanupExpiredRecords, 10 * 60 * 1000);

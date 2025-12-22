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

interface ActivePartyInfo {
    messageId: string;
    channelId: string;
    createdAt: number;
    guildId: string;
}

// Map: userId -> active party info
const activeParties = new Map<string, ActivePartyInfo>();

// Map: userId -> array of party creation timestamps
const partyCreationHistory = new Map<string, PartyCreationRecord[]>();

// Rate limit configuration
const MAX_PARTIES_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes in milliseconds (not a full hour)
const PARTY_AUTO_CLOSE_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

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
    return activeParties.get(userId)?.messageId;
}

/**
 * Get user's active party info
 */
export function getActivePartyInfo(userId: string): ActivePartyInfo | undefined {
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
 * for rate limit enforcement. Schedules auto-close after 2 hours.
 * 
 * @param userId - Discord user ID who created the party
 * @param messageId - Discord message ID of the party post
 * @param channelId - Discord channel ID where party was posted
 * @param guildId - Discord guild ID
 */
export function recordPartyCreation(userId: string, messageId: string, channelId: string, guildId: string): void {
    const now = Date.now();
    
    // Add to active parties
    activeParties.set(userId, {
        messageId,
        channelId,
        createdAt: now,
        guildId
    });
    
    // Add to creation history
    const history = partyCreationHistory.get(userId) || [];
    history.push({ timestamp: now });
    partyCreationHistory.set(userId, history);
    
    // Schedule auto-close after 2 hours
    setTimeout(() => {
        autoCloseParty(userId).catch(err => {
            console.error(`[Party] Failed to auto-close party for user ${userId}:`, err);
        });
    }, PARTY_AUTO_CLOSE_MS);
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

/**
 * Auto-close a party after 2 hours
 * Called by setTimeout when party expires
 */
async function autoCloseParty(userId: string): Promise<void> {
    const partyInfo = activeParties.get(userId);
    if (!partyInfo) return; // Party already closed manually
    
    try {
        // Import Discord client from index
        const { client } = await import('../../index.js');
        if (!client) return;
        
        const channel = await client.channels.fetch(partyInfo.channelId);
        if (!channel || !channel.isTextBased()) return;
        
        const message = await channel.messages.fetch(partyInfo.messageId);
        if (!message) return;
        
        const embed = message.embeds[0];
        if (!embed) return;
        
        // Import EmbedBuilder
        const { EmbedBuilder } = await import('discord.js');
        
        // Update embed to show party as closed (auto)
        const newEmbed = new EmbedBuilder(embed.toJSON());
        newEmbed.setColor(0xED4245); // Red for Closed
        newEmbed.setTitle('⏰ Party Auto-Closed');
        newEmbed.setFooter({ text: 'Party automatically closed after 2 hours' });
        
        // Remove all action buttons/components when closed
        await message.edit({ embeds: [newEmbed], components: [] });
        
        // Remove from active parties tracking
        removeActiveParty(userId);
        
        // Archive thread if exists
        if (message.thread) {
            try {
                await message.thread.setLocked(true);
                await message.thread.setArchived(true);
            } catch (err) {
                console.error('[Party] Failed to archive thread during auto-close:', err);
            }
        }
        
        // Log auto-closure
        const { logPartyClosure, clearPartyLogThreadCache } = await import('../../logging/party-logger.js');
        const messageContent = message.content || '';
        const partyNameMatch = messageContent.match(/\*\*Party:\*\*\s*([^\|]+)/);
        const partyName = partyNameMatch ? partyNameMatch[1].trim() : 'Unknown Party';
        
        try {
            await logPartyClosure(
                client,
                {
                    guildId: partyInfo.guildId,
                    ownerId: userId,
                    ownerUsername: 'System',
                    partyName: partyName,
                    messageId: message.id
                },
                'auto-close'
            );
            
            clearPartyLogThreadCache({
                guildId: partyInfo.guildId,
                ownerId: userId,
                ownerUsername: 'System',
                partyName: partyName,
                messageId: message.id
            });
        } catch (err) {
            console.error('[Party] Failed to log auto-closure:', err);
        }
    } catch (err) {
        console.error('[Party] Error during auto-close:', err);
    }
}

// Run cleanup every 10 minutes to prevent memory leaks
// This is safe to run frequently as it only processes in-memory data
setInterval(cleanupExpiredRecords, 10 * 60 * 1000);

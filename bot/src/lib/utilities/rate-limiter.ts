// bot/src/lib/utilities/rate-limiter.ts
import type { Interaction } from 'discord.js';

/**
 * Rate limit configuration for different interaction types
 */
export interface RateLimitConfig {
    /** Maximum number of requests allowed in the time window */
    maxRequests: number;
    /** Time window in milliseconds */
    windowMs: number;
    /** Optional custom error message */
    errorMessage?: string;
}

/**
 * Rate limit entry tracking requests
 */
interface RateLimitEntry {
    /** Timestamps of requests in the current window */
    requests: number[];
    /** When this entry was last accessed (for cleanup) */
    lastAccess: number;
}

/**
 * Rate limit violation response
 */
export interface RateLimitResult {
    /** Whether the request is allowed */
    allowed: boolean;
    /** Remaining requests in current window */
    remaining: number;
    /** Time until window resets (ms) */
    resetIn?: number;
    /** Error message if blocked */
    message?: string;
}

/**
 * Predefined rate limit configurations for common scenarios
 */
export const RateLimitPresets = {
    /** General commands - prevent spam but allow normal usage (5 per 10s) */
    COMMAND_DEFAULT: {
        maxRequests: 5,
        windowMs: 10_000,
        errorMessage: '⏱️ **Slow down!** You\'re using commands too quickly. Please wait a moment and try again.'
    } as RateLimitConfig,

    /** Heavy/expensive commands like stats, leaderboard (3 per 15s) */
    COMMAND_HEAVY: {
        maxRequests: 3,
        windowMs: 15_000,
        errorMessage: '⏱️ **Rate limited.** This command is resource-intensive. Please wait before using it again.'
    } as RateLimitConfig,

    /** Config commands - more restrictive (2 per 20s) */
    COMMAND_CONFIG: {
        maxRequests: 2,
        windowMs: 20_000,
        errorMessage: '⏱️ **Slow down!** Configuration commands are rate limited. Please wait before making more changes.'
    } as RateLimitConfig,

    /** Quick info commands (help, ping) - more lenient (10 per 15s) */
    COMMAND_INFO: {
        maxRequests: 10,
        windowMs: 15_000,
        errorMessage: '⏱️ **Too many requests.** Please wait a moment before trying again.'
    } as RateLimitConfig,

    /** Button interactions - general (5 per 8s) */
    BUTTON_DEFAULT: {
        maxRequests: 5,
        windowMs: 8_000,
        errorMessage: '⏱️ **Slow down!** You\'re clicking buttons too quickly. Please wait a moment.'
    } as RateLimitConfig,

    /** Run join/leave buttons - prevent rapid toggling (3 per 10s) */
    BUTTON_RUN_PARTICIPATION: {
        maxRequests: 3,
        windowMs: 10_000,
        errorMessage: '⏱️ **Slow down!** You can\'t join/leave runs that quickly. Please wait a moment.'
    } as RateLimitConfig,

    /** Key reactions - prevent spam (4 per 12s) */
    BUTTON_KEY_REACTION: {
        maxRequests: 4,
        windowMs: 12_000,
        errorMessage: '⏱️ **Too many key reactions.** Please wait before reacting again.'
    } as RateLimitConfig,

    /** Verification flow - strict to prevent abuse (2 per 30s) */
    BUTTON_VERIFICATION: {
        maxRequests: 2,
        windowMs: 30_000,
        errorMessage: '⏱️ **Verification rate limit.** Please wait before continuing the verification process.'
    } as RateLimitConfig,

    /** Organizer panel actions - prevent accidental spam (6 per 10s) */
    BUTTON_ORGANIZER_PANEL: {
        maxRequests: 6,
        windowMs: 10_000,
        errorMessage: '⏱️ **Too many panel actions.** Please wait before performing more organizer actions.'
    } as RateLimitConfig,

    /** Config panel interactions - restrictive (2 per 15s) */
    BUTTON_CONFIG_PANEL: {
        maxRequests: 2,
        windowMs: 15_000,
        errorMessage: '⏱️ **Config panel rate limit.** Please wait before making more configuration changes.'
    } as RateLimitConfig,

    /** Modmail actions - moderate restriction (3 per 15s) */
    BUTTON_MODMAIL: {
        maxRequests: 3,
        windowMs: 15_000,
        errorMessage: '⏱️ **Modmail rate limit.** Please wait before performing more modmail actions.'
    } as RateLimitConfig,

    /** Key popped button - very strict to prevent accidental multiple pops (1 per 20s) */
    BUTTON_KEY_POPPED: {
        maxRequests: 1,
        windowMs: 20_000,
        errorMessage: '⏱️ **Key pop cooldown active.** You can only pop a key once every 20 seconds to prevent accidents.'
    } as RateLimitConfig,
} as const;

/**
 * In-memory rate limiter using sliding window algorithm.
 * Thread-safe and automatically cleans up old entries.
 */
class RateLimiter {
    private limits: Map<string, RateLimitEntry> = new Map();
    private cleanupInterval: NodeJS.Timeout;
    private readonly CLEANUP_INTERVAL_MS = 60_000; // Clean up every minute
    private readonly MAX_ENTRY_AGE_MS = 300_000; // Remove entries older than 5 minutes

    constructor() {
        // Periodically clean up stale entries to prevent memory leaks
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.CLEANUP_INTERVAL_MS);

        // Don't prevent Node from exiting
        this.cleanupInterval.unref();
    }

    /**
     * Check if a request is allowed and record it if so.
     * Uses sliding window algorithm for accurate rate limiting.
     * 
     * @param key - Unique identifier for the rate limit bucket (e.g., "user:123:command:ping")
     * @param config - Rate limit configuration
     * @returns Rate limit result with allow/deny and remaining quota
     */
    checkLimit(key: string, config: RateLimitConfig): RateLimitResult {
        const now = Date.now();
        const windowStart = now - config.windowMs;

        // Get or create entry
        let entry = this.limits.get(key);
        if (!entry) {
            entry = { requests: [], lastAccess: now };
            this.limits.set(key, entry);
        }

        // Update last access
        entry.lastAccess = now;

        // Remove requests outside the current window (sliding window)
        entry.requests = entry.requests.filter(timestamp => timestamp > windowStart);

        // Check if limit exceeded
        if (entry.requests.length >= config.maxRequests) {
            const oldestRequest = entry.requests[0];
            const resetIn = oldestRequest + config.windowMs - now;

            return {
                allowed: false,
                remaining: 0,
                resetIn,
                message: config.errorMessage || 'Rate limit exceeded. Please try again later.'
            };
        }

        // Allow request and record timestamp
        entry.requests.push(now);
        const remaining = config.maxRequests - entry.requests.length;

        return {
            allowed: true,
            remaining
        };
    }

    /**
     * Clean up stale entries to prevent memory leaks
     */
    private cleanup(): void {
        const now = Date.now();
        const cutoff = now - this.MAX_ENTRY_AGE_MS;

        for (const [key, entry] of this.limits.entries()) {
            if (entry.lastAccess < cutoff) {
                this.limits.delete(key);
            }
        }
    }

    /**
     * Clear a specific rate limit entry (useful for testing or manual overrides)
     */
    clear(key: string): void {
        this.limits.delete(key);
    }

    /**
     * Clear all rate limit entries
     */
    clearAll(): void {
        this.limits.clear();
    }

    /**
     * Get current stats (for monitoring/debugging)
     */
    getStats(): { totalEntries: number; oldestEntry: number | null } {
        const entries = Array.from(this.limits.values());
        return {
            totalEntries: this.limits.size,
            oldestEntry: entries.length > 0 
                ? Math.min(...entries.map(e => e.lastAccess))
                : null
        };
    }

    /**
     * Cleanup on shutdown
     */
    destroy(): void {
        clearInterval(this.cleanupInterval);
        this.limits.clear();
    }
}

// Singleton instance
const rateLimiter = new RateLimiter();

/**
 * Generate a rate limit key for an interaction.
 * Format: "userId:scope:identifier"
 * 
 * @param interaction - Discord interaction
 * @param scope - Scope of the rate limit (e.g., "command", "button", "verification")
 * @param identifier - Additional identifier (e.g., command name, button action)
 * @returns Rate limit key
 */
export function generateRateLimitKey(
    interaction: Interaction,
    scope: string,
    identifier: string
): string {
    return `${interaction.user.id}:${scope}:${identifier}`;
}

/**
 * Check rate limit for an interaction with automatic key generation.
 * 
 * @param interaction - Discord interaction
 * @param scope - Scope of the rate limit
 * @param identifier - Additional identifier
 * @param config - Rate limit configuration
 * @returns Rate limit result
 */
export function checkRateLimit(
    interaction: Interaction,
    scope: string,
    identifier: string,
    config: RateLimitConfig
): RateLimitResult {
    const key = generateRateLimitKey(interaction, scope, identifier);
    return rateLimiter.checkLimit(key, config);
}

/**
 * Check rate limit for a command interaction.
 * Uses command name as identifier.
 * 
 * @param interaction - Chat input command interaction
 * @param config - Optional custom rate limit config (defaults to COMMAND_DEFAULT)
 * @returns Rate limit result
 */
export function checkCommandRateLimit(
    interaction: Interaction,
    commandName: string,
    config: RateLimitConfig = RateLimitPresets.COMMAND_DEFAULT
): RateLimitResult {
    return checkRateLimit(interaction, 'command', commandName, config);
}

/**
 * Check rate limit for a button interaction.
 * Can use shared identifiers for grouped buttons (e.g., "run:participation" for join/leave).
 * 
 * @param interaction - Button interaction
 * @param identifier - Button identifier (can be shared for related buttons)
 * @param config - Optional custom rate limit config (defaults to BUTTON_DEFAULT)
 * @returns Rate limit result
 */
export function checkButtonRateLimit(
    interaction: Interaction,
    identifier: string,
    config: RateLimitConfig = RateLimitPresets.BUTTON_DEFAULT
): RateLimitResult {
    return checkRateLimit(interaction, 'button', identifier, config);
}

/**
 * Format a rate limit error message with time remaining.
 * 
 * @param result - Rate limit result
 * @returns Formatted error message
 */
export function formatRateLimitError(result: RateLimitResult): string {
    if (result.allowed) return '';
    
    const baseMessage = result.message || 'Rate limit exceeded.';
    
    if (result.resetIn) {
        const seconds = Math.ceil(result.resetIn / 1000);
        return `${baseMessage}\n\n*Please wait ${seconds} second${seconds !== 1 ? 's' : ''} before trying again.*`;
    }
    
    return baseMessage;
}

// Export singleton for advanced usage
export { rateLimiter };

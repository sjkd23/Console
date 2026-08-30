// bot/src/lib/utilities/button-mutex.ts
import type { ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';

/**
 * Lock entry for a button action
 */
interface LockEntry {
    /** When the lock was acquired */
    acquiredAt: number;
    /** User ID who acquired the lock */
    userId: string;
    /** Username for logging */
    username: string;
    /** Interactive flows release in finally rather than expiring while awaiting input. */
    holdUntilSettled: boolean;
}

/**
 * Result of attempting to acquire a lock
 */
export interface LockResult {
    /** Whether the lock was successfully acquired */
    acquired: boolean;
    /** Error message if lock was not acquired */
    message?: string;
    /** User who currently holds the lock (if any) */
    lockedBy?: string;
}

/**
 * Mutex system for preventing concurrent execution of critical button actions.
 * 
 * This prevents race conditions when multiple users click the same critical button
 * simultaneously (e.g., two organizers clicking "End Run" at the same time).
 * 
 * Features:
 * - Per-action locking (e.g., "run:end:123" is separate from "run:end:456")
 * - Automatic lock expiration (prevents deadlocks from crashes)
 * - Clear user feedback when action is in progress
 * - Automatic cleanup of stale locks
 */
class ButtonMutex {
    private locks: Map<string, LockEntry> = new Map();
    private readonly DEFAULT_LOCK_TIMEOUT_MS = 30_000; // 30 seconds
    private readonly CLEANUP_INTERVAL_MS = 60_000; // Clean up every minute
    private cleanupInterval: NodeJS.Timeout;

    constructor() {
        // Periodically clean up expired locks
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.CLEANUP_INTERVAL_MS);

        // Don't prevent Node from exiting
        this.cleanupInterval.unref();
    }

    /**
     * Attempt to acquire a lock for an action.
     * 
     * @param key - Unique identifier for the action (e.g., "run:end:123")
     * @param userId - User attempting to acquire the lock
     * @param username - Username for logging
     * @param timeoutMs - Optional custom timeout (default: 30 seconds)
     * @returns Lock result indicating success/failure
     */
    async acquire(
        key: string,
        userId: string,
        username: string,
        timeoutMs: number = this.DEFAULT_LOCK_TIMEOUT_MS,
        holdUntilSettled: boolean = false
    ): Promise<LockResult> {
        const now = Date.now();
        const existingLock = this.locks.get(key);

        // Check if there's an existing lock
        if (existingLock) {
            const lockAge = now - existingLock.acquiredAt;

            // If lock has expired, remove it and allow acquisition
            if (!existingLock.holdUntilSettled && lockAge > timeoutMs) {
                console.log(`[ButtonMutex] Lock expired for ${key}, removing stale lock`);
                this.locks.delete(key);
            } else {
                // Lock is still valid, deny acquisition
                return {
                    acquired: false,
                    message: `⏳ **Action In Progress**\n\nAnother user is currently processing this action. Please wait a moment and try again.`,
                    lockedBy: existingLock.username
                };
            }
        }

        // Acquire the lock
        this.locks.set(key, {
            acquiredAt: now,
            userId,
            username,
            holdUntilSettled,
        });

        console.log(`[ButtonMutex] Lock acquired: ${key} by ${username} (${userId})`);

        return {
            acquired: true
        };
    }

    /**
     * Release a lock for an action.
     * 
     * @param key - Unique identifier for the action
     * @param userId - User releasing the lock (must match acquirer)
     */
    release(key: string, userId: string): void {
        const lock = this.locks.get(key);

        if (!lock) {
            // Lock doesn't exist, nothing to release
            return;
        }

        if (lock.userId !== userId) {
            console.warn(
                `[ButtonMutex] Lock release mismatch: ${key} held by ${lock.userId} but ${userId} tried to release`
            );
            return;
        }

        this.locks.delete(key);
        console.log(`[ButtonMutex] Lock released: ${key}`);
    }

    /**
     * Force release a lock (use with caution).
     * 
     * @param key - Unique identifier for the action
     */
    forceRelease(key: string): void {
        this.locks.delete(key);
        console.log(`[ButtonMutex] Lock force released: ${key}`);
    }

    /**
     * Check if a lock is currently held.
     * 
     * @param key - Unique identifier for the action
     * @returns True if lock is held and not expired
     */
    isLocked(key: string): boolean {
        const lock = this.locks.get(key);
        if (!lock) return false;

        const lockAge = Date.now() - lock.acquiredAt;
        if (!lock.holdUntilSettled && lockAge > this.DEFAULT_LOCK_TIMEOUT_MS) {
            // Lock expired
            this.locks.delete(key);
            return false;
        }

        return true;
    }

    /**
     * Clean up expired locks to prevent memory leaks.
     */
    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, lock] of this.locks.entries()) {
            const lockAge = now - lock.acquiredAt;
            if (!lock.holdUntilSettled && lockAge > this.DEFAULT_LOCK_TIMEOUT_MS) {
                this.locks.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[ButtonMutex] Cleaned up ${cleaned} expired lock(s)`);
        }
    }

    /**
     * Get current stats (for monitoring/debugging).
     */
    getStats(): { totalLocks: number; oldestLock: number | null } {
        const locks = Array.from(this.locks.values());
        return {
            totalLocks: this.locks.size,
            oldestLock: locks.length > 0 
                ? Math.min(...locks.map(l => l.acquiredAt))
                : null
        };
    }

    /**
     * Clear all locks (for testing).
     */
    clearAll(): void {
        this.locks.clear();
    }

    /**
     * Cleanup on shutdown.
     */
    destroy(): void {
        clearInterval(this.cleanupInterval);
        this.locks.clear();
    }
}

// Singleton instance
const buttonMutex = new ButtonMutex();

/**
 * Execute a critical button action with mutex protection.
 * Automatically acquires lock before execution and releases after (even on error).
 * 
 * @param interaction - Button interaction
 * @param lockKey - Unique identifier for this action (e.g., "run:end:123")
 * @param action - Async function to execute while holding the lock
 * @returns True if action was executed, false if lock was not acquired
 * 
 * @example
 * ```typescript
 * const executed = await withButtonLock(
 *     interaction,
 *     `run:end:${runId}`,
 *     async () => {
 *         // Critical code that should only run once
 *         await endRun(runId);
 *     }
 * );
 * 
 * if (!executed) {
 *     // Lock was not acquired, user was notified
 *     return;
 * }
 * ```
 */
export async function withButtonLock(
    interaction: ButtonInteraction,
    lockKey: string,
    action: () => Promise<void>,
    options: { holdUntilSettled?: boolean } = {}
): Promise<boolean> {
    // Attempt to acquire lock
    const lockResult = await buttonMutex.acquire(
        lockKey,
        interaction.user.id,
        interaction.user.username,
        undefined,
        options.holdUntilSettled,
    );

    if (!lockResult.acquired) {
        // Lock not acquired, notify user
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: lockResult.message! });
            } else if (!interaction.replied) {
                await interaction.reply({ 
                    content: lockResult.message!, 
                    flags: MessageFlags.Ephemeral 
                });
            }
        } catch (err) {
            console.error('[ButtonMutex] Failed to send lock denial message:', err);
        }

        return false;
    }

    // Lock acquired, execute action
    try {
        await action();
        return true;
    } catch (err) {
        // Re-throw error but ensure lock is released
        throw err;
    } finally {
        // Always release lock, even on error
        buttonMutex.release(lockKey, interaction.user.id);
    }
}

/**
 * Generate a standard lock key for run actions.
 * 
 * @param action - Action type (e.g., "start", "end", "cancel")
 * @param runId - Run ID
 * @returns Lock key
 */
export function getRunLockKey(action: string, runId: string): string {
    return `run:${action}:${runId}`;
}

/**
 * Generate a standard lock key for headcount actions.
 * 
 * @param action - Action type (e.g., "end", "convert")
 * @param identifier - Headcount identifier (message ID or timestamp)
 * @returns Lock key
 */
export function getHeadcountLockKey(action: string, identifier: string): string {
    return `headcount:${action}:${identifier}`;
}

/**
 * Generate a standard lock key for verification actions.
 * 
 * @param action - Action type (e.g., "approve", "deny")
 * @param sessionId - Verification session ID
 * @returns Lock key
 */
export function getVerificationLockKey(action: string, sessionId: string): string {
    return `verification:${action}:${sessionId}`;
}

/**
 * Generate a standard lock key for modmail actions.
 * 
 * @param action - Action type (e.g., "close")
 * @param threadId - Thread ID
 * @returns Lock key
 */
export function getModmailLockKey(action: string, threadId: string): string {
    return `modmail:${action}:${threadId}`;
}

// Export singleton for advanced usage
export { buttonMutex };

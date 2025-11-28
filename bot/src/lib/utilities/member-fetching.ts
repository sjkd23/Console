/**
 * Member Fetching Utilities
 * 
 * Provides smart member fetching strategies to avoid timeouts and reduce load.
 * Key improvements:
 * - Configurable timeouts
 * - Cache-aware fetching (only fetch if cache is stale)
 * - Graceful fallback to cached members
 * - Structured logging
 */

import { Guild, Role } from 'discord.js';
import { botConfig } from '../../config.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('MemberFetching');

/**
 * Track last timeout timestamp per guild for backoff mechanism
 * Key: guildId, Value: timestamp of last timeout
 */
const lastTimeoutByGuild = new Map<string, number>();

export interface MemberFetchOptions {
    /**
     * Timeout in milliseconds (defaults to config value or 10000ms)
     */
    timeoutMs?: number;
    
    /**
     * Cache freshness threshold (0-1). If cache has more than this % of members, skip fetch.
     * Defaults to config value or 0.95 (95%)
     */
    cacheThreshold?: number;
    
    /**
     * Backoff period in milliseconds after a timeout before retrying fetch.
     * Defaults to config value or 300000ms (5 minutes)
     */
    backoffMs?: number;
    
    /**
     * Force fetch even if cache is fresh or backoff is active
     */
    forceFetch?: boolean;
}

export interface MemberFetchResult {
    /**
     * Whether the fetch completed successfully
     */
    success: boolean;
    
    /**
     * Source of the member data
     */
    source: 'cache' | 'fetch' | 'timeout-fallback' | 'backoff-skip';
    
    /**
     * Number of members available
     */
    memberCount: number;
    
    /**
     * Error message if fetch failed
     */
    error?: string;
}

/**
 * Intelligently fetch guild members with timeout, cache awareness, and backoff
 * 
 * Strategy:
 * 1. Check if we're in backoff period from a recent timeout - if so, skip fetch
 * 2. Check if cache is fresh enough (>= threshold) - if so, skip fetch
 * 3. If cache is stale, attempt fetch with timeout
 * 4. If fetch times out, record timeout and fall back to cached members
 * 5. Log structured data for monitoring
 * 
 * @param guild The guild to fetch members for
 * @param options Fetch options (timeout, cache threshold, backoff, etc.)
 * @returns Result indicating success, source, and member count
 */
export async function fetchGuildMembersWithTimeout(
    guild: Guild,
    options: MemberFetchOptions = {}
): Promise<MemberFetchResult> {
    const timeoutMs = options.timeoutMs ?? botConfig.MEMBER_FETCH_TIMEOUT_MS;
    const cacheThreshold = options.cacheThreshold ?? botConfig.MEMBER_CACHE_THRESHOLD;
    const backoffMs = options.backoffMs ?? botConfig.MEMBER_FETCH_BACKOFF_MS;
    const forceFetch = options.forceFetch ?? false;
    
    const cachedCount = guild.members.cache.size;
    const totalCount = guild.memberCount;
    // Handle edge case where memberCount might be 0 or unavailable
    const cacheCompleteness = totalCount > 0 ? cachedCount / totalCount : 1.0;
    
    // Check if we're in backoff period from a recent timeout
    if (!forceFetch) {
        const lastTimeout = lastTimeoutByGuild.get(guild.id);
        if (lastTimeout) {
            const timeSinceTimeout = Date.now() - lastTimeout;
            if (timeSinceTimeout < backoffMs) {
                const backoffRemaining = Math.ceil((backoffMs - timeSinceTimeout) / 1000);
                logger.debug('Skipping fetch due to recent timeout (backoff active)', {
                    guildId: guild.id,
                    guildName: guild.name,
                    cachedCount,
                    backoffRemainingSeconds: backoffRemaining,
                    lastTimeoutAgo: Math.floor(timeSinceTimeout / 1000) + 's'
                });
                
                return {
                    success: true,
                    source: 'backoff-skip',
                    memberCount: cachedCount
                };
            } else {
                // Backoff period expired, clear the timeout record
                lastTimeoutByGuild.delete(guild.id);
                logger.debug('Backoff period expired, will attempt fetch', {
                    guildId: guild.id,
                    guildName: guild.name,
                    backoffExpiredSeconds: Math.floor(timeSinceTimeout / 1000)
                });
            }
        }
    }
    
    logger.debug('Checking member cache freshness', {
        guildId: guild.id,
        guildName: guild.name,
        cachedCount,
        totalCount,
        cacheCompleteness: (cacheCompleteness * 100).toFixed(1) + '%',
        threshold: (cacheThreshold * 100).toFixed(1) + '%',
        forceFetch
    });
    
    // If cache is fresh enough and we're not forcing, skip fetch
    if (!forceFetch && cacheCompleteness >= cacheThreshold) {
        logger.debug('Using cached members (cache is fresh)', {
            guildId: guild.id,
            guildName: guild.name,
            cachedCount,
            cacheCompleteness: (cacheCompleteness * 100).toFixed(1) + '%'
        });
        
        return {
            success: true,
            source: 'cache',
            memberCount: cachedCount
        };
    }
    
    // Cache is stale or force fetch is requested - attempt fetch with timeout
    logger.debug('Fetching guild members', {
        guildId: guild.id,
        guildName: guild.name,
        timeoutMs,
        reason: forceFetch ? 'forced' : 'cache-stale'
    });
    
    try {
        await Promise.race([
            guild.members.fetch({ time: timeoutMs }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs)
            )
        ]);
        
        const fetchedCount = guild.members.cache.size;
        
        // Clear any existing timeout record on successful fetch
        if (lastTimeoutByGuild.has(guild.id)) {
            lastTimeoutByGuild.delete(guild.id);
        }
        
        logger.info('Successfully fetched guild members', {
            guildId: guild.id,
            guildName: guild.name,
            memberCount: fetchedCount,
            previousCached: cachedCount
        });
        
        return {
            success: true,
            source: 'fetch',
            memberCount: fetchedCount
        };
        
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        // Record timeout for backoff mechanism
        lastTimeoutByGuild.set(guild.id, Date.now());
        
        logger.warn('Failed to fetch members within timeout, using cached members (backoff activated)', {
            guildId: guild.id,
            guildName: guild.name,
            cachedCount,
            timeoutMs,
            backoffMs,
            error: errorMessage
        });
        
        return {
            success: false,
            source: 'timeout-fallback',
            memberCount: cachedCount,
            error: errorMessage
        };
    }
}

/**
 * Get members for a specific role with smart caching
 * 
 * This first ensures the guild member cache is reasonably fresh,
 * then returns the members with that role.
 * 
 * @param role The role to get members for
 * @param options Fetch options
 * @returns Array of member IDs and fetch result metadata
 */
export async function getRoleMembersWithCache(
    role: Role,
    options: MemberFetchOptions = {}
): Promise<{ memberIds: string[]; fetchResult: MemberFetchResult }> {
    const guild = role.guild;
    
    // Ensure member cache is reasonably fresh
    const fetchResult = await fetchGuildMembersWithTimeout(guild, options);
    
    // Get member IDs from role
    const memberIds = role.members.map(m => m.id);
    
    logger.debug('Collected role members', {
        guildId: guild.id,
        roleId: role.id,
        roleName: role.name,
        memberCount: memberIds.length,
        fetchSource: fetchResult.source
    });
    
    return { memberIds, fetchResult };
}

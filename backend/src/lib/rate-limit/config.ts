/**
 * Rate limit configuration for different endpoint categories.
 * 
 * These limits are designed to catch obviously abusive traffic (leaked API keys,
 * buggy scripts, infinite loops) without interfering with normal bot usage.
 * 
 * KEYING STRATEGY:
 * We use the x-api-key header as the rate limit key. Since this is a bot->backend
 * architecture, all traffic comes from the bot using the same API key. This means:
 * - All requests from the bot share the same rate limit counter
 * - Per-guild rate limiting is NOT implemented yet (but could be added via x-guild-id header)
 * - Normal raid activity (even busy ones) should stay well under these limits
 * 
 * To switch to per-guild limiting later:
 * Change keyGenerator to extract guild ID from headers or request body instead of api key.
 */

import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import { backendConfig } from '../../config.js';

/**
 * Default rate limit options used globally unless overridden per-route.
 * Uses env vars with safe fallback defaults.
 */
export const defaultRateLimitOptions: RateLimitPluginOptions = {
    global: true,
    max: backendConfig.RATE_LIMIT_MAX, // default: 120 req/min
    timeWindow: backendConfig.RATE_LIMIT_TIME_WINDOW_MS, // default: 60000ms (1 min)
    
    // Key by API key (all bot traffic shares same counter)
    // This protects against leaked keys or bot bugs, not per-guild abuse
    keyGenerator: (req: FastifyRequest) => {
        return req.headers['x-api-key'] as string || 'anonymous';
    },
};

/**
 * Route-specific rate limit configurations.
 * These can be applied via route config or onRequest hooks.
 * 
 * DESIGN PHILOSOPHY:
 * - Limits are set to NEVER throttle legitimate raid activity
 * - Focus is on catching obviously abusive behavior (scripts, leaked keys, infinite loops)
 * - Normal bot usage should never come close to these limits
 * 
 * REALISTIC SCENARIO (3 concurrent busy raids):
 * - 3 raids × 80 users each = 240 total participants
 * - Reaction surge when panel posted: ~240 requests over 30-60 seconds = 4 req/sec
 * - Class selections trickling in: another 100-200 requests over 2-3 minutes
 * - Key reactions: 20-40 requests sporadically
 * - Total peak traffic: ~400-500 requests in first minute, then tapering off
 * 
 * ABUSIVE SCENARIO:
 * - Leaked key used by script: thousands of requests per minute
 * - Buggy bot code stuck in retry loop: hundreds per second
 * - These patterns should be blocked while normal usage passes through easily
 */

/**
 * For high-traffic endpoints like reactions, class selection, key reactions.
 * 
 * MATH:
 * - 3 concurrent raids × 80 users = 240 users
 * - Assume 2x safety margin for bursts = 480 requests
 * - Add another 50% headroom = 720 requests/min
 * 
 * Limit: 800/min allows ~13 req/sec sustained
 * - Normal peak (4 req/sec): ✅ 30% of limit
 * - Busy peak (8 req/sec): ✅ 60% of limit  
 * - Abusive script (100+ req/sec): ❌ blocked in seconds
 */
export const HIGH_TRAFFIC_LIMIT = {
    max: 800,
    timeWindow: 60000, // 1 minute
};

/**
 * For moderate-traffic endpoints like run creation, run updates, party/location changes.
 * 
 * MATH:
 * - 3 concurrent raids starting within same minute = 3 run creations
 * - Each raid might have 5-10 updates (party, location, status changes) = ~30 updates/min
 * - 10x safety margin for edge cases = 180 requests/min
 * 
 * Limit: 180/min allows ~3 req/sec sustained
 * - Normal usage (organizers managing runs): ✅ well under limit
 * - Abusive script creating runs in loop: ❌ blocked quickly
 */
export const MODERATE_TRAFFIC_LIMIT = {
    max: 180,
    timeWindow: 60000, // 1 minute
};

/**
 * For low-traffic endpoints like config updates, admin actions, guild setup.
 * 
 * Limit: 60/min, plenty for occasional admin operations.
 * Admin actions are rare and don't need high throughput.
 */
export const LOW_TRAFFIC_LIMIT = {
    max: 60,
    timeWindow: 60000, // 1 minute
};

/**
 * Helper to create route-specific rate limit config for Fastify.
 * Usage in routes:
 * 
 * app.post('/runs/:id/reactions', {
 *   config: { rateLimit: createRateLimitConfig(HIGH_TRAFFIC_LIMIT) }
 * }, async (req, reply) => { ... })
 */
export function createRateLimitConfig(limits: { max: number; timeWindow: number }) {
    return {
        max: limits.max,
        timeWindow: limits.timeWindow,
    };
}

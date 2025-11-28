/**
 * Operation Context for API Call Caching
 * 
 * Provides per-operation caching to reduce redundant HTTP calls.
 * Scope: Single logical operation (e.g., scheduled quota panel update run)
 * 
 * Usage:
 *   const ctx = new OperationContext();
 *   await updateQuotaPanels(client, ctx);
 * 
 * This ensures that within a single operation:
 * - Quota configs are fetched once per guild
 * - Guild channels are fetched once per guild
 * - Guild roles are fetched once per guild
 */

import { getJSON } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('OperationContext');

export class OperationContext {
    private quotaConfigs = new Map<string, QuotaConfigsResponse>();
    private guildChannels = new Map<string, GuildChannelsResponse>();
    private guildRoles = new Map<string, GuildRolesResponse>();
    private quotaRoleConfigs = new Map<string, QuotaRoleConfigResponse>(); // Key: "guildId:roleId"

    /**
     * Get quota configs for a guild (cached within this operation)
     */
    async getQuotaConfigs(guildId: string): Promise<QuotaConfigsResponse> {
        const cached = this.quotaConfigs.get(guildId);
        if (cached) {
            logger.debug('Using cached quota configs', { guildId, source: 'cache' });
            return cached;
        }

        logger.debug('Fetching quota configs', { guildId, source: 'api' });
        const result = await getJSON<QuotaConfigsResponse>(`/quota/configs/${guildId}`, { guildId });
        this.quotaConfigs.set(guildId, result);
        return result;
    }

    /**
     * Get guild channels (cached within this operation)
     */
    async getGuildChannels(guildId: string): Promise<GuildChannelsResponse> {
        const cached = this.guildChannels.get(guildId);
        if (cached) {
            logger.debug('Using cached guild channels', { guildId, source: 'cache' });
            return cached;
        }

        logger.debug('Fetching guild channels', { guildId, source: 'api' });
        const result = await getJSON<GuildChannelsResponse>(`/guilds/${guildId}/channels`, { guildId });
        this.guildChannels.set(guildId, result);
        return result;
    }

    /**
     * Get guild roles (cached within this operation)
     */
    async getGuildRoles(guildId: string): Promise<GuildRolesResponse> {
        const cached = this.guildRoles.get(guildId);
        if (cached) {
            logger.debug('Using cached guild roles', { guildId, source: 'cache' });
            return cached;
        }

        logger.debug('Fetching guild roles', { guildId, source: 'api' });
        const result = await getJSON<GuildRolesResponse>(`/guilds/${guildId}/roles`, { guildId });
        this.guildRoles.set(guildId, result);
        return result;
    }

    /**
     * Get quota role config (cached within this operation)
     */
    async getQuotaRoleConfig(guildId: string, roleId: string): Promise<QuotaRoleConfigResponse> {
        const key = `${guildId}:${roleId}`;
        const cached = this.quotaRoleConfigs.get(key);
        if (cached) {
            logger.debug('Using cached quota role config', { guildId, roleId, source: 'cache' });
            return cached;
        }

        logger.debug('Fetching quota role config', { guildId, roleId, source: 'api' });
        const result = await getJSON<QuotaRoleConfigResponse>(`/quota/config/${guildId}/${roleId}`, { 
            guildId, 
            roleId 
        });
        this.quotaRoleConfigs.set(key, result);
        return result;
    }

    /**
     * Get cache statistics for debugging
     */
    getStats(): { quotaConfigs: number; guildChannels: number; guildRoles: number; quotaRoleConfigs: number } {
        return {
            quotaConfigs: this.quotaConfigs.size,
            guildChannels: this.guildChannels.size,
            guildRoles: this.guildRoles.size,
            quotaRoleConfigs: this.quotaRoleConfigs.size,
        };
    }

    /**
     * Clear all cached data (useful for testing or explicit cache invalidation)
     */
    clear(): void {
        this.quotaConfigs.clear();
        this.guildChannels.clear();
        this.guildRoles.clear();
        this.quotaRoleConfigs.clear();
    }
}

// Type definitions for API responses
export interface QuotaConfigsResponse {
    configs: Array<{
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
    }>;
}

export interface GuildChannelsResponse {
    channels: Record<string, string | null>;
}

export interface GuildRolesResponse {
    roles: Record<string, string | null>;
}

export interface QuotaRoleConfigResponse {
    config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
        moderation_points: number;
        base_exalt_points: number;
        base_non_exalt_points: number;
        verify_points: number;
        warn_points: number;
        suspend_points: number;
        modmail_reply_points: number;
        editname_points: number;
        addnote_points: number;
    } | null;
    dungeon_overrides: Record<string, number>;
}

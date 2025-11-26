// bot/src/lib/http.ts
import { randomUUID } from 'crypto';
import { Client } from 'discord.js';
import { botConfig } from '../../config.js';
import { createLogger } from '../logging/logger.js';
import { updateQuotaPanelsForUser } from '../ui/quota-panel.js';

const BASE = botConfig.BACKEND_URL;
const API_KEY = botConfig.BACKEND_API_KEY;
const logger = createLogger('HTTP');

interface RequestContext {
    guildId?: string;
}

function headers(requestId: string, ctx?: RequestContext) {
    const hdrs: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'x-request-id': requestId, // Correlation ID for tracing
    };
    
    // Add guild context if provided
    if (ctx?.guildId) {
        hdrs['x-guild-id'] = ctx.guildId;
    }
    
    return hdrs;
}

export class BackendError extends Error {
    code?: string;
    status?: number;
    requestId?: string;
    data?: any; // Additional error data from backend
    constructor(message: string, code?: string, status?: number, requestId?: string, data?: any) {
        super(message);
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.data = data;
    }
}

async function handle(res: Response, requestId: string) {
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (res.ok) return data;

    // Expect unified error: { error: { code, message, ...extra } }
    const code = data?.error?.code ?? 'UNKNOWN';
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new BackendError(msg, code, res.status, requestId, data?.error);
}

async function makeRequest<T>(method: string, path: string, body?: any, ctx?: RequestContext): Promise<T> {
    const requestId = randomUUID().slice(0, 8);
    const start = Date.now();
    
    logger.debug('API request starting', { requestId, method, path, guildId: ctx?.guildId });
    
    // Create abort controller for timeout (25s to leave buffer before Discord's 30s limit)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    
    try {
        const options: RequestInit = { 
            method, 
            headers: headers(requestId, ctx),
            signal: controller.signal
        };
        
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }
        
        const res = await fetch(`${BASE}${path}`, options);
        const duration = Date.now() - start;
        
        logger.info('API request completed', { 
            requestId, 
            method, 
            path, 
            status: res.status, 
            duration,
            guildId: ctx?.guildId
        });
        
        clearTimeout(timeoutId);
        return handle(res, requestId) as Promise<T>;
    } catch (err) {
        clearTimeout(timeoutId);
        const duration = Date.now() - start;
        
        // Check if this was a timeout/abort
        if (err instanceof Error && err.name === 'AbortError') {
            logger.error('API request timed out', {
                requestId,
                method,
                path,
                duration,
                guildId: ctx?.guildId
            });
            throw new BackendError(
                'Request to backend timed out. The server may be overloaded.',
                'TIMEOUT',
                undefined,
                requestId
            );
        }
        
        if (err instanceof BackendError) {
            logger.warn('API request failed with backend error', { 
                requestId, 
                method, 
                path, 
                status: err.status,
                code: err.code,
                duration,
                message: err.message,
                guildId: ctx?.guildId
            });
        } else {
            logger.error('API request failed', { 
                requestId, 
                method, 
                path, 
                duration,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                guildId: ctx?.guildId
            });
        }
        
        throw err;
    }
}

export async function getJSON<T>(path: string, ctx?: RequestContext): Promise<T> {
    return makeRequest<T>('GET', path, undefined, ctx);
}

export async function postJSON<T>(path: string, body: any, ctx?: RequestContext): Promise<T> {
    return makeRequest<T>('POST', path, body, ctx);
}

export async function patchJSON<T>(path: string, body: any, ctx?: RequestContext): Promise<T> {
    return makeRequest<T>('PATCH', path, body, ctx);
}

export async function deleteJSON<T>(path: string, body: any, ctx?: RequestContext): Promise<T> {
    return makeRequest<T>('DELETE', path, body, ctx);
}

/** Create a modmail ticket (POST /modmail/tickets) */
export async function createModmailTicket(payload: {
    ticket_id: string;
    guild_id: string;
    user_id: string;
    content: string;
    attachments: string[];
    thread_id?: string;
    message_id?: string;
}): Promise<{
    ticket_id: string;
    guild_id: string;
    user_id: string;
    status: string;
    thread_id: string | null;
    message_id: string | null;
    created_at: string;
}> {
    return postJSON('/modmail/tickets', payload, { guildId: payload.guild_id });
}

/** Get a modmail ticket (GET /modmail/tickets/:ticket_id) */
export async function getModmailTicket(
    ticketId: string,
    guildId?: string
): Promise<{
    ticket_id: string;
    guild_id: string;
    user_id: string;
    status: string;
    thread_id: string | null;
    message_id: string | null;
    created_at: string;
    closed_at: string | null;
    closed_by: string | null;
}> {
    return getJSON(`/modmail/tickets/${ticketId}`, guildId ? { guildId } : undefined);
}

/** Close a modmail ticket (PATCH /modmail/tickets/:ticket_id/close) */
export async function closeModmailTicket(
    ticketId: string,
    payload: {
        closed_by: string;
    },
    guildId?: string
): Promise<{
    ticket_id: string;
    status: string;
    closed_at: string;
    closed_by: string;
}> {
    return patchJSON(`/modmail/tickets/${ticketId}/close`, payload, guildId ? { guildId } : undefined);
}

/** Add a message to a modmail ticket (POST /modmail/tickets/:ticket_id/messages) */
export async function addModmailMessage(
    ticketId: string,
    payload: {
        author_id: string;
        content: string;
        attachments?: string[];
        is_staff_reply: boolean;
    },
    guildId?: string
): Promise<{
    message_id: number;
    ticket_id: string;
    author_id: string;
    content: string;
    attachments: string[];
    sent_at: string;
    is_staff_reply: boolean;
}> {
    return postJSON(`/modmail/tickets/${ticketId}/messages`, payload, guildId ? { guildId } : undefined);
}

/** Get all messages for a modmail ticket (GET /modmail/tickets/:ticket_id/messages) */
export async function getModmailMessages(
    ticketId: string,
    guildId?: string
): Promise<{
    messages: Array<{
        message_id: number;
        ticket_id: string;
        author_id: string;
        content: string;
        attachments: string[];
        sent_at: string;
        is_staff_reply: boolean;
    }>;
}> {
    return getJSON(`/modmail/tickets/${ticketId}/messages`, guildId ? { guildId } : undefined);
}

/** Get open modmail tickets for a guild (GET /modmail/tickets/guild/:guild_id) */
export async function getGuildModmailTickets(
    guildId: string,
    status?: 'open' | 'closed'
): Promise<{
    tickets: Array<{
        ticket_id: string;
        guild_id: string;
        user_id: string;
        status: string;
        thread_id: string | null;
        message_id: string | null;
        created_at: string;
        closed_at: string | null;
        closed_by: string | null;
    }>;
}> {
    const query = status ? `?status=${status}` : '';
    return getJSON(`/modmail/tickets/guild/${guildId}${query}`, { guildId });
}

/** Check if a user is blacklisted from modmail (GET /modmail/blacklist/:guild_id/:user_id) */
export async function checkModmailBlacklist(
    guildId: string,
    userId: string
): Promise<{
    blacklisted: boolean;
    reason: string | null;
    blacklisted_by: string | null;
    blacklisted_at: string | null;
}> {
    return getJSON(`/modmail/blacklist/${guildId}/${userId}`, { guildId });
}

/** Blacklist a user from modmail (POST /modmail/blacklist) */
export async function blacklistModmail(payload: {
    actor_user_id: string;
    actor_roles: string[];
    guild_id: string;
    user_id: string;
    reason: string;
}): Promise<{
    success: boolean;
    blacklist: {
        guild_id: string;
        user_id: string;
        modmail_blacklisted: boolean;
        modmail_blacklist_reason: string;
        modmail_blacklisted_by: string;
        modmail_blacklisted_at: string;
    };
}> {
    return postJSON('/modmail/blacklist', payload, { guildId: payload.guild_id });
}

/** Unblacklist a user from modmail (POST /modmail/unblacklist) */
export async function unblacklistModmail(payload: {
    actor_user_id: string;
    actor_roles: string[];
    guild_id: string;
    user_id: string;
    reason: string;
}): Promise<{
    success: boolean;
    message: string;
}> {
    return postJSON('/modmail/unblacklist', payload, { guildId: payload.guild_id });
}

/** Set key window for a run (PATCH /runs/:id/key-window) */
export async function setKeyWindow(
    runId: number,
    payload: { actor_user_id: string; seconds?: number },
    guildId: string
): Promise<{ key_window_ends_at: string }> {
    return patchJSON(`/runs/${runId}/key-window`, payload, { guildId });
}

/** Verify a raider (POST /raiders/verify) */
export async function verifyRaider(payload: {
    actor_user_id: string;
    actor_roles?: string[];
    guild_id: string;
    user_id: string;
    ign: string;
}): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    status: string;
    verified_at: string;
}> {
    return postJSON('/raiders/verify', payload);
}

/** Get a raider's info (GET /raiders/:guild_id/:user_id) */
export async function getRaider(
    guildId: string,
    userId: string
): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    alt_ign: string | null;
    status: string;
    verified_at: string | null;
} | null> {
    try {
        return await getJSON(`/raiders/${guildId}/${userId}`);
    } catch (err) {
        if (err instanceof BackendError && err.status === 404) {
            return null; // Raider not found
        }
        throw err;
    }
}

/** Update a raider's IGN (PATCH /raiders/:user_id/ign) */
export async function updateRaiderIGN(
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        guild_id: string;
        ign: string;
    }
): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    alt_ign: string | null;
    status: string;
    verified_at: string;
    old_ign: string;
}> {
    return patchJSON(`/raiders/${userId}/ign`, payload);
}

/** Update a raider's status (PATCH /raiders/:user_id/status) */
export async function updateRaiderStatus(
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        guild_id: string;
        status: 'pending' | 'approved' | 'rejected' | 'banned';
    }
): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    status: string;
    verified_at: string | null;
    old_status: string;
}> {
    return patchJSON(`/raiders/${userId}/status`, payload);
}

/** Add or update a raider's alt IGN (PATCH /raiders/:user_id/alt) */
export async function addRaiderAlt(
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        guild_id: string;
        alt_ign: string;
    }
): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    alt_ign: string | null;
    status: string;
    verified_at: string;
    old_alt_ign: string | null;
}> {
    return patchJSON(`/raiders/${userId}/alt`, payload);
}

/** Remove a raider's alt IGN (DELETE /raiders/:user_id/alt) */
export async function removeRaiderAlt(
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        guild_id: string;
    }
): Promise<{
    guild_id: string;
    user_id: string;
    ign: string;
    alt_ign: string | null;
    status: string;
    verified_at: string | null;
    old_alt_ign: string | null;
}> {
    return deleteJSON(`/raiders/${userId}/alt`, payload);
}

/** Unverify a raider (DELETE /raiders/:guild_id/:user_id/unverify) */
export async function unverifyRaider(
    guildId: string,
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        reason?: string;
    }
): Promise<{
    success: boolean;
    message: string;
    ign: string;
}> {
    return deleteJSON(`/raiders/${guildId}/${userId}/unverify`, payload);
}

/** Get guild role mappings (GET /guilds/:guild_id/roles) */
export async function getGuildRoles(
    guildId: string
): Promise<{ roles: Record<string, string | null> }> {
    return getJSON(`/guilds/${guildId}/roles`);
}

/** Update guild role mappings (PUT /guilds/:guild_id/roles) */
export async function setGuildRoles(
    guildId: string,
    payload: {
        actor_user_id: string;
        roles: Record<string, string | null>;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{ roles: Record<string, string | null>; warnings?: string[] }> {
    return makeRequest('PUT', `/guilds/${guildId}/roles`, payload);
}

/** Get guild channel mappings (GET /guilds/:guild_id/channels) */
export async function getGuildChannels(
    guildId: string
): Promise<{ channels: Record<string, string | null> }> {
    return getJSON(`/guilds/${guildId}/channels`);
}

/** Update guild channel mappings (PUT /guilds/:guild_id/channels) */
export async function setGuildChannels(
    guildId: string,
    payload: {
        actor_user_id: string;
        channels: Record<string, string | null>;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{ channels: Record<string, string | null>; warnings?: string[] }> {
    return makeRequest('PUT', `/guilds/${guildId}/channels`, payload);
}

/** Get guild dungeon role ping mappings (GET /guilds/:guild_id/dungeon-role-pings) */
export async function getDungeonRolePings(
    guildId: string
): Promise<{ dungeon_role_pings: Record<string, string> }> {
    return getJSON(`/guilds/${guildId}/dungeon-role-pings`);
}

/** Update guild dungeon role ping mapping (PUT /guilds/:guild_id/dungeon-role-pings) */
export async function setDungeonRolePing(
    guildId: string,
    payload: {
        actor_user_id: string;
        dungeon_key: string;
        discord_role_id: string | null;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{ 
    dungeon_role_pings: Record<string, string>;
    updated: { dungeon_key: string; discord_role_id: string | null };
}> {
    return makeRequest('PUT', `/guilds/${guildId}/dungeon-role-pings`, payload);
}

/** Create a punishment (POST /punishments) */
export async function createPunishment(payload: {
    actor_user_id: string;
    guild_id: string;
    user_id: string;
    type: 'warn' | 'suspend' | 'mute';
    reason: string;
    duration_minutes?: number;
    actor_roles?: string[];
}): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    type: string;
    reason: string;
    expires_at: string | null;
    active: boolean;
    created_at: string;
}> {
    return postJSON('/punishments', payload);
}

/** Get a punishment by ID (GET /punishments/:id) */
export async function getPunishment(
    id: string
): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    type: string;
    reason: string;
    expires_at: string | null;
    active: boolean;
    created_at: string;
    removed_at: string | null;
    removed_by: string | null;
    removal_reason: string | null;
}> {
    return getJSON(`/punishments/${id}`);
}

/** Get all punishments for a user (GET /punishments/user/:guild_id/:user_id) */
export async function getUserPunishments(
    guildId: string,
    userId: string,
    activeOnly?: boolean
): Promise<{
    punishments: Array<{
        id: string;
        guild_id: string;
        user_id: string;
        moderator_id: string;
        type: string;
        reason: string;
        expires_at: string | null;
        active: boolean;
        created_at: string;
        removed_at: string | null;
        removed_by: string | null;
        removal_reason: string | null;
    }>;
}> {
    const query = activeOnly !== undefined ? `?active=${activeOnly}` : '';
    return getJSON(`/punishments/user/${guildId}/${userId}${query}`);
}

/** Remove a punishment (DELETE /punishments/:id) */
export async function removePunishment(
    id: string,
    payload: {
        actor_user_id: string;
        removal_reason: string;
        actor_roles?: string[];
        actor_has_admin?: boolean;
    }
): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    type: string;
    reason: string;
    expires_at: string | null;
    active: boolean;
    created_at: string;
    removed_at: string;
    removed_by: string;
    removal_reason: string;
}> {
    return deleteJSON(`/punishments/${id}`, payload);
}

/** Get quota statistics for a user (GET /quota/stats/:guild_id/:user_id) */
export async function getQuotaStats(
    guildId: string,
    userId: string
): Promise<{
    total_points: number;
    total_quota_points: number;
    total_runs_organized: number;
    total_verifications: number;
    total_keys_popped: number;
    dungeons: Array<{ dungeon_key: string; completed: number; organized: number; keys_popped: number }>;
}> {
    return getJSON(`/quota/stats/${guildId}/${userId}`);
}

/** Get quota role configuration (GET /quota/config/:guild_id/:role_id) */
export async function getQuotaRoleConfig(
    guildId: string,
    roleId: string
): Promise<{
    config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
        moderation_points: number;
        base_exalt_points: number;
        base_non_exalt_points: number;
    } | null;
    dungeon_overrides: Record<string, number>;
}> {
    return getJSON(`/quota/config/${guildId}/${roleId}`);
}

/** Update quota role configuration (PUT /quota/config/:guild_id/:role_id) */
export async function updateQuotaRoleConfig(
    guildId: string,
    roleId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        required_points?: number;
        reset_at?: string;
        created_at?: string;
        panel_message_id?: string | null;
        moderation_points?: number;
        base_exalt_points?: number;
        base_non_exalt_points?: number;
        verify_points?: number;
        warn_points?: number;
        suspend_points?: number;
        modmail_reply_points?: number;
        editname_points?: number;
        addnote_points?: number;
    }
): Promise<{
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
    };
    dungeon_overrides: Record<string, number>;
}> {
    return makeRequest('PUT', `/quota/config/${guildId}/${roleId}`, payload);
}

/** Set dungeon point override (PUT /quota/config/:guild_id/:role_id/dungeon/:dungeon_key) */
export async function setDungeonOverride(
    guildId: string,
    roleId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        points: number;
    }
): Promise<{
    dungeon_overrides: Record<string, number>;
}> {
    return makeRequest('PUT', `/quota/config/${guildId}/${roleId}/dungeon/${dungeonKey}`, payload);
}

/** Delete dungeon point override (DELETE /quota/config/:guild_id/:role_id/dungeon/:dungeon_key) */
export async function deleteDungeonOverride(
    guildId: string,
    roleId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{
    dungeon_overrides: Record<string, number>;
}> {
    return makeRequest('DELETE', `/quota/config/${guildId}/${roleId}/dungeon/${dungeonKey}`, payload);
}

/** Delete quota role configuration (DELETE /quota/config/:guild_id/:role_id) */
export async function deleteQuotaRoleConfig(
    guildId: string,
    roleId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{
    success: boolean;
    message: string;
}> {
    return makeRequest('DELETE', `/quota/config/${guildId}/${roleId}`, payload);
}

/** Recalculate quota points for a role based on current configuration (POST /quota/recalculate/:guild_id/:role_id) */
export async function recalculateQuotaPoints(
    guildId: string,
    roleId: string,
    payload: {
        actorId: string;
        actorRoles?: string[];
    }
): Promise<{
    recalculated: number;
    total_points: number;
    message: string;
}> {
    return postJSON(`/quota/recalculate/${guildId}/${roleId}`, payload);
}

/** Get quota leaderboard (POST /quota/leaderboard/:guild_id/:role_id) */
export async function getQuotaLeaderboard(
    guildId: string,
    roleId: string,
    memberUserIds: string[]
): Promise<{
    config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
    };
    period_start: string;
    period_end: string;
    leaderboard: Array<{ user_id: string; points: number; runs: number }>;
}> {
    return postJSON(`/quota/leaderboard/${guildId}/${roleId}`, { member_user_ids: memberUserIds });
}

/** Award moderation points for moderation activities (POST /quota/award-moderation-points/:guild_id/:user_id) */
export async function awardModerationPoints(
    guildId: string,
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        command_type?: 'verify' | 'warn' | 'suspend' | 'modmail_reply' | 'editname' | 'addnote';
    }
): Promise<{
    points_awarded: number;
    roles_awarded?: number;
    message?: string;
}> {
    return postJSON(`/quota/award-moderation-points/${guildId}/${userId}`, payload);
}

/**
 * Award moderation points and immediately update the user's quota panels.
 * This is a convenience wrapper that combines point awarding with instant panel updates,
 * ensuring changes are visible immediately on quota leaderboards.
 * 
 * Use this function instead of calling awardModerationPoints directly to follow DRY principles
 * and ensure consistent behavior across all point-awarding operations.
 * 
 * @param client - Discord client instance
 * @param guildId - Guild ID where points are being awarded
 * @param userId - User ID receiving the points (the actor performing the moderation action)
 * @param payload - Award payload including actor info and command type
 * @returns The result from awardModerationPoints
 */
export async function awardModerationPointsWithUpdate(
    client: Client,
    guildId: string,
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        command_type?: 'verify' | 'warn' | 'suspend' | 'modmail_reply' | 'editname' | 'addnote';
    }
): Promise<{
    points_awarded: number;
    roles_awarded?: number;
    message?: string;
}> {
    // Award the points via API
    const result = await awardModerationPoints(guildId, userId, payload);
    
    // If points were actually awarded, update the user's quota panels
    if (result.points_awarded > 0) {
        // Don't await - update panels in background to avoid blocking the command response
        updateQuotaPanelsForUser(client, guildId, userId).catch(err => {
            logger.error('Failed to update quota panels after awarding points', {
                guildId,
                userId,
                pointsAwarded: result.points_awarded,
                error: err instanceof Error ? err.message : String(err)
            });
        });
    }
    
    return result;
}

/** Get raider points configuration for all dungeons (GET /quota/raider-points/:guild_id) */
export async function getRaiderPointsConfig(
    guildId: string
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return getJSON(`/quota/raider-points/${guildId}`);
}

/** Set raider points for a specific dungeon (PUT /quota/raider-points/:guild_id/:dungeon_key) */
export async function setRaiderPoints(
    guildId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        points: number;
    }
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return makeRequest('PUT', `/quota/raider-points/${guildId}/${dungeonKey}`, payload);
}

/** Delete raider points for a specific dungeon (DELETE /quota/raider-points/:guild_id/:dungeon_key) */
export async function deleteRaiderPoints(
    guildId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return makeRequest('DELETE', `/quota/raider-points/${guildId}/${dungeonKey}`, payload);
}

/** Get key pop points configuration for all dungeons (GET /quota/key-pop-points/:guild_id) */
export async function getKeyPopPointsConfig(
    guildId: string
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return getJSON(`/quota/key-pop-points/${guildId}`);
}

/** Set key pop points for a specific dungeon (PUT /quota/key-pop-points/:guild_id/:dungeon_key) */
export async function setKeyPopPoints(
    guildId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        points: number;
    }
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return makeRequest('PUT', `/quota/key-pop-points/${guildId}/${dungeonKey}`, payload);
}

/** Delete key pop points for a specific dungeon (DELETE /quota/key-pop-points/:guild_id/:dungeon_key) */
export async function deleteKeyPopPoints(
    guildId: string,
    dungeonKey: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
    }
): Promise<{
    dungeon_points: Record<string, number>;
}> {
    return makeRequest('DELETE', `/quota/key-pop-points/${guildId}/${dungeonKey}`, payload);
}

/** Manually adjust quota points for a user (POST /quota/adjust-quota-points/:guild_id/:user_id) */
export async function adjustQuotaPoints(
    guildId: string,
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        amount: number;
    }
): Promise<{
    success: boolean;
    amount_adjusted: number;
    new_total: number;
}> {
    return makeRequest('POST', `/quota/adjust-quota-points/${guildId}/${userId}`, payload);
}

/** Manually adjust regular (raider) points for a user (POST /quota/adjust-points/:guild_id/:user_id) */
export async function adjustPoints(
    guildId: string,
    userId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        amount: number;
    }
): Promise<{
    success: boolean;
    amount_adjusted: number;
    new_total: number;
}> {
    return makeRequest('POST', `/quota/adjust-points/${guildId}/${userId}`, payload);
}

/** Create a note (POST /notes) */
export async function createNote(payload: {
    actor_user_id: string;
    guild_id: string;
    user_id: string;
    note_text: string;
    actor_roles?: string[];
}): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    note_text: string;
    created_at: string;
}> {
    return postJSON('/notes', payload);
}

/** Get a note by ID (GET /notes/:id) */
export async function getNote(
    id: string
): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    note_text: string;
    created_at: string;
}> {
    return getJSON(`/notes/${id}`);
}

/** Get all notes for a user (GET /notes/user/:guild_id/:user_id) */
export async function getUserNotes(
    guildId: string,
    userId: string
): Promise<{
    notes: Array<{
        id: string;
        guild_id: string;
        user_id: string;
        moderator_id: string;
        note_text: string;
        created_at: string;
    }>;
}> {
    return getJSON(`/notes/user/${guildId}/${userId}`);
}

/** Remove a note (DELETE /notes/:id) */
export async function removeNote(
    id: string,
    payload: {
        actor_user_id: string;
        removal_reason: string;
        actor_roles?: string[];
        actor_has_admin?: boolean;
    }
): Promise<{
    id: string;
    guild_id: string;
    user_id: string;
    moderator_id: string;
    note_text: string;
    created_at: string;
    removed_by: string;
    removal_reason: string;
}> {
    return deleteJSON(`/notes/${id}`, payload);
}

/** Get guild verification config (GET /verification/config/:guild_id) */
export async function getGuildVerificationConfig(
    guildId: string
): Promise<{
    guild_id: string;
    manual_verify_instructions: string | null;
    panel_custom_message: string | null;
    manual_verify_instructions_image: string | null;
    panel_custom_message_image: string | null;
    realmeye_instructions_image: string | null;
    updated_at: string | null;
}> {
    return getJSON(`/verification/config/${guildId}`);
}

/** Update guild verification config (PUT /verification/config/:guild_id) */
export async function updateGuildVerificationConfig(
    guildId: string,
    config: {
        manual_verify_instructions?: string;
        panel_custom_message?: string;
        manual_verify_instructions_image?: string;
        panel_custom_message_image?: string;
        realmeye_instructions_image?: string;
    }
): Promise<{
    guild_id: string;
    manual_verify_instructions: string | null;
    panel_custom_message: string | null;
    manual_verify_instructions_image: string | null;
    panel_custom_message_image: string | null;
    realmeye_instructions_image: string | null;
    updated_at: string;
}> {
    return makeRequest('PUT', `/verification/config/${guildId}`, config);
}

/** Get leaderboard (GET /quota/leaderboard/:guild_id) */
export async function getLeaderboard(
    guildId: string,
    category: 'runs_organized' | 'keys_popped' | 'dungeon_completions' | 'points' | 'quota_points',
    dungeonKey: string = 'all',
    since?: string,
    until?: string
): Promise<{
    guild_id: string;
    category: string;
    dungeon_key: string;
    since: string | null;
    until: string | null;
    leaderboard: Array<{ user_id: string; count: number }>;
}> {
    const params = new URLSearchParams({
        category,
        dungeon_key: dungeonKey,
    });
    
    if (since) {
        params.append('since', since);
    }
    
    if (until) {
        params.append('until', until);
    }
    
    return getJSON(`/quota/leaderboard/${guildId}?${params.toString()}`);
}

/** Get active runs for an organizer (GET /runs/active-by-organizer/:organizerId) */
export async function getActiveRunsByOrganizer(
    guildId: string,
    organizerId: string
): Promise<{
    activeRuns: Array<{
        id: number;
        dungeonLabel: string;
        status: string;
        createdAt: string;
        channelId: string;
        postMessageId: string | null;
    }>;
}> {
    return getJSON(`/runs/active-by-organizer/${organizerId}`, { guildId });
}

/** Bulk sync members' IGNs (POST /sync/bulk) */
export async function bulkSyncMembers(
    guildId: string,
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        actor_has_admin_permission?: boolean;
        members: Array<{
            user_id: string;
            main_ign: string;
            alt_ign?: string;
        }>;
    }
): Promise<{
    synced: Array<{ user_id: string; status: 'synced'; ign: string }>;
    skipped: Array<{ user_id: string; status: 'skipped'; reason: string }>;
    failed: Array<{ user_id: string; status: 'failed'; reason: string }>;
}> {
    return postJSON('/sync/bulk', {
        guild_id: guildId,
        ...payload,
    }, { guildId });
}

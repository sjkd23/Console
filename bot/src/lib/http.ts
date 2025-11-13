// bot/src/lib/http.ts
import { botConfig } from '../config.js';

const BASE = botConfig.BACKEND_URL;
const API_KEY = botConfig.BACKEND_API_KEY;

function headers() {
    return {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
    };
}

export class BackendError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

async function handle(res: Response) {
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (res.ok) return data;

    // Expect unified error: { error: { code, message } }
    const code = data?.error?.code ?? 'UNKNOWN';
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw new BackendError(msg, code, res.status);
}

export async function getJSON<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { method: 'GET', headers: headers() });
    return handle(res) as Promise<T>;
}

export async function postJSON<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return handle(res) as Promise<T>;
}

export async function patchJSON<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
    return handle(res) as Promise<T>;
}

export async function deleteJSON<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: headers(), body: JSON.stringify(body) });
    return handle(res) as Promise<T>;
}

/** Set key window for a run (PATCH /runs/:id/key-window) */
export async function setKeyWindow(
    runId: number,
    payload: { actor_user_id: string; seconds?: number }
): Promise<{ key_window_ends_at: string }> {
    return patchJSON(`/runs/${runId}/key-window`, payload);
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
    return fetch(`${BASE}/guilds/${guildId}/roles`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/guilds/${guildId}/channels`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
}

/** Create a punishment (POST /punishments) */
export async function createPunishment(payload: {
    actor_user_id: string;
    guild_id: string;
    user_id: string;
    type: 'warn' | 'suspend';
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
    }
): Promise<{
    config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
    };
    dungeon_overrides: Record<string, number>;
}> {
    return fetch(`${BASE}/quota/config/${guildId}/${roleId}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/config/${guildId}/${roleId}/dungeon/${dungeonKey}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/config/${guildId}/${roleId}/dungeon/${dungeonKey}`, {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/raider-points/${guildId}/${dungeonKey}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/raider-points/${guildId}/${dungeonKey}`, {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/key-pop-points/${guildId}/${dungeonKey}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/key-pop-points/${guildId}/${dungeonKey}`, {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/adjust-quota-points/${guildId}/${userId}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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
    return fetch(`${BASE}/quota/adjust-points/${guildId}/${userId}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
    }).then(handle);
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

import { randomUUID } from 'node:crypto';
import { EmbedConfigSchema, type EmbedConfig, type SavedEmbed } from './contract.js';

export const SESSION_TTL = 30 * 60_000;
export interface EmbedSession {
    id: string; guildId: string; ownerId: string; expiresAt: number; messageId?: string;
    config: EmbedConfig; saved?: SavedEmbed; selected: number; mode: 'main' | 'fields' | 'delete';
    namespace?: string; channelId?: string; revision: number; busy: boolean; notice?: string;
}
export const sessions = new Map<string, EmbedSession>();
export function expireSessions(now = Date.now()): void {
    for (const [id, session] of sessions) if (session.expiresAt <= now && !session.busy) sessions.delete(id);
}
const cleanup = setInterval(expireSessions, 60_000);
cleanup.unref();
export function createSession(guildId: string, ownerId: string, saved?: SavedEmbed, now = Date.now()): EmbedSession {
    if (saved && saved.guild_id !== guildId) throw new Error('That saved embed belongs to another server.');
    expireSessions(now);
    if (sessions.size >= 1000 || [...sessions.values()].filter(s => s.ownerId === ownerId).length >= 5) {
        throw new Error('Too many open builders. Cancel an existing builder or wait for it to expire.');
    }
    const session: EmbedSession = {
        id: randomUUID(), guildId, ownerId, expiresAt: now + SESSION_TTL,
        config: EmbedConfigSchema.parse(saved?.config ?? { description: 'Your embed text goes here.', fields: [] }),
        saved: saved ? structuredClone(saved) : undefined, selected: 0, mode: 'main', revision: 0, busy: false,
        channelId: saved?.published_channel_id ?? undefined,
    };
    sessions.set(session.id, session);
    return session;
}
export function isDirty(session: EmbedSession): boolean {
    return !session.saved || JSON.stringify(session.config) !== JSON.stringify(session.saved.config);
}
/** Parse a copy first: failed edits never modify the draft. */
export function editDraft(session: EmbedSession, mutate: (config: EmbedConfig) => void): void {
    const next = structuredClone(session.config);
    mutate(next);
    session.config = EmbedConfigSchema.parse(next);
}

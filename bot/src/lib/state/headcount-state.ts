/**
 * Helper module to access and manage ephemeral headcount state.
 * This avoids circular dependencies by providing a clean interface to read headcount data.
 */

import { EmbedBuilder } from 'discord.js';

/**
 * Headcount state interface
 */
export interface HeadcountState {
    interestedUsersByDungeon: Map<string, Set<string>>;
    keyOffersByDungeon: Map<string, Set<string>>;
    dungeonCodes: string[];
    organizerId: string;
}
/**
 * In-memory storage for dungeon-specific interest.
 * Map structure: messageId -> dungeonCode -> Set<userId>
 */
const interestsStore = new Map<string, Map<string, Set<string>>>();
const dungeonCodesStore = new Map<string, string[]>();

/**
 * Get interested users for one dungeon in a headcount.
 */
export function getInterestedUsers(messageId: string, dungeonCode: string): Set<string> {
    let interestsByDungeon = interestsStore.get(messageId);
    if (!interestsByDungeon) {
        interestsByDungeon = new Map<string, Set<string>>();
        interestsStore.set(messageId, interestsByDungeon);
    }

    let interestedUsers = interestsByDungeon.get(dungeonCode);
    if (!interestedUsers) {
        interestedUsers = new Set<string>();
        interestsByDungeon.set(dungeonCode, interestedUsers);
    }

    return interestedUsers;
}

export function getInterestsByDungeon(messageId: string): ReadonlyMap<string, ReadonlySet<string>> {
    return interestsStore.get(messageId) ?? new Map<string, Set<string>>();
}

export function toggleDungeonInterest(
    messageId: string,
    dungeonCode: string,
    userId: string
): { interested: boolean; count: number } {
    const interestedUsers = getInterestedUsers(messageId, dungeonCode);
    const interested = !interestedUsers.delete(userId);
    if (interested) interestedUsers.add(userId);
    return { interested, count: interestedUsers.size };
}

/**
 * Clear all interest and selected-dungeon state for a headcount panel.
 * Used when ending or converting a headcount.
 */
export function clearHeadcountState(messageId: string): void {
    interestsStore.delete(messageId);
    dungeonCodesStore.delete(messageId);
}

/**
 * Extract organizer ID from the embed description.
 */
export function getOrganizerId(embed: EmbedBuilder): string | null {
    const data = embed.toJSON();
    const description = data.description || '';
    
    const match = description.match(/Organizer:\s*<@(\d+)>/);
    return match ? match[1] : null;
}

/**
 * Extract dungeon codes from the embed description.
 * Dungeons are listed in a "**Dungeons:**" section.
 */
export function getDungeonCodes(_embed: EmbedBuilder, messageId?: string): string[] {
    return messageId ? [...(dungeonCodesStore.get(messageId) ?? [])] : [];
}

export function setDungeonCodes(messageId: string, dungeonCodes: readonly string[]): void {
    dungeonCodesStore.set(messageId, [...dungeonCodes]);
}

/**
 * Resolve the authoritative ordered selection for a headcount. Component-derived
 * codes are accepted only for panels created before explicit state was stored.
 */
export function resolveHeadcountDungeonCodes(
    messageId: string,
    legacyComponentCodes: readonly string[]
): string[] {
    return dungeonCodesStore.has(messageId)
        ? [...(dungeonCodesStore.get(messageId) ?? [])]
        : [...legacyComponentCodes];
}

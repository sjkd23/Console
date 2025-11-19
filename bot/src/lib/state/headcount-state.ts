/**
 * Helper module to access and manage headcount state stored in headcount-join and headcount-key handlers.
 * This avoids circular dependencies by providing a clean interface to read headcount data.
 */

import { EmbedBuilder } from 'discord.js';

/**
 * Headcount state interface
 */
export interface HeadcountState {
    participants: Set<string>;
    keyOffersByDungeon: Map<string, Set<string>>;
    dungeonCodes: string[];
    organizerId: string;
}

/**
 * In-memory storage for headcount participants.
 * Map structure: messageId -> Set<userId>
 * This prevents participant names from appearing on the public panel.
 */
const participantsStore = new Map<string, Set<string>>();

/**
 * Get participants for a specific headcount panel.
 * Now uses in-memory storage instead of parsing the embed description.
 */
export function getParticipants(embed: EmbedBuilder, messageId?: string): Set<string> {
    if (messageId) {
        // Use in-memory store if messageId is provided
        let participants = participantsStore.get(messageId);
        if (!participants) {
            participants = new Set<string>();
            participantsStore.set(messageId, participants);
        }
        return participants;
    }
    
    // Fallback: try to extract from embed description for backwards compatibility
    const data = embed.toJSON();
    const description = data.description || '';
    
    const match = description.match(/\*\*Joined:\*\*\s*([^\n]*)/);
    if (!match || !match[1].trim()) return new Set();
    
    // Extract user IDs from mentions like <@123456789>
    const mentions = match[1].matchAll(/<@(\d+)>/g);
    return new Set(Array.from(mentions, m => m[1]));
}

/**
 * Clear participants for a specific headcount panel.
 * Used when ending or converting a headcount.
 */
export function clearParticipants(messageId: string): void {
    participantsStore.delete(messageId);
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
export function getDungeonCodes(embed: EmbedBuilder): string[] {
    const data = embed.toJSON();
    const description = data.description || '';
    
    // Extract the button custom IDs from the message components to get dungeon codes
    // This is more reliable than parsing the description
    // For now, we'll return empty and populate from button customIds in the handler
    return [];
}

/**
 * Update the embed description to remove the list of participants.
 * Participants should only be visible in the organizer panel, not on the public embed.
 * The public embed only shows the count in the "Interested" or "Participants" field.
 * 
 * Note: This function now only cleans up any legacy "Joined:" sections.
 * Participants are stored in memory via getParticipants() instead.
 */
export function updateParticipantsList(embed: EmbedBuilder, participants: Set<string>): EmbedBuilder {
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Remove existing "Joined:" section if present
    // This ensures participant names are never shown on the public panel
    description = description.replace(/\n\n\*\*Joined:\*\*\s*[^\n]*/, '');
    
    return new EmbedBuilder(data).setDescription(description);
}

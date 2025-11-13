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
 * Extract participant user IDs from the embed description.
 * Participants are listed as user mentions in a "**Joined:**" section.
 */
export function getParticipants(embed: EmbedBuilder): Set<string> {
    const data = embed.toJSON();
    const description = data.description || '';
    
    const match = description.match(/\*\*Joined:\*\*\s*([^\n]*)/);
    if (!match || !match[1].trim()) return new Set();
    
    // Extract user IDs from mentions like <@123456789>
    const mentions = match[1].matchAll(/<@(\d+)>/g);
    return new Set(Array.from(mentions, m => m[1]));
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
 * Update the embed description to show the list of participants.
 */
export function updateParticipantsList(embed: EmbedBuilder, participants: Set<string>): EmbedBuilder {
    const data = embed.toJSON();
    let description = data.description || '';
    
    // Remove existing "Joined:" section if present
    description = description.replace(/\n\n\*\*Joined:\*\*\s*[^\n]*/, '');
    
    // Add updated "Joined:" section if there are participants
    if (participants.size > 0) {
        const mentions = Array.from(participants).map(id => `<@${id}>`).join(', ');
        description += `\n\n**Joined:** ${mentions}`;
    }
    
    return new EmbedBuilder(data).setDescription(description);
}

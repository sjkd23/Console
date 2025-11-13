/**
 * Shared autocomplete handler for dungeon selection.
 * Used by /run, /logrun, and /logkey commands.
 */

import { AutocompleteInteraction } from 'discord.js';
import { dungeonByCode, searchDungeons } from '../constants/dungeon-helpers.js';
import { getRecentDungeons } from './dungeon-cache.js';

/**
 * Handles autocomplete for dungeon selection fields.
 * Shows recently used dungeons when query is empty, otherwise searches.
 * @param interaction - The autocomplete interaction
 * @param fieldName - The option field name to handle (defaults to 'dungeon')
 */
export async function handleDungeonAutocomplete(
    interaction: AutocompleteInteraction,
    fieldName: string = 'dungeon'
): Promise<void> {
    const focused = interaction.options.getFocused(true);
    
    if (focused.name !== fieldName) {
        await interaction.respond([]);
        return;
    }

    const query = (focused.value ?? '').trim();

    let results;
    if (!query && interaction.guildId) {
        // Empty query: show recently used dungeons for this guild
        const recentCodes = getRecentDungeons(interaction.guildId, 25);
        results = recentCodes
            .map(code => dungeonByCode[code])
            .filter(d => d) // Filter out any undefined
            .map(d => ({
                name: d.dungeonName,
                value: d.codeName
            }));
        
        // If no recent dungeons, fall back to search behavior
        if (results.length === 0) {
            results = searchDungeons('', 25).map(d => ({
                name: d.dungeonName,
                value: d.codeName
            }));
        }
    } else {
        // Non-empty query: perform normal search
        results = searchDungeons(query, 25).map(d => ({
            name: d.dungeonName,
            value: d.codeName
        }));
    }

    await interaction.respond(results);
}

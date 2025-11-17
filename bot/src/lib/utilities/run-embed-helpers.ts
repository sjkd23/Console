/**
 * Shared utilities for updating run embed fields.
 * Provides consistent formatting for raiders count, class distribution, and keys.
 */

import { EmbedBuilder } from 'discord.js';

/**
 * Update the Raiders count field in the embed.
 * 
 * @param embed - The embed to update
 * @param count - The number of raiders
 * @returns Updated embed
 */
export function setRaidersField(embed: EmbedBuilder, count: number): EmbedBuilder {
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: String(count) };
    } else {
        fields.push({ name: 'Raiders', value: String(count), inline: false });
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

/**
 * Update the Classes field in the embed with formatted class distribution.
 * NOTE: Classes field display has been disabled. This function now removes the field if present.
 * 
 * @param embed - The embed to update
 * @param classCounts - Map of class names to counts (unused, kept for API compatibility)
 * @returns Updated embed
 */
export function updateClassField(embed: EmbedBuilder, classCounts: Record<string, number>): EmbedBuilder {
    const data = embed.toJSON();
    let fields = [...(data.fields ?? [])];

    // Remove Classes field if present (feature disabled)
    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (idx >= 0) {
        fields.splice(idx, 1);
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

/**
 * Update both raiders and class fields in the embed.
 * Convenience function that combines setRaidersField and updateClassField.
 * 
 * @param embed - The embed to update
 * @param joinCount - The number of raiders
 * @param classCounts - Map of class names to counts
 * @returns Updated embed
 */
export function updateRunParticipation(
    embed: EmbedBuilder,
    joinCount: number,
    classCounts: Record<string, number>
): EmbedBuilder {
    const withCount = setRaidersField(embed, joinCount);
    return updateClassField(withCount, classCounts);
}

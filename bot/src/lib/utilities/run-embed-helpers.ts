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
 * 
 * @param embed - The embed to update
 * @param classCounts - Map of class names to counts
 * @returns Updated embed
 */
export function updateClassField(embed: EmbedBuilder, classCounts: Record<string, number>): EmbedBuilder {
    const data = embed.toJSON();
    let fields = [...(data.fields ?? [])];

    // Filter out non-zero classes and format
    const entries = Object.entries(classCounts)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)); // Sort alphabetically

    let classText: string;
    if (entries.length === 0) {
        classText = 'None selected';
    } else if (entries.length <= 6) {
        // For 6 or fewer classes, show on one line
        classText = entries.map(([cls, count]) => `${cls} (${count})`).join(', ');
    } else {
        // For more than 6 classes, format in columns (3 per line)
        const formatted = entries.map(([cls, count]) => `${cls} (${count})`);
        const lines: string[] = [];
        for (let i = 0; i < formatted.length; i += 3) {
            const chunk = formatted.slice(i, i + 3);
            lines.push(chunk.join(' • '));
        }
        classText = lines.join('\n');
    }

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: classText };
    } else {
        // Insert after Raiders field
        const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
        if (raidersIdx >= 0) {
            fields.splice(raidersIdx + 1, 0, { name: 'Classes', value: classText, inline: false });
        } else {
            fields.push({ name: 'Classes', value: classText, inline: false });
        }
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

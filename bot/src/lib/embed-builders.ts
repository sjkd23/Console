/**
 * Shared embed-building utilities for run panels and headcount panels.
 * Extracted from run.ts to avoid duplication.
 */

import { EmbedBuilder } from 'discord.js';
import type { DungeonInfo } from '../constants/dungeon-types.js';

/**
 * Creates a base embed for a dungeon with common formatting.
 * Applies color, thumbnail, and basic dungeon info.
 */
export function createDungeonEmbed(dungeon: DungeonInfo): EmbedBuilder {
    const embed = new EmbedBuilder();

    // Color & thumbnail
    if (dungeon.dungeonColors?.length) {
        embed.setColor(dungeon.dungeonColors[0]);
    }
    if (dungeon.portalLink?.url) {
        embed.setThumbnail(dungeon.portalLink.url);
    }

    return embed;
}

/**
 * Updates or adds a field in an embed by name (case-insensitive).
 * If the field exists, updates its value; otherwise, adds it.
 */
export function setEmbedField(
    embed: EmbedBuilder,
    fieldName: string,
    value: string,
    inline = false
): EmbedBuilder {
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === fieldName.toLowerCase());
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value, inline };
    } else {
        fields.push({ name: fieldName, value, inline });
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

/**
 * Updates the "Raiders" field in an embed to reflect the current count.
 */
export function setRaidersField(embed: EmbedBuilder, count: number): EmbedBuilder {
    return setEmbedField(embed, 'Raiders', String(count), false);
}

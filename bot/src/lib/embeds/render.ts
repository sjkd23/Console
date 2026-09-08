import type { APIEmbed } from 'discord.js';
import { EmbedConfigSchema, type EmbedConfig } from './contract.js';

/** No session metadata or dynamic timestamps: publication equals the current preview. */
export function renderEmbed(config: EmbedConfig): APIEmbed {
    const parsed = EmbedConfigSchema.parse(config);
    const { fields, ...rest } = parsed;
    return fields.length ? { ...rest, fields } : rest;
}

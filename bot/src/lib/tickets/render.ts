import type { APIEmbed } from 'discord.js';
import { EmbedConfigSchema, type EmbedConfig } from '../embeds/contract.js';

export const TRANSCRIPT_NOTICE = 'Ticket conversations are logged for transcript purposes.';

/** Enforce disclosure on a parsed copy, never on the administrator's saved config. */
export function renderTicketEmbed(config: EmbedConfig): APIEmbed {
    // Ignore the entire legacy footer, including its icon, before validating final limits.
    const parsed = EmbedConfigSchema.parse({ ...config, footer: { text: TRANSCRIPT_NOTICE } });
    const { fields, ...rest } = parsed;
    return fields.length ? { ...rest, fields } : rest;
}

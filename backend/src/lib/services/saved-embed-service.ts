import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { EmbedConfigSchema, EmbedNameSchema, SavedEmbedSchema, SnowflakeSchema, PublicationSchema, type EmbedPublication, type EmbedConfig, type SavedEmbed } from '../embeds/contract.js';

const RowSchema = SavedEmbedSchema.extend({ created_at: z.date(), updated_at: z.date() });
function mapRow(row: unknown): SavedEmbed {
    const parsed = RowSchema.parse(row);
    return { ...parsed, created_at: parsed.created_at.toISOString(), updated_at: parsed.updated_at.toISOString() };
}
export async function getSavedEmbed(guildId: string, id: string): Promise<SavedEmbed | null> {
    const result = await query<Record<string, unknown>>('SELECT * FROM saved_embed WHERE guild_id = $1 AND id = $2', [SnowflakeSchema.parse(guildId), z.string().uuid().parse(id)]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}
export async function listSavedEmbeds(guildId: string, search = '', page = 0) {
    const result = await query<Record<string, unknown>>(`SELECT * FROM saved_embed WHERE guild_id = $1 AND starts_with(normalized_name, $2)
        ORDER BY normalized_name, id LIMIT 26 OFFSET $3`,
    [SnowflakeSchema.parse(guildId), z.string().max(64).parse(search).trim().toLowerCase(), z.number().int().min(0).max(100000).parse(page) * 25]);
    return { embeds: result.rows.slice(0, 25).map(row => {
        const { config: _config, ...metadata } = mapRow(row);
        return metadata;
    }), has_more: result.rows.length > 25 };
}
export async function createSavedEmbed(guildId: string, name: string, config: EmbedConfig, actorId: string): Promise<SavedEmbed | null> {
    const result = await query<Record<string, unknown>>(`INSERT INTO saved_embed (id, guild_id, name, config, created_by) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (guild_id, normalized_name) DO NOTHING RETURNING *`,
    [randomUUID(), SnowflakeSchema.parse(guildId), EmbedNameSchema.parse(name), JSON.stringify(EmbedConfigSchema.parse(config)), SnowflakeSchema.parse(actorId)], { redactParams: true });
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}
export async function updateSavedEmbed(guildId: string, id: string, config: EmbedConfig, revision: number): Promise<SavedEmbed | null> {
    const result = await query<Record<string, unknown>>(`UPDATE saved_embed SET config = $3, updated_at = now(), revision = revision + 1
        WHERE guild_id = $1 AND id = $2 AND revision = $4 RETURNING *`,
    [SnowflakeSchema.parse(guildId), z.string().uuid().parse(id), JSON.stringify(EmbedConfigSchema.parse(config)), z.number().int().positive().parse(revision)], { redactParams: true });
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}
export async function deleteSavedEmbed(guildId: string, id: string, revision: number): Promise<boolean> {
    const result = await query<Record<string, unknown>>('DELETE FROM saved_embed WHERE guild_id = $1 AND id = $2 AND revision = $3 RETURNING id',
        [SnowflakeSchema.parse(guildId), z.string().uuid().parse(id), z.number().int().positive().parse(revision)]);
    return result.rows.length === 1;
}

/** Revision gate before a management workflow touches Discord. No template content changes. */
export async function claimSavedEmbed(guildId: string, id: string, revision: number): Promise<SavedEmbed | null> {
    const result = await query<Record<string, unknown>>(`UPDATE saved_embed SET revision = revision + 1
        WHERE guild_id = $1 AND id = $2 AND revision = $3 RETURNING *`,
    [SnowflakeSchema.parse(guildId), z.string().uuid().parse(id), z.number().int().positive().parse(revision)]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function setEmbedPublication(guildId: string, id: string, revision: number, publication: EmbedPublication | null): Promise<SavedEmbed | null> {
    const parsed = PublicationSchema.nullable().parse(publication);
    if (parsed && parsed.guild_id !== guildId) throw new Error('Publication must belong to the saved embed guild.');
    const result = await query<Record<string, unknown>>(`UPDATE saved_embed
        SET published_channel_id = $4, published_message_id = $5, revision = revision + 1, updated_at = now()
        WHERE guild_id = $1 AND id = $2 AND revision = $3 RETURNING *`,
    [SnowflakeSchema.parse(guildId), z.string().uuid().parse(id), z.number().int().positive().parse(revision), parsed?.channel_id ?? null, parsed?.message_id ?? null]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}

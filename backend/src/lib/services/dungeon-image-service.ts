import { query } from '../../db/pool.js';
import type { DungeonImageContentType } from '../images/dungeon-image.js';

export interface StoredDungeonImage {
    guildId: string;
    dungeonKey: string;
    data: Buffer;
    contentType: DungeonImageContentType;
    filename: string;
    updatedAt: string;
}

interface DungeonImageRow {
    guild_id: string;
    dungeon_key: string;
    image_data: Buffer;
    content_type: DungeonImageContentType;
    filename: string;
    updated_at: Date;
}

function mapDungeonImage(row: DungeonImageRow): StoredDungeonImage {
    return {
        guildId: row.guild_id,
        dungeonKey: row.dungeon_key,
        data: row.image_data,
        contentType: row.content_type,
        filename: row.filename,
        updatedAt: row.updated_at.toISOString(),
    };
}

export async function getDungeonImage(guildId: string, dungeonKey: string): Promise<StoredDungeonImage | null> {
    const result = await query<DungeonImageRow>(
        `SELECT guild_id, dungeon_key, image_data, content_type, filename, updated_at
         FROM dungeon_raid_image
         WHERE guild_id = $1::bigint AND dungeon_key = $2`,
        [guildId, dungeonKey]
    );
    return result.rows[0] ? mapDungeonImage(result.rows[0]) : null;
}

export async function setDungeonImage(options: {
    guildId: string;
    dungeonKey: string;
    data: Buffer;
    contentType: DungeonImageContentType;
    filename: string;
}): Promise<StoredDungeonImage> {
    const result = await query<DungeonImageRow>(
        `INSERT INTO dungeon_raid_image (
             guild_id, dungeon_key, image_data, content_type, filename, updated_at
         ) VALUES ($1::bigint, $2, $3, $4, $5, NOW())
         ON CONFLICT (guild_id, dungeon_key) DO UPDATE SET
             image_data = EXCLUDED.image_data,
             content_type = EXCLUDED.content_type,
             filename = EXCLUDED.filename,
             updated_at = NOW()
         RETURNING guild_id, dungeon_key, image_data, content_type, filename, updated_at`,
        [options.guildId, options.dungeonKey, options.data, options.contentType, options.filename]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Dungeon image upsert did not return a record.');
    return mapDungeonImage(row);
}

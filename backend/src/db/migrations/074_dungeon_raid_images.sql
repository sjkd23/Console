-- Store one durable raid image per guild and canonical dungeon.
CREATE TABLE dungeon_raid_image (
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    dungeon_key TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    content_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dungeon_raid_image_pk PRIMARY KEY (guild_id, dungeon_key),
    CONSTRAINT dungeon_raid_image_content_type_check
        CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    CONSTRAINT dungeon_raid_image_size_check
        CHECK (octet_length(image_data) BETWEEN 1 AND 8388608),
    CONSTRAINT dungeon_raid_image_filename_check
        CHECK (char_length(filename) BETWEEN 1 AND 255)
);

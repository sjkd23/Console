-- Stable IDs allow later features to reference (guild_id, id) with ON DELETE RESTRICT.
CREATE TABLE saved_embed (
    id UUID PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED,
    config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    created_by BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CONSTRAINT saved_embed_name_check CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT saved_embed_guild_name_unique UNIQUE (guild_id, normalized_name),
    CONSTRAINT saved_embed_guild_id_unique UNIQUE (guild_id, id)
);

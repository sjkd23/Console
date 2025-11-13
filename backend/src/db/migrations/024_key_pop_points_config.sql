-- 024_key_pop_points_config.sql
-- Purpose: Add guild-wide key pop points configuration system
-- This allows admins to configure how many points raiders earn for popping keys for each dungeon

BEGIN;

-- Per-dungeon key pop points configuration for raiders (guild-wide)
-- If no override exists for a dungeon, key pops earn 0 points by default (points system is opt-in)
CREATE TABLE IF NOT EXISTS key_pop_points_config (
    guild_id BIGINT NOT NULL,
    dungeon_key TEXT NOT NULL, -- e.g., 'FUNGAL_CAVERN', 'SHATTERS', etc.
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT key_pop_points_config_pk PRIMARY KEY (guild_id, dungeon_key)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_key_pop_points_config_guild ON key_pop_points_config(guild_id);

COMMIT;

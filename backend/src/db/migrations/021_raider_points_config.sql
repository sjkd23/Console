-- 021_raider_points_config.sql
-- Purpose: Add guild-wide raider points configuration system
-- This allows admins to configure how many points raiders earn for completing/joining dungeons

BEGIN;

-- Per-dungeon points configuration for raiders (guild-wide)
-- This is separate from quota_dungeon_override which is per-role for organizers
-- If no override exists for a dungeon, raiders earn 0 points by default (points system is opt-in)
CREATE TABLE IF NOT EXISTS raider_points_config (
    guild_id BIGINT NOT NULL,
    dungeon_key TEXT NOT NULL, -- e.g., 'FUNGAL_CAVERN', 'SHATTERS', etc.
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT raider_points_config_pk PRIMARY KEY (guild_id, dungeon_key)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_raider_points_config_guild ON raider_points_config(guild_id);

COMMIT;

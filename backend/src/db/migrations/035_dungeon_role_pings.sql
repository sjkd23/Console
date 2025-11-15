-- 035_dungeon_role_pings.sql
-- Purpose: Add dungeon-specific role ping configuration system
-- This allows moderators to configure which roles should be pinged when creating runs/headcounts for specific dungeons

BEGIN;

-- Per-dungeon role ping configuration (guild-wide)
-- Maps a guild + dungeon to a Discord role ID that should be pinged when runs/headcounts are created
CREATE TABLE IF NOT EXISTS dungeon_role_ping (
    guild_id BIGINT NOT NULL,
    dungeon_key TEXT NOT NULL, -- e.g., 'FUNGAL_CAVERN', 'SHATTERS', etc.
    discord_role_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT dungeon_role_ping_pk PRIMARY KEY (guild_id, dungeon_key)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_dungeon_role_ping_guild ON dungeon_role_ping(guild_id);

COMMIT;

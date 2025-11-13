-- Migration: Track keys popped per dungeon by each user
-- Purpose: Record statistics for how many keys each user has popped for each dungeon type

CREATE TABLE IF NOT EXISTS key_pop (
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    dungeon_key TEXT NOT NULL, -- e.g., "SHATTERS", "FUNGAL_CAVERN", "ORYX_3"
    key_type TEXT NOT NULL, -- e.g., "SHATTERS_KEY", "SHIELD_RUNE", "WC_INC"
    count INTEGER NOT NULL DEFAULT 0,
    last_popped_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (guild_id, user_id, dungeon_key, key_type)
);

CREATE INDEX IF NOT EXISTS idx_key_pop_guild_user ON key_pop(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_key_pop_dungeon ON key_pop(guild_id, dungeon_key);

-- Add comment for clarity
COMMENT ON TABLE key_pop IS 'Tracks the number of keys each user has popped for each dungeon type across all runs';
COMMENT ON COLUMN key_pop.count IS 'Total number of times this user has popped this key type for this dungeon';

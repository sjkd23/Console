-- 043_add_alt_ign.sql
-- Purpose: Add alt_ign column to raider table for alt account support

BEGIN;

-- Add alt_ign column to store alternate ROTMG in-game name
ALTER TABLE raider
  ADD COLUMN IF NOT EXISTS alt_ign TEXT;

-- Add index for alt_ign lookups (similar to ign)
CREATE INDEX IF NOT EXISTS idx_raider_alt_ign ON raider(guild_id, LOWER(alt_ign));

COMMIT;

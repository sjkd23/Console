-- 056_quota_role_id.sql
-- Purpose: Add quota_role_id column to quota_event for role-specific quota tracking
-- This fixes cross-panel contamination by attributing each quota event to exactly one role

BEGIN;

-- Add nullable quota_role_id column
-- NULL values represent legacy events created before this column existed
-- These will be excluded from quota panels but remain in global leaderboards
ALTER TABLE quota_event
ADD COLUMN IF NOT EXISTS quota_role_id BIGINT NULL;

-- Add indexes for efficient quota panel queries
-- Panel queries filter by: guild_id + quota_role_id + current role holders + timeframe
CREATE INDEX IF NOT EXISTS idx_quota_event_quota_role 
ON quota_event(guild_id, quota_role_id, actor_user_id, created_at)
WHERE quota_role_id IS NOT NULL;

-- Keep existing index for global leaderboard queries (no quota_role_id filter)
-- idx_quota_event_quota_points already exists from migration 020

-- Add comment for documentation
COMMENT ON COLUMN quota_event.quota_role_id IS 
'Discord role ID that awarded these quota points. NULL for legacy events before role tracking. Panel queries filter by this column.';

COMMIT;

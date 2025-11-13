-- 020_separate_points_quota_points.sql
-- Purpose: Separate "points" (for raiders) from "quota_points" (for organizers/verifiers)
-- Points: For raiders completing/joining runs (to be implemented later)
-- Quota Points: For organizers organizing runs and verifiers verifying members

BEGIN;

-- Add quota_points column to quota_event table
-- This will track organizer/verifier points separately from regular raider points
ALTER TABLE quota_event
ADD COLUMN IF NOT EXISTS quota_points INTEGER NOT NULL DEFAULT 0;

-- Migrate existing points to quota_points for run_completed and verify_member actions
-- These actions currently represent organizer/verifier work, not raider participation
UPDATE quota_event
SET quota_points = points
WHERE action_type IN ('run_completed', 'verify_member');

-- Reset regular points to 0 for existing quota events
-- In the future, regular points will track raider participation
UPDATE quota_event
SET points = 0
WHERE action_type IN ('run_completed', 'verify_member');

-- Add index for efficient querying on quota_points
CREATE INDEX IF NOT EXISTS idx_quota_event_quota_points ON quota_event(guild_id, actor_user_id, quota_points);

COMMIT;

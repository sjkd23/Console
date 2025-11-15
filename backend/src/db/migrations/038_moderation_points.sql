-- 038_moderation_points.sql
-- Purpose: Add moderation_points column to quota_role_config to configure points earned for verification activities

BEGIN;

-- Add moderation_points column to quota_role_config
-- Default 0 means verification activities won't count toward quota by default
ALTER TABLE quota_role_config
    ADD COLUMN IF NOT EXISTS moderation_points DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (moderation_points >= 0);

-- Add comment explaining the column
COMMENT ON COLUMN quota_role_config.moderation_points IS 'Points awarded for verification activities (running /verify command or approving manual verification tickets)';

COMMIT;

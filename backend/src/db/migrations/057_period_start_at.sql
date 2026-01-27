-- 057_period_start_at.sql
-- Purpose: Rename created_at to period_start_at for clarity and allow custom quota period start dates

BEGIN;

-- Rename created_at to period_start_at for better clarity
-- This allows admins to set custom start dates for quota periods (past or future)
ALTER TABLE quota_role_config
    RENAME COLUMN created_at TO period_start_at;

-- Update column comment
COMMENT ON COLUMN quota_role_config.period_start_at IS 
    'Start of the quota period. Can be set to past or future dates. Points are counted between period_start_at and reset_at.';

COMMIT;

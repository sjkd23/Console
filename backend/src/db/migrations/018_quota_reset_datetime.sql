-- 018_quota_reset_datetime.sql
-- Purpose: Migrate quota_role_config from weekly recurring schedule to absolute datetime

BEGIN;

-- Drop the check constraints that are no longer needed
ALTER TABLE quota_role_config
    DROP CONSTRAINT IF EXISTS quota_role_config_reset_day_check,
    DROP CONSTRAINT IF EXISTS quota_role_config_reset_hour_check,
    DROP CONSTRAINT IF EXISTS quota_role_config_reset_minute_check;

-- Add the new reset_at column (nullable for now)
ALTER TABLE quota_role_config
    ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;

-- Migrate existing data: convert reset_day/hour/minute to absolute datetime
-- For simplicity, set reset_at to 7 days from now for all existing configs
UPDATE quota_role_config
SET reset_at = NOW() + INTERVAL '7 days'
WHERE reset_at IS NULL;

-- Make reset_at NOT NULL with default
ALTER TABLE quota_role_config
    ALTER COLUMN reset_at SET NOT NULL,
    ALTER COLUMN reset_at SET DEFAULT NOW();

-- Drop the old columns (only if they exist)
ALTER TABLE quota_role_config
    DROP COLUMN IF EXISTS reset_day,
    DROP COLUMN IF EXISTS reset_hour,
    DROP COLUMN IF EXISTS reset_minute;

COMMIT;

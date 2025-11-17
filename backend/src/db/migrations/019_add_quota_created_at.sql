-- 019_add_quota_created_at.sql
-- Purpose: Add created_at field to quota_role_config to track when quota periods actually start

BEGIN;

-- Add created_at column with default of current time
ALTER TABLE quota_role_config
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- For existing rows, set created_at to be the same as updated_at initially
-- (This is the best approximation we have)
UPDATE quota_role_config
SET created_at = updated_at
WHERE created_at IS NULL OR created_at = updated_at;

COMMIT;

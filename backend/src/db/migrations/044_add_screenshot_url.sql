-- 044_add_screenshot_url.sql
-- Purpose: Add screenshot_url column to run table for Oryx 3 completion screenshots
BEGIN;

-- Add screenshot_url column to run table (nullable - only required for Oryx 3 runs)
ALTER TABLE run ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

-- Add index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_run_screenshot ON run(screenshot_url) WHERE screenshot_url IS NOT NULL;

COMMIT;

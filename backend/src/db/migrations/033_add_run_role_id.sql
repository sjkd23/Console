-- Add role_id column to run table to store the temporary Discord role
ALTER TABLE run
ADD COLUMN IF NOT EXISTS role_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_run_role ON run(role_id);

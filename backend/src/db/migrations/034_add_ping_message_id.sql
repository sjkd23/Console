-- Add ping_message_id column to run table to store the latest ping message
ALTER TABLE run
ADD COLUMN IF NOT EXISTS ping_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_run_ping_message ON run(ping_message_id);

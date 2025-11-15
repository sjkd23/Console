-- 036_key_pop_completion_tracking.sql
-- Purpose: Track key pops and award completions based on participation during key pops
-- This enables completion rewards only for raiders who were present during a key pop

BEGIN;

-- Add key_pop_count to run table to track number of key pops
ALTER TABLE run ADD COLUMN IF NOT EXISTS key_pop_count INTEGER NOT NULL DEFAULT 0;

-- Create key_pop_snapshot table to record which raiders were joined at each key pop
-- This allows us to award completions to raiders who were present during a key pop
CREATE TABLE IF NOT EXISTS key_pop_snapshot (
    run_id BIGINT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    key_pop_number INTEGER NOT NULL CHECK (key_pop_number > 0),
    user_id BIGINT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    class TEXT, -- optional class the raider had at snapshot time
    snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    awarded_completion BOOLEAN NOT NULL DEFAULT FALSE,
    awarded_at TIMESTAMPTZ, -- when completion was awarded
    PRIMARY KEY (run_id, key_pop_number, user_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_key_pop_snapshot_run ON key_pop_snapshot(run_id);
CREATE INDEX IF NOT EXISTS idx_key_pop_snapshot_user ON key_pop_snapshot(user_id);
CREATE INDEX IF NOT EXISTS idx_key_pop_snapshot_awarded ON key_pop_snapshot(run_id, awarded_completion);

-- Comments for clarity
COMMENT ON TABLE key_pop_snapshot IS 'Snapshots of raiders present at each key pop. Used to determine who gets completion credit.';
COMMENT ON COLUMN run.key_pop_count IS 'Number of times the organizer has pressed "Key popped" button for this run';
COMMENT ON COLUMN key_pop_snapshot.key_pop_number IS 'Which key pop this snapshot is for (1 = first key pop, 2 = second, etc.)';
COMMENT ON COLUMN key_pop_snapshot.awarded_completion IS 'Whether this raider has been awarded completion points for this key pop';

COMMIT;

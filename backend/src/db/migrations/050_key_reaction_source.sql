-- Migration: Add source tracking for key reactions
-- Purpose: Distinguish between keys from headcount phase vs run phase
-- This allows showing headcount keys separately in organizer panel

-- Add source column to track where the key reaction came from
ALTER TABLE key_reaction 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'run' CHECK (source IN ('headcount', 'run'));

-- Set all existing key reactions to 'run' source (default behavior)
-- Future headcount conversions will explicitly set 'headcount' source
UPDATE key_reaction SET source = 'run' WHERE source IS NULL;

-- Drop the old primary key constraint (check actual constraint name from \d key_reaction)
ALTER TABLE key_reaction DROP CONSTRAINT key_reaction_pkey;

-- Add new primary key that includes source, allowing users to have both headcount and raid keys
ALTER TABLE key_reaction ADD CONSTRAINT key_reaction_pkey PRIMARY KEY (run_id, user_id, key_type, source);

-- Add index for efficient filtering by source
CREATE INDEX IF NOT EXISTS idx_key_reaction_source ON key_reaction(run_id, source);

-- Note: Users can now have BOTH a headcount key AND a raid key of the same type.
-- The primary key prevents duplicate entries within the same source.
-- When converting headcount to run, the bulk import will use 'headcount' source.
-- When users click key buttons during the run, they will use 'run' source.

-- 037_chain_tracking.sql
-- Purpose: Add chain tracking to runs (e.g., "Chain 3/5" for dungeon chains)
-- Allows organizers to set a chain amount and track progress via key_pop_count

BEGIN;

-- Add chain_amount to run table (nullable - only set if organizer wants chain tracking)
ALTER TABLE run ADD COLUMN IF NOT EXISTS chain_amount INTEGER CHECK (chain_amount > 0);

-- Comment for clarity
COMMENT ON COLUMN run.chain_amount IS 'Total number of dungeons in the chain (e.g., 5 for a 5-chain). Shows as "Chain X/Y" where X=key_pop_count';

COMMIT;

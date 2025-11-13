-- Migration: Add key reactions tracking
-- Purpose: Track which keys users have for each run
-- Keys like Shield Rune, Sword Rune, Helm Rune, WC Inc, Shatters Key, etc.

CREATE TABLE IF NOT EXISTS key_reaction (
    run_id BIGINT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    key_type TEXT NOT NULL, -- e.g., "SHIELD_RUNE", "SWORD_RUNE", "SHATTERS_KEY", etc.
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (run_id, user_id, key_type)
);

CREATE INDEX IF NOT EXISTS idx_key_reaction_run ON key_reaction(run_id);
CREATE INDEX IF NOT EXISTS idx_key_reaction_key_type ON key_reaction(run_id, key_type);

-- 025_notes.sql
-- Purpose: Add note system for staff to add silent warnings/notes on users

BEGIN;

-- Create notes table
CREATE TABLE IF NOT EXISTS note (
    id TEXT PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    moderator_id BIGINT NOT NULL,
    note_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_note_guild_user ON note(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_note_guild ON note(guild_id);
CREATE INDEX IF NOT EXISTS idx_note_user ON note(user_id);
CREATE INDEX IF NOT EXISTS idx_note_created_at ON note(created_at DESC);

COMMIT;

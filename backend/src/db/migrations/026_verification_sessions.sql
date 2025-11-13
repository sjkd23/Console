-- 026_verification_sessions.sql
-- Purpose: Add RealmEye verification flow with DM-based sessions

BEGIN;

-- Verification sessions track the state of RealmEye verification flow per user per guild
-- Used for the DM-based verification where users:
-- 1. Click "Get Verified" button in the get-verified channel
-- 2. Receive DM asking for their ROTMG IGN
-- 3. Get a verification code to add to their RealmEye description
-- 4. Click "Done" in DM to verify the code is present
-- 5. Bot grants verified_raider role + sets nickname = IGN
CREATE TABLE IF NOT EXISTS verification_session (
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    rotmg_ign TEXT,
    verification_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending_ign' CHECK (
        status IN (
            'pending_ign',              -- Waiting for user to provide IGN
            'pending_realmeye',         -- Waiting for user to add code to RealmEye
            'verified',                 -- Successfully verified
            'cancelled',                -- User cancelled the flow
            'expired'                   -- Session expired (timeout)
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'), -- 1 hour timeout
    PRIMARY KEY (guild_id, user_id)
);

-- Index for cleanup of expired sessions
CREATE INDEX IF NOT EXISTS idx_verification_session_expires ON verification_session(expires_at);

-- Track verification panel messages in get-verified channels
-- This allows /configverification to update/replace the panel
ALTER TABLE guild_channel
  ADD COLUMN IF NOT EXISTS panel_message_id BIGINT;

-- Add comment for clarity
COMMENT ON COLUMN guild_channel.panel_message_id IS 'Message ID of the verification panel (for getverified channel) or other config panels';

COMMIT;

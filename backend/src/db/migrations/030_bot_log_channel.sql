-- 030_bot_log_channel.sql
-- Purpose: Add bot_log channel for general bot command logging

BEGIN;

-- Add bot_log to channel catalog
INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('bot_log', 'Bot Log', 'General bot activity and command execution logs')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

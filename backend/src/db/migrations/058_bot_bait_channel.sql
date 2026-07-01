-- 058_bot_bait_channel.sql
-- Purpose: Add bot_bait channel to the channel_catalog for automatic soft-banning

BEGIN;

INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('bot_bait', 'Bot-Bait', 'Any user (non-admin/mod) who sends a message here is automatically soft-banned')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

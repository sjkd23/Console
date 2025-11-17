-- 045_role_ping_channel.sql
-- Purpose: Add role_ping channel for role ping panel embed

BEGIN;

-- Add role_ping channel to the catalog
INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('role_ping', 'Role Ping', 'Channel for the role ping panel where users can self-assign dungeon ping roles')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

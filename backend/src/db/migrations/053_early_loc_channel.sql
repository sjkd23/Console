-- 053_early_loc_channel.sql
-- Purpose: Add early_loc channel for party/location notifications

BEGIN;

-- Add early_loc channel to the catalog
INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('early_loc', 'Early Loc', 'Priority/staff channel for location/party notifications when set or updated')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

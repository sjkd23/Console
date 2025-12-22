-- 052_party_finder_channel.sql
-- Purpose: Add party_finder channel for party organization system

BEGIN;

-- Add party_finder channel to the catalog
INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('party_finder', 'Party Finder', 'Channel where verified raiders can organize their own parties')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

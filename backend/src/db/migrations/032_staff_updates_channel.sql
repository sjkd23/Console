-- Migration: Add staff_updates channel to channel_catalog
-- This channel is used for staff promotion announcements

INSERT INTO channel_catalog (channel_key, label, description)
VALUES ('staff_updates', 'Staff Updates', 'Channel for staff promotion announcements and updates')
ON CONFLICT (channel_key) DO NOTHING;

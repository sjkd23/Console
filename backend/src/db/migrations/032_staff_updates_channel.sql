-- Migration: Add staff_updates channel to channel_catalog
-- This channel is used for staff promotion announcements

INSERT INTO channel_catalog (key, description)
VALUES ('staff_updates', 'Channel for staff promotion announcements and updates');

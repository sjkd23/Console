-- Migration: Add O3 progression stage tracking
-- Purpose: Track Oryx 3 progression stages (null -> 'closed' -> 'miniboss' -> 'third_room')
-- This allows the organizer panel to show the appropriate progression buttons

ALTER TABLE run ADD COLUMN IF NOT EXISTS o3_stage TEXT CHECK (o3_stage IN ('closed', 'miniboss', 'third_room'));

COMMENT ON COLUMN run.o3_stage IS 'Oryx 3 progression stage: null (initial), closed (realm closed), miniboss (miniboss selected), third_room (third room announced)';

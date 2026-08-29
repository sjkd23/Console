-- 063_dungeon_activity_live_sources.sql
-- Phase B: identify no-key-pop participant fallback activity explicitly.

BEGIN;

ALTER TABLE dungeon_activity_event
    DROP CONSTRAINT dungeon_activity_event_source_check;

ALTER TABLE dungeon_activity_event
    ADD CONSTRAINT dungeon_activity_event_source_check
    CHECK (source IN (
        'historical_quota_event',
        'historical_run',
        'historical_snapshot',
        'key_pop',
        'o3_end',
        'participant_fallback',
        'manual_log'
    ));

COMMIT;

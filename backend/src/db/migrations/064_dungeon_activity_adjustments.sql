-- 064_dungeon_activity_adjustments.sql
-- Phase C: append-only corrections and indexes for canonical activity readers.

BEGIN;

CREATE TABLE IF NOT EXISTS dungeon_activity_adjustment (
    id BIGSERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL,
    dungeon_stats_key TEXT NOT NULL,
    delta INTEGER NOT NULL,
    subject_id TEXT NOT NULL,
    related_activity_subject_id TEXT,
    source TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT dungeon_activity_adjustment_role_check
        CHECK (role IN ('organizer', 'raider')),
    CONSTRAINT dungeon_activity_adjustment_source_check
        CHECK (source IN ('historical_manual_log', 'manual_log')),
    CONSTRAINT dungeon_activity_adjustment_delta_check CHECK (delta <> 0),
    CONSTRAINT dungeon_activity_adjustment_guild_id_check CHECK (guild_id > 0),
    CONSTRAINT dungeon_activity_adjustment_user_id_check CHECK (user_id > 0),
    CONSTRAINT dungeon_activity_adjustment_stats_key_check
        CHECK (dungeon_stats_key = BTRIM(dungeon_stats_key) AND dungeon_stats_key <> ''),
    CONSTRAINT dungeon_activity_adjustment_subject_id_check
        CHECK (subject_id = BTRIM(subject_id) AND subject_id <> ''),
    CONSTRAINT dungeon_activity_adjustment_subject_unique UNIQUE (guild_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_dungeon_activity_adjustment_stats
    ON dungeon_activity_adjustment(guild_id, user_id, role, dungeon_stats_key);

-- Covers all-time and date-filtered activity leaderboards. The existing
-- guild/user index remains the preferred /stats path.
CREATE INDEX IF NOT EXISTS idx_dungeon_activity_event_leaderboard
    ON dungeon_activity_event(guild_id, role, dungeon_stats_key, user_id, occurred_at)
    INCLUDE (count);

CREATE INDEX IF NOT EXISTS idx_dungeon_activity_adjustment_leaderboard
    ON dungeon_activity_adjustment(guild_id, role, dungeon_stats_key, user_id, occurred_at)
    INCLUDE (delta);

COMMENT ON TABLE dungeon_activity_adjustment IS
    'Append-only administrative corrections to reported dungeon activity; never an activity fact or points currency.';
COMMENT ON COLUMN dungeon_activity_adjustment.delta IS
    'Signed correction applied by the canonical stats projection. Zero is forbidden.';
COMMENT ON COLUMN dungeon_activity_adjustment.related_activity_subject_id IS
    'Optional canonical activity identity that motivated this correction; informational, not a mutable foreign key.';

COMMIT;

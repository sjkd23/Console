-- 062_dungeon_activity_events.sql
-- Phase A: independent, append-only dungeon activity ledger.
-- Historical data is populated by the controlled application-side backfill command;
-- this schema migration intentionally performs no unbounded data rewrite.

BEGIN;

CREATE TABLE IF NOT EXISTS dungeon_activity_event (
    id BIGSERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    run_id BIGINT REFERENCES run(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    dungeon_stats_key TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    source TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT dungeon_activity_event_role_check
        CHECK (role IN ('organizer', 'raider')),
    CONSTRAINT dungeon_activity_event_source_check
        CHECK (source IN (
            'historical_quota_event',
            'historical_run',
            'historical_snapshot',
            'key_pop',
            'o3_end',
            'manual_log'
        )),
    CONSTRAINT dungeon_activity_event_count_check CHECK (count > 0),
    CONSTRAINT dungeon_activity_event_guild_id_check CHECK (guild_id > 0),
    CONSTRAINT dungeon_activity_event_user_id_check CHECK (user_id > 0),
    CONSTRAINT dungeon_activity_event_stats_key_check
        CHECK (dungeon_stats_key = BTRIM(dungeon_stats_key) AND dungeon_stats_key <> ''),
    CONSTRAINT dungeon_activity_event_subject_id_check
        CHECK (subject_id = BTRIM(subject_id) AND subject_id <> ''),
    CONSTRAINT dungeon_activity_event_subject_unique UNIQUE (guild_id, subject_id)
);

-- Supports the future /stats access pattern with one non-redundant prefix index:
-- guild/user, optional role, then per-dungeon aggregation.
CREATE INDEX IF NOT EXISTS idx_dungeon_activity_event_stats
    ON dungeon_activity_event(guild_id, user_id, role, dungeon_stats_key);

-- Operational traceability without retaining the operational run itself.
CREATE INDEX IF NOT EXISTS idx_dungeon_activity_event_run
    ON dungeon_activity_event(run_id)
    WHERE run_id IS NOT NULL;

COMMENT ON TABLE dungeon_activity_event IS
    'Append-only facts that a user organized or completed dungeon activity; never quota currency.';
COMMENT ON COLUMN dungeon_activity_event.guild_id IS
    'Durable Discord guild snowflake. Intentionally not an FK so guild cleanup cannot erase history.';
COMMENT ON COLUMN dungeon_activity_event.user_id IS
    'Durable Discord user snowflake. Intentionally not an FK so member cleanup cannot erase history.';
COMMENT ON COLUMN dungeon_activity_event.run_id IS
    'Optional operational run reference; ON DELETE SET NULL preserves historical activity.';
COMMENT ON COLUMN dungeon_activity_event.dungeon_stats_key IS
    'Statistics bucket key; deliberately not an FK to a selectable physical dungeon.';
COMMENT ON COLUMN dungeon_activity_event.subject_id IS
    'Ledger-local deterministic idempotency identity, unique within a guild.';
COMMENT ON COLUMN dungeon_activity_event.occurred_at IS
    'Best trustworthy timestamp for when the historical activity happened.';

COMMIT;

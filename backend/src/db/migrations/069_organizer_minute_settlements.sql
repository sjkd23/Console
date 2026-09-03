-- Durable organizer minute logging state and exactly-once accounting action.
BEGIN;

ALTER TABLE quota_event DROP CONSTRAINT quota_event_action_type_check;
ALTER TABLE quota_event ADD CONSTRAINT quota_event_action_type_check
    CHECK (action_type IN (
        'run_completed', 'verify_member', 'manual_quota_adjustment', 'organizer_minutes'
    ));

CREATE UNIQUE INDEX idx_quota_event_organizer_minutes_idempotency
    ON quota_event(guild_id, subject_id)
    WHERE action_type = 'organizer_minutes' AND subject_id IS NOT NULL;

CREATE TABLE organizer_minute_settlement (
    run_id BIGINT PRIMARY KEY REFERENCES run(id) ON DELETE RESTRICT,
    quota_role_id BIGINT NOT NULL,
    rate NUMERIC(10, 2) NOT NULL CHECK (rate > 0),
    max_minutes BIGINT NOT NULL CHECK (max_minutes BETWEEN 1 AND 9007199254740991),
    selected_minutes BIGINT NOT NULL CHECK (selected_minutes BETWEEN 1 AND max_minutes),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    resolved_at TIMESTAMPTZ,
    quota_event_id BIGINT UNIQUE REFERENCES quota_event(id) ON DELETE RESTRICT,
    CONSTRAINT organizer_minute_settlement_state_check CHECK (
        (status = 'pending' AND resolved_at IS NULL AND quota_event_id IS NULL)
        OR (status = 'confirmed' AND resolved_at IS NOT NULL AND quota_event_id IS NOT NULL)
        OR (status = 'cancelled' AND resolved_at IS NOT NULL AND quota_event_id IS NULL)
    )
);

COMMIT;

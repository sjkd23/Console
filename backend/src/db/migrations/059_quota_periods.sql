-- 059_quota_periods.sql
-- Persist authoritative quota windows and immutable finalized member results.

BEGIN;

ALTER TABLE quota_role_config
    ADD COLUMN IF NOT EXISTS reset_interval_days INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN IF NOT EXISTS rollover_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE quota_role_config
    DROP CONSTRAINT IF EXISTS quota_role_config_reset_interval_days_check;

ALTER TABLE quota_role_config
    ADD CONSTRAINT quota_role_config_reset_interval_days_check
    CHECK (reset_interval_days BETWEEN 1 AND 365);

CREATE TABLE IF NOT EXISTS quota_period (
    id BIGSERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    quota_role_id BIGINT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    required_points NUMERIC(10, 2) NOT NULL CHECK (required_points >= 0),
    rollover_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    predecessor_period_id BIGINT REFERENCES quota_period(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finalized')),
    close_reason TEXT CHECK (close_reason IN ('scheduled', 'manual', 'config_deleted', 'role_deleted', 'deactivated')),
    roster_complete BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at TIMESTAMPTZ,
    quota_log_posted_at TIMESTAMPTZ,
    quota_log_last_attempt_at TIMESTAMPTZ,
    CONSTRAINT quota_period_valid_window CHECK (ends_at > starts_at),
    CONSTRAINT quota_period_finalized_state CHECK (
        (status = 'active' AND finalized_at IS NULL AND close_reason IS NULL)
        OR (status = 'finalized' AND finalized_at IS NOT NULL AND close_reason IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_period_one_active
    ON quota_period(guild_id, quota_role_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_period_one_successor
    ON quota_period(predecessor_period_id)
    WHERE predecessor_period_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_period_window
    ON quota_period(guild_id, quota_role_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_quota_period_due
    ON quota_period(ends_at)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_quota_period_unposted
    ON quota_period(finalized_at)
    WHERE status = 'finalized' AND quota_log_posted_at IS NULL;

CREATE TABLE IF NOT EXISTS quota_period_member_result (
    period_id BIGINT NOT NULL REFERENCES quota_period(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    earned_points NUMERIC(10, 2) NOT NULL,
    carry_in NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (carry_in >= 0),
    effective_total NUMERIC(10, 2) NOT NULL,
    met_quota BOOLEAN NOT NULL,
    carry_out NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (carry_out >= 0),
    result_source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT quota_period_member_result_pk PRIMARY KEY (period_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_quota_period_member_user
    ON quota_period_member_result(user_id, period_id);

-- Capture one transition timestamp for the entire backfill. Zero-point configs are
-- inactive and intentionally receive no period. A valid future legacy window is
-- preserved. An overdue legacy window starts at the old reset boundary but receives
-- its first automatic end one configured interval after this transition; this keeps
-- the points the old runtime exposed without inventing pre-feature weekly periods.
WITH transition AS (
    SELECT statement_timestamp() AS transitioned_at
),
eligible_config AS (
    SELECT config.*, transition.transitioned_at
    FROM quota_role_config AS config
    CROSS JOIN transition
    WHERE config.required_points > 0
),
transition_window AS (
    SELECT
        config.*,
        CASE
            WHEN config.period_start_at < config.reset_at
             AND config.reset_at > config.transitioned_at
            THEN config.period_start_at
            WHEN config.reset_at <= config.transitioned_at
            THEN config.reset_at
            ELSE config.transitioned_at
        END AS transition_starts_at,
        CASE
            WHEN config.period_start_at < config.reset_at
             AND config.reset_at > config.transitioned_at
            THEN config.reset_at
            ELSE config.transitioned_at + (config.reset_interval_days * INTERVAL '1 day')
        END AS transition_ends_at
    FROM eligible_config AS config
)
INSERT INTO quota_period (
    guild_id,
    quota_role_id,
    starts_at,
    ends_at,
    required_points,
    rollover_enabled,
    predecessor_period_id,
    status
)
SELECT
    config.guild_id,
    config.discord_role_id,
    config.transition_starts_at,
    config.transition_ends_at,
    config.required_points,
    FALSE,
    NULL,
    'active'
FROM transition_window AS config
WHERE NOT EXISTS (
    SELECT 1
    FROM quota_period AS period
    WHERE period.guild_id = config.guild_id
      AND period.quota_role_id = config.discord_role_id
      AND period.status = 'active'
);

COMMIT;

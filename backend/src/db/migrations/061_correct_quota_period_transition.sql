-- 061_correct_quota_period_transition.sql
-- Pre-production corrective reset for databases where faulty migration 059 already ran.
-- This intentionally clears only the new quota-period feature tables. It never touches
-- quota_event, quota_role_config, or other guild/member history.

BEGIN;

TRUNCATE TABLE quota_period_member_result, quota_period RESTART IDENTITY;

ALTER TABLE quota_period
    DROP CONSTRAINT IF EXISTS quota_period_close_reason_check;

-- Migration 059 originally created this as an anonymous column CHECK. PostgreSQL's
-- generated name is quota_period_close_reason_check; recreate it explicitly.
ALTER TABLE quota_period
    ADD CONSTRAINT quota_period_close_reason_check
    CHECK (close_reason IN ('scheduled', 'manual', 'config_deleted', 'role_deleted', 'deactivated'));

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
    config.rollover_enabled,
    NULL,
    'active'
FROM transition_window AS config;

COMMIT;

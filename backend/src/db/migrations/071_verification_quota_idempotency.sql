-- Exactly-once quota credit for a handled manual verification.
BEGIN;

CREATE UNIQUE INDEX idx_quota_event_verification_idempotency
    ON quota_event(guild_id, subject_id)
    WHERE action_type = 'verify_member' AND subject_id IS NOT NULL;

COMMENT ON INDEX idx_quota_event_verification_idempotency IS
    'Prevents duplicate quota credit when the same verification decision is retried.';

COMMENT ON COLUMN quota_role_config.verify_points IS
    'Points awarded for running /verify or handling a manual verification by approval or rejection.';

COMMIT;

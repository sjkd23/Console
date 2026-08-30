-- Phase E: preserve the payable basis, without creating settlements or earnings.
BEGIN;

ALTER TABLE quota_role_config
    ADD COLUMN misc_points_per_minute NUMERIC(10,2) NOT NULL DEFAULT 0.10
        CHECK (misc_points_per_minute BETWEEN 0 AND 99999999.99);

ALTER TABLE run
    ADD COLUMN organizer_minute_rate NUMERIC(10,2),
    ADD COLUMN organizer_minute_quota_role_id BIGINT,
    ADD COLUMN finalization_kind TEXT,
    ADD CONSTRAINT run_minute_snapshot_check CHECK (
        (organizer_minute_rate IS NULL AND organizer_minute_quota_role_id IS NULL)
        OR (
            run_kind IN ('realm_clearing', 'multi_non_exalt')
            AND organizer_minute_rate IS NOT NULL
            AND organizer_minute_rate BETWEEN 0 AND 99999999.99
            AND (organizer_minute_quota_role_id IS NOT NULL OR organizer_minute_rate = 0)
        )
    ),
    ADD CONSTRAINT run_finalization_kind_check CHECK (
        finalization_kind IS NULL
        OR (finalization_kind IN ('completed', 'cancelled') AND status = 'ended' AND ended_at IS NOT NULL)
    );

-- Deliberately no role/config FK, historical snapshot backfill, or outcome inference.
COMMENT ON COLUMN run.organizer_minute_rate IS
    'Rate frozen at Start. NULL means never snapshotted; zero with no role means no matching config.';
COMMENT ON COLUMN run.organizer_minute_quota_role_id IS
    'Historical Discord quota role attribution, independent of current membership/config existence.';
COMMENT ON COLUMN run.finalization_kind IS
    'First terminal outcome. Historical ended runs remain NULL.';

COMMIT;

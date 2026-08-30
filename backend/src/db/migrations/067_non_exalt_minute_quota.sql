-- Non-exalt minute compensation also covers physical single-dungeon runs.
BEGIN;

-- An existing 1 may be an intentional admin choice. Change future defaults only.
ALTER TABLE quota_role_config ALTER COLUMN base_non_exalt_points SET DEFAULT 0;

ALTER TABLE run DROP CONSTRAINT run_minute_snapshot_check;
ALTER TABLE run ADD CONSTRAINT run_minute_snapshot_check CHECK (
    (organizer_minute_rate IS NULL AND organizer_minute_quota_role_id IS NULL)
    OR (
        -- The Start service validates single-dungeon eligibility using authoritative
        -- dungeon metadata. This constraint enforces snapshot shape, not a second catalog.
        run_kind IN ('single', 'realm_clearing', 'multi_non_exalt')
        AND organizer_minute_rate IS NOT NULL
        AND organizer_minute_rate BETWEEN 0 AND 99999999.99
        AND (organizer_minute_quota_role_id IS NOT NULL OR organizer_minute_rate = 0)
    )
);

-- No historical snapshot, outcome, config value, activity, or quota-event backfill.
COMMIT;

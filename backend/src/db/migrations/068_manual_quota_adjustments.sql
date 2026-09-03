-- Give append-only manual quota corrections their own accounting identity.
BEGIN;

ALTER TABLE quota_event DROP CONSTRAINT quota_event_action_type_check;
ALTER TABLE quota_event ADD CONSTRAINT quota_event_action_type_check
    CHECK (action_type IN ('run_completed', 'verify_member', 'manual_quota_adjustment'));

COMMIT;

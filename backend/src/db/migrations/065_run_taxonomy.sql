-- 065_run_taxonomy.sql
-- Phase D: normalized physical selections plus immutable run/activity taxonomy.

BEGIN;

ALTER TABLE run
    ADD COLUMN run_kind TEXT,
    ADD COLUMN activity_key TEXT;

CREATE TABLE run_dungeon_selection (
    run_id BIGINT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    dungeon_key TEXT NOT NULL CHECK (btrim(dungeon_key) <> ''),
    dungeon_label TEXT NOT NULL CHECK (btrim(dungeon_label) <> ''),
    selection_order SMALLINT NOT NULL CHECK (selection_order BETWEEN 1 AND 5),
    CONSTRAINT run_dungeon_selection_pk PRIMARY KEY (run_id, dungeon_key),
    CONSTRAINT run_dungeon_selection_order_unique UNIQUE (run_id, selection_order)
);

INSERT INTO run_dungeon_selection (run_id, dungeon_key, dungeon_label, selection_order)
SELECT
    id,
    dungeon_key,
    CASE
        WHEN dungeon_key = 'REALM_DUNGEON' THEN 'Realm Clearing'
        ELSE COALESCE(NULLIF(btrim(dungeon_label), ''), dungeon_key)
    END,
    1
FROM run;

UPDATE run
SET run_kind = CASE
        WHEN dungeon_key = 'ORYX_3' THEN 'oryx_3'
        WHEN dungeon_key = 'REALM_DUNGEON' THEN 'realm_clearing'
        ELSE 'single'
    END,
    activity_key = CASE
        WHEN dungeon_key = 'REALM_DUNGEON' THEN 'MISC_DUNGEONS'
        ELSE dungeon_key
    END,
    dungeon_label = CASE
        WHEN dungeon_key = 'REALM_DUNGEON' THEN 'Realm Clearing'
        ELSE COALESCE(NULLIF(btrim(dungeon_label), ''), dungeon_key)
    END;

ALTER TABLE run
    ALTER COLUMN run_kind SET NOT NULL,
    ALTER COLUMN activity_key SET NOT NULL,
    ADD CONSTRAINT run_kind_allowed CHECK (
        run_kind IN ('single', 'realm_clearing', 'multi_non_exalt', 'multi_exalt', 'oryx_3')
    ),
    ADD CONSTRAINT run_activity_key_nonblank CHECK (btrim(activity_key) <> ''),
    ADD CONSTRAINT run_taxonomy_compatibility CHECK (
        (run_kind = 'oryx_3' AND dungeon_key = 'ORYX_3' AND activity_key = 'ORYX_3') OR
        (run_kind = 'realm_clearing' AND dungeon_key = 'REALM_DUNGEON' AND activity_key = 'MISC_DUNGEONS') OR
        (run_kind = 'multi_non_exalt' AND dungeon_key = 'MISC_DUNGEONS' AND activity_key = 'MISC_DUNGEONS') OR
        (run_kind = 'multi_exalt' AND dungeon_key = 'EXALTATION_DUNGEONS' AND activity_key = 'EXALTATION_DUNGEONS') OR
        (run_kind = 'single' AND activity_key = dungeon_key)
    );

CREATE INDEX idx_run_activity_key ON run(activity_key);
CREATE INDEX idx_run_dungeon_selection_key ON run_dungeon_selection(dungeon_key);

COMMIT;

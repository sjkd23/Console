-- Store one current quantity for each run/user/key/source offer.
-- Existing key reactions continue to mean one key.
ALTER TABLE key_reaction
    ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;

-- A converted headcount offer and a later run offer could previously coexist.
-- Prefer the run-phase row when consolidating those legacy duplicates.
DELETE FROM key_reaction older
USING key_reaction preferred
WHERE older.run_id = preferred.run_id
  AND older.user_id = preferred.user_id
  AND older.key_type = preferred.key_type
  AND older.source = 'headcount'
  AND preferred.source = 'run';

ALTER TABLE key_reaction DROP CONSTRAINT key_reaction_pkey;
ALTER TABLE key_reaction
    ADD CONSTRAINT key_reaction_pkey PRIMARY KEY (run_id, user_id, key_type);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'key_reaction_quantity_check'
          AND conrelid = 'key_reaction'::regclass
    ) THEN
        ALTER TABLE key_reaction
            ADD CONSTRAINT key_reaction_quantity_check
            CHECK (quantity >= 1 AND quantity <= 10);
    END IF;
END $$;

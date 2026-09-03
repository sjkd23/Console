-- Persist the direct predecessor of a chained Oryx 3 run.
-- The partial unique index is the durable idempotency boundary: one ended O3
-- can create at most one direct successor through the chaining action.
BEGIN;

ALTER TABLE run
    ADD COLUMN chained_from_run_id BIGINT REFERENCES run(id) ON DELETE RESTRICT,
    ADD CONSTRAINT run_chained_from_not_self CHECK (chained_from_run_id IS NULL OR chained_from_run_id <> id);

CREATE UNIQUE INDEX idx_run_chained_from_unique
    ON run(chained_from_run_id)
    WHERE chained_from_run_id IS NOT NULL;

COMMIT;

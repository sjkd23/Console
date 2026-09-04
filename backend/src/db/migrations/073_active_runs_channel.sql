-- Configure the Active Runs channel and persist each run's mirror message.
INSERT INTO channel_catalog (channel_key, label, description)
VALUES ('active_runs', 'Active Runs', 'Clean list of Starting Soon and LIVE raids')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

ALTER TABLE run
    ADD COLUMN IF NOT EXISTS active_runs_channel_id BIGINT,
    ADD COLUMN IF NOT EXISTS active_runs_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_run_active_runs_message
    ON run(active_runs_message_id)
    WHERE active_runs_message_id IS NOT NULL;

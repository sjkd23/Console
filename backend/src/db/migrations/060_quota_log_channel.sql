-- 060_quota_log_channel.sql
-- Add the optional finalized quota-period log destination.

BEGIN;

INSERT INTO channel_catalog (channel_key, label, description) VALUES
    ('quota_log', 'Quota Log', 'Historical finalized quota-period results')
ON CONFLICT (channel_key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description;

COMMIT;

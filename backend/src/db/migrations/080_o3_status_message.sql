-- Keep editable O3 status separate from fresh dungeon-entered/manual pings.
-- Chained runs are new rows and intentionally start without a status message.
ALTER TABLE run ADD COLUMN o3_status_message_id BIGINT;

-- Retain deduplication/order metadata, but not completed transcript payloads.
-- Only an exact, positive final acknowledgement proves historical completion.
-- Pending, partially delivered, and inconsistent/unknown rows remain untouched.
-- Empty arrays satisfy the existing constraint and are excluded by the pending index.
-- Idempotent; deliberately irreversible for content already delivered to Discord.
UPDATE ticket_transcript_event
SET chunks = '[]'::jsonb
WHERE delivered = jsonb_array_length(chunks)
  AND jsonb_array_length(chunks) > 0;

-- Private content is queued durably until Discord accepts it. Never log these payloads.
CREATE TABLE ticket_transcript_event (
    ticket_id UUID NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
    event_key TEXT NOT NULL,
    chunks JSONB NOT NULL CHECK (jsonb_typeof(chunks) = 'array'),
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticket_id, event_key)
);
CREATE INDEX ticket_transcript_pending ON ticket_transcript_event(ticket_id, created_at)
    WHERE delivered < jsonb_array_length(chunks);

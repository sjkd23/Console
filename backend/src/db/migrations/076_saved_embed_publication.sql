-- Existing templates remain unpublished: historical sends did not persist message IDs.
ALTER TABLE saved_embed
    ADD COLUMN published_channel_id BIGINT,
    ADD COLUMN published_message_id BIGINT,
    ADD CONSTRAINT saved_embed_publication_pair CHECK (
        (published_channel_id IS NULL) = (published_message_id IS NULL)
    );

CREATE UNIQUE INDEX saved_embed_published_message_unique
    ON saved_embed (guild_id, published_channel_id, published_message_id)
    WHERE published_message_id IS NOT NULL;

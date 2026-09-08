CREATE TABLE ticket_config (
    id UUID PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    panel_channel_id BIGINT NOT NULL,
    category_id BIGINT NOT NULL,
    panel_embed JSONB NOT NULL CHECK (jsonb_typeof(panel_embed) = 'object'),
    opening_embed JSONB NOT NULL CHECK (jsonb_typeof(opening_embed) = 'object'),
    staff_role_ids JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(staff_role_ids) = 'array'),
    enabled BOOLEAN NOT NULL DEFAULT true,
    published_channel_id BIGINT,
    panel_message_id BIGINT,
    created_by BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE (guild_id, id),
    CHECK ((published_channel_id IS NULL) = (panel_message_id IS NULL))
);
CREATE INDEX ticket_config_guild ON ticket_config(guild_id, name, id);
CREATE UNIQUE INDEX ticket_panel_message ON ticket_config(panel_message_id) WHERE panel_message_id IS NOT NULL;

CREATE TABLE ticket (
    id UUID PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    ticket_config_id UUID NOT NULL,
    user_id BIGINT NOT NULL,
    type_name TEXT NOT NULL,
    staff_role_ids JSONB NOT NULL DEFAULT '[]',
    channel_id BIGINT UNIQUE,
    log_channel_id BIGINT,
    log_message_id BIGINT,
    thread_id BIGINT UNIQUE,
    opening_message_id BIGINT,
    status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','open','closing','closed','failed','stale')),
    operation_id UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    closed_by BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (guild_id, ticket_config_id) REFERENCES ticket_config(guild_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ticket_one_active_type ON ticket(guild_id, ticket_config_id, user_id)
    WHERE status IN ('creating','open','closing');
CREATE INDEX ticket_recovery ON ticket(guild_id, status, id) WHERE status IN ('creating','open','closing');

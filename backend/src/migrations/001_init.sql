-- =========
-- CORE ENTITIES
-- =========
-- Discord guilds (servers)
CREATE TABLE IF NOT EXISTS guild (
    id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- Global Discord users (not guild-scoped)
CREATE TABLE IF NOT EXISTS member (
    id BIGINT PRIMARY KEY,
    -- discord user id
    username TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- Verified raider status per guild (guild-scoped profile)
CREATE TABLE IF NOT EXISTS raider (
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    nickname TEXT,
    -- guild/server nickname snapshot
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'rejected', 'banned')
    ),
    verified_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
-- =========
-- RUNS
-- =========
CREATE TABLE IF NOT EXISTS run (
    id BIGSERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
    organizer_id BIGINT REFERENCES member(id) ON DELETE
    SET NULL,
        dungeon_key TEXT NOT NULL,
        -- stable key (e.g., "fungal")
        dungeon_label TEXT NOT NULL,
        -- display name ("Fungal Cavern")
        description TEXT,
        cap INTEGER,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'started', 'ended', 'cancelled')),
        channel_id BIGINT,
        -- where the run embed lives
        post_message_id BIGINT,
        -- the message to update
        created_at TIMESTAMPTZ DEFAULT now(),
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ
);
-- Player reactions (Realm terminology: join/bench/leave/etc.)
CREATE TABLE IF NOT EXISTS reaction (
    run_id BIGINT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('join', 'bench', 'leave')),
    -- can expand later
    class TEXT,
    -- optional chosen class
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (run_id, user_id)
);
-- =========
-- AUDIT LOG
-- =========
CREATE TABLE IF NOT EXISTS audit (
    id BIGSERIAL PRIMARY KEY,
    guild_id BIGINT,
    actor_id BIGINT,
    -- who performed the action
    action TEXT NOT NULL,
    -- 'raider.approve','run.create','run.cancel','reaction.join', etc.
    subject TEXT,
    meta JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- =========
-- INDEXES
-- =========
CREATE INDEX IF NOT EXISTS idx_run_guild ON run(guild_id);
CREATE INDEX IF NOT EXISTS idx_run_status ON run(status);
CREATE INDEX IF NOT EXISTS idx_reaction_run ON reaction(run_id);
CREATE INDEX IF NOT EXISTS idx_raider_guild ON raider(guild_id);
-- 027_command_log.sql
-- Purpose: Add command logging system to track slash command executions

BEGIN;

-- Command log table tracks all slash command executions with metadata
-- This allows for analytics, debugging, and auditing of bot usage
CREATE TABLE IF NOT EXISTS command_log (
    id BIGSERIAL PRIMARY KEY,
    guild_id TEXT, -- Nullable for DM commands
    channel_id TEXT, -- Nullable for DM commands
    user_id TEXT NOT NULL, -- Discord user ID of command invoker
    command_name TEXT NOT NULL, -- Top-level command (e.g., 'run', 'verify', 'stats')
    subcommand TEXT, -- Subcommand if applicable (e.g., 'verify', 'remove')
    options JSONB, -- Sanitized command options/arguments
    success BOOLEAN NOT NULL DEFAULT true, -- Whether command completed successfully
    error_code TEXT, -- Error category (e.g., 'MISSING_PERMISSIONS', 'BACKEND_ERROR')
    latency_ms INTEGER, -- Time between receiving interaction and sending response
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying and analytics
CREATE INDEX IF NOT EXISTS idx_command_log_guild_created ON command_log(guild_id, created_at) WHERE guild_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_command_log_command_created ON command_log(command_name, created_at);
CREATE INDEX IF NOT EXISTS idx_command_log_user ON command_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_command_log_error ON command_log(error_code, created_at) WHERE error_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_command_log_success ON command_log(success, created_at);

-- Add comment for clarity
COMMENT ON TABLE command_log IS 'Logs all slash command executions for analytics, debugging, and auditing';
COMMENT ON COLUMN command_log.guild_id IS 'Discord guild ID where command was executed (NULL for DMs)';
COMMENT ON COLUMN command_log.channel_id IS 'Discord channel ID where command was executed (NULL for DMs)';
COMMENT ON COLUMN command_log.user_id IS 'Discord user ID of the person who executed the command';
COMMENT ON COLUMN command_log.command_name IS 'Top-level slash command name';
COMMENT ON COLUMN command_log.subcommand IS 'Subcommand name if the command uses subcommands';
COMMENT ON COLUMN command_log.options IS 'Sanitized command options/arguments (sensitive data excluded)';
COMMENT ON COLUMN command_log.success IS 'Whether the command completed successfully from the bot perspective';
COMMENT ON COLUMN command_log.error_code IS 'Categorized error code for failures (e.g., MISSING_PERMISSIONS, BACKEND_ERROR, UNKNOWN_ERROR)';
COMMENT ON COLUMN command_log.latency_ms IS 'Time in milliseconds between receiving interaction and sending main response';

COMMIT;

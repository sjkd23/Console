// bot/src/lib/command-logging.ts
import type { ChatInputCommandInteraction } from 'discord.js';
import { postJSON, BackendError } from './http.js';

/**
 * Result of a command execution for logging purposes.
 */
export interface CommandExecutionResult {
    /** Whether the command completed successfully */
    success: boolean;
    /** Error code if command failed (e.g., 'MISSING_PERMISSIONS', 'BACKEND_ERROR') */
    errorCode?: string;
    /** Optional latency in milliseconds */
    latencyMs?: number;
}

/**
 * Sanitizes command options to remove sensitive data before logging.
 * Removes known sensitive fields like tokens, passwords, API keys.
 */
function sanitizeOptions(options: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    const sensitiveKeys = ['token', 'password', 'api_key', 'secret', 'apikey'];

    for (const [key, value] of Object.entries(options)) {
        // Skip sensitive keys
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
            sanitized[key] = '[REDACTED]';
            continue;
        }

        // For objects, recursively sanitize
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            sanitized[key] = sanitizeOptions(value);
        } else {
            // Keep safe values as-is
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * Extracts command options from a ChatInputCommandInteraction.
 * Returns a sanitized object suitable for logging.
 */
function extractCommandOptions(interaction: ChatInputCommandInteraction): Record<string, any> | null {
    try {
        const options: Record<string, any> = {};

        // Get all options from the interaction
        for (const option of interaction.options.data) {
            // Handle subcommands and subcommand groups
            if (option.type === 1 || option.type === 2) {
                // Subcommand or SubcommandGroup - skip, we handle this separately
                continue;
            }

            // Extract option value
            if (option.value !== undefined) {
                options[option.name] = option.value;
            }
        }

        // If no options, return null
        if (Object.keys(options).length === 0) {
            return null;
        }

        // Sanitize before returning
        return sanitizeOptions(options);
    } catch (err) {
        console.error('[CommandLogging] Failed to extract command options:', err);
        return null;
    }
}

/**
 * Extracts subcommand name from a ChatInputCommandInteraction if present.
 */
function extractSubcommand(interaction: ChatInputCommandInteraction): string | null {
    try {
        // Check for subcommand
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand) {
            return subcommand;
        }

        // Check for subcommand group
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        if (subcommandGroup) {
            const subcommandName = interaction.options.getSubcommand(false);
            return subcommandName ? `${subcommandGroup}.${subcommandName}` : subcommandGroup;
        }

        return null;
    } catch (err) {
        // No subcommand - this is fine
        return null;
    }
}

/**
 * Logs a command execution to the backend.
 * This function is non-blocking and will not throw errors to the caller.
 * Any failures are logged locally but do not affect command execution.
 * 
 * @param interaction - The ChatInputCommandInteraction that was executed
 * @param result - The result of the command execution
 */
export async function logCommandExecution(
    interaction: ChatInputCommandInteraction,
    result: CommandExecutionResult
): Promise<void> {
    try {
        // Extract command metadata
        const guildId = interaction.guildId ?? null;
        const channelId = interaction.channelId ?? null;
        const userId = interaction.user.id;
        const commandName = interaction.commandName;
        const subcommand = extractSubcommand(interaction);
        const options = extractCommandOptions(interaction);

        // Prepare payload
        const payload = {
            guild_id: guildId,
            channel_id: channelId,
            user_id: userId,
            command_name: commandName,
            subcommand,
            options,
            success: result.success,
            error_code: result.errorCode ?? null,
            latency_ms: result.latencyMs ?? null,
        };

        // Send to backend (non-blocking)
        await postJSON('/command-log', payload);

        // Success - log locally for debugging
        const errorInfo = result.errorCode ? ` (error: ${result.errorCode})` : '';
        console.log(
            `[CommandLogging] Logged: ${commandName}${subcommand ? `/${subcommand}` : ''} ` +
            `by ${userId} in ${guildId ? `guild ${guildId}` : 'DM'}${errorInfo}`
        );
    } catch (err) {
        // Log the error but do NOT throw - we don't want logging failures to break commands
        if (err instanceof BackendError) {
            console.warn(
                `[CommandLogging] Backend error logging command ${interaction.commandName}: ` +
                `${err.code} - ${err.message}`
            );
        } else {
            console.warn(
                `[CommandLogging] Failed to log command ${interaction.commandName}:`,
                err instanceof Error ? err.message : err
            );
        }
    }
}

/**
 * Creates a CommandExecutionResult for a successful command.
 */
export function createSuccessResult(latencyMs?: number): CommandExecutionResult {
    return { success: true, latencyMs };
}

/**
 * Creates a CommandExecutionResult for a failed command.
 */
export function createErrorResult(errorCode: string, latencyMs?: number): CommandExecutionResult {
    return { success: false, errorCode, latencyMs };
}

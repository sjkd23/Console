// bot/src/lib/utilities/rate-limit-middleware.ts
import type { ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../commands/_types.js';
import {
    checkCommandRateLimit,
    checkButtonRateLimit,
    formatRateLimitError,
    RateLimitPresets,
    type RateLimitConfig
} from './rate-limiter.js';

/**
 * Wrap a command with rate limiting.
 * Rate limit is applied BEFORE the command executes (but after permission checks).
 * 
 * @param command - The command to wrap
 * @param config - Optional custom rate limit config
 * @returns Wrapped command with rate limiting
 */
export function withRateLimit(
    command: SlashCommand,
    config?: RateLimitConfig
): SlashCommand {
    const originalRun = command.run;

    // Determine appropriate rate limit config based on command characteristics
    const rateLimitConfig = config || determineCommandRateLimit(command);

    return {
        ...command,
        run: async (interaction: ChatInputCommandInteraction) => {
            // Check rate limit
            const result = checkCommandRateLimit(
                interaction,
                command.data.name,
                rateLimitConfig
            );

            if (!result.allowed) {
                await interaction.reply({
                    content: formatRateLimitError(result),
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Execute original command
            await originalRun(interaction);
        }
    };
}

/**
 * Automatically determine appropriate rate limit for a command based on its characteristics.
 * This provides sensible defaults while allowing manual override.
 */
function determineCommandRateLimit(command: SlashCommand): RateLimitConfig {
    const commandName = command.data.name.toLowerCase();

    // Config commands - more restrictive
    if (commandName.startsWith('config') || 
        commandName.includes('setroles') || 
        commandName.includes('setchannels')) {
        return RateLimitPresets.COMMAND_CONFIG;
    }

    // Heavy/expensive commands
    if (commandName === 'stats' || 
        commandName === 'leaderboard' ||
        commandName === 'checkpunishments') {
        return RateLimitPresets.COMMAND_HEAVY;
    }

    // Quick info commands
    if (commandName === 'help' || 
        commandName === 'ping') {
        return RateLimitPresets.COMMAND_INFO;
    }

    // Default for all other commands
    return RateLimitPresets.COMMAND_DEFAULT;
}

/**
 * Apply rate limiting to a button interaction handler.
 * Returns true if allowed, false if rate limited (and sends error message).
 * 
 * @param interaction - Button interaction
 * @param identifier - Rate limit identifier (use shared identifiers for grouped actions)
 * @param config - Optional custom rate limit config
 * @returns True if allowed, false if rate limited
 */
export async function applyButtonRateLimit(
    interaction: ButtonInteraction,
    identifier: string,
    config?: RateLimitConfig
): Promise<boolean> {
    const rateLimitConfig = config || determineButtonRateLimit(identifier);
    
    const result = checkButtonRateLimit(
        interaction,
        identifier,
        rateLimitConfig
    );

    if (!result.allowed) {
        // Send rate limit error
        const errorContent = formatRateLimitError(result);

        if (interaction.deferred) {
            await interaction.editReply({ content: errorContent });
        } else if (!interaction.replied) {
            await interaction.reply({ 
                content: errorContent, 
                flags: MessageFlags.Ephemeral 
            });
        }

        return false;
    }

    return true;
}

/**
 * Automatically determine appropriate rate limit for a button based on its identifier.
 */
function determineButtonRateLimit(identifier: string): RateLimitConfig {
    // Key popped button - very strict to prevent accidents
    if (identifier === 'run:keypop') {
        return RateLimitPresets.BUTTON_KEY_POPPED;
    }

    // Verification buttons - strict
    if (identifier.startsWith('verification:')) {
        return RateLimitPresets.BUTTON_VERIFICATION;
    }

    // Config panel buttons - restrictive
    if (identifier.includes('config') || identifier.includes('_config_')) {
        return RateLimitPresets.BUTTON_CONFIG_PANEL;
    }

    // Run participation (join/leave) - prevent rapid toggling
    if (identifier === 'run:participation') {
        return RateLimitPresets.BUTTON_RUN_PARTICIPATION;
    }

    // Key reactions - prevent spam
    if (identifier.startsWith('run:key:') || identifier.includes(':key:')) {
        return RateLimitPresets.BUTTON_KEY_REACTION;
    }

    // Organizer panel actions
    if (identifier.includes(':org:') || 
        identifier.includes('organizer') ||
        identifier.includes(':panel:')) {
        return RateLimitPresets.BUTTON_ORGANIZER_PANEL;
    }

    // Modmail actions
    if (identifier.startsWith('modmail:')) {
        return RateLimitPresets.BUTTON_MODMAIL;
    }

    // Default for all other buttons
    return RateLimitPresets.BUTTON_DEFAULT;
}

/**
 * Helper to wrap multiple commands with rate limiting at once.
 * Useful for bulk application during command registration.
 * 
 * @param commands - Array of commands to wrap
 * @returns Array of wrapped commands
 */
export function applyRateLimitToCommands(commands: SlashCommand[]): SlashCommand[] {
    return commands.map(cmd => withRateLimit(cmd));
}

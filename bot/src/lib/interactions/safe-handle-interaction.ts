/**
 * Centralized interaction handling wrapper for reliable error handling.
 * 
 * This module provides a wrapper function that:
 * - Catches and logs all errors with full context
 * - Sends user-friendly error messages
 * - Prevents unhandled rejections and ensures errors are always shown to users
 * 
 * NOTE: This wrapper does NOT automatically defer interactions.
 * Each handler is responsible for calling deferReply() or reply() as appropriate.
 * 
 * Usage:
 *   await safeHandleInteraction(interaction, async () => {
 *     // Your handler logic here
 *   }, { ephemeral: true });
 */

import type {
    Interaction,
    ChatInputCommandInteraction,
    ButtonInteraction,
    ModalSubmitInteraction,
    StringSelectMenuInteraction,
    AutocompleteInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { createLogger } from '../logging/logger.js';
import { BackendError } from '../utilities/http.js';

const logger = createLogger('InteractionHandler');

export type RepliableInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction;

export interface SafeHandleOptions {
    /**
     * Whether to defer the interaction as ephemeral.
     * Default: false (visible to everyone).
     * 
     * This is used for error messages only - handlers are responsible
     * for their own deferral/reply behavior.
     */
    ephemeral?: boolean;

    /**
     * Optional context string for logging (e.g., "JoinButton", "CreateRunCommand").
     * If not provided, will be inferred from interaction type and customId/commandName.
     */
    context?: string;
}

/**
 * Extracts a human-readable context string from an interaction for logging.
 */
function getInteractionContext(interaction: RepliableInteraction): string {
    if (interaction.isChatInputCommand()) {
        const subcommand = interaction.options.getSubcommand(false);
        return subcommand
            ? `command:${interaction.commandName}/${subcommand}`
            : `command:${interaction.commandName}`;
    }

    if (interaction.isButton()) {
        return `button:${interaction.customId}`;
    }

    if (interaction.isModalSubmit()) {
        return `modal:${interaction.customId}`;
    }

    if (interaction.isStringSelectMenu()) {
        return `select:${interaction.customId}`;
    }

    return `interaction:unknown`;
}

/**
 * Maps errors to user-friendly messages based on error type.
 */
function getUserErrorMessage(error: unknown, context: string): string {
    // Backend API errors
    if (error instanceof BackendError) {
        switch (error.code) {
            case 'NOT_AUTHORIZED':
                return '❌ You don\'t have permission to perform this action. Contact a staff member if you believe this is incorrect.';
            case 'NOT_ORGANIZER':
                return '❌ This action requires the Organizer role. Please ask an admin to configure roles using `/setroles`.';
            case 'VALIDATION_ERROR':
                return `❌ Invalid input: ${error.message}`;
            case 'NOT_FOUND':
                return '❌ The requested resource was not found. It may have been deleted or is no longer available.';
            case 'RUN_NOT_FOUND':
                return '❌ This run no longer exists or has been cancelled.';
            case 'CONFLICT':
                return `❌ ${error.message}`;
            case 'BACKEND_ERROR':
            case 'DATABASE_ERROR':
                return '❌ A server error occurred. Please try again in a moment. If this persists, contact staff.';
            default:
                return `❌ An error occurred: ${error.message || 'Please try again or contact staff.'}`;
        }
    }

    // Discord.js or other standard errors
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();

        // Permission errors
        if (msg.includes('missing permissions') || msg.includes('permission')) {
            return '❌ The bot is missing required Discord permissions. Please contact an admin.';
        }

        // Timeout errors
        if (msg.includes('timeout') || msg.includes('timed out')) {
            return '❌ The operation timed out. Please try again.';
        }

        // Rate limit errors
        if (msg.includes('rate limit')) {
            return '❌ You\'re doing that too fast. Please wait a moment and try again.';
        }

        // Unknown errors - provide generic message
        return '❌ Something went wrong. Please try again or contact staff if this persists.';
    }

    // Completely unknown error
    return '❌ An unexpected error occurred. Please try again later.';
}

/**
 * Logs interaction error with full context for debugging.
 */
function logInteractionError(
    error: unknown,
    interaction: RepliableInteraction,
    context: string
): void {
    const logData: Record<string, unknown> = {
        interactionType: interaction.type,
        context,
        userId: interaction.user.id,
        guildId: interaction.guildId || 'DM',
        channelId: interaction.channelId || 'unknown',
    };

    // Add interaction-specific details
    if (interaction.isChatInputCommand()) {
        logData.commandName = interaction.commandName;
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand) {
            logData.subcommand = subcommand;
        }
    } else if ('customId' in interaction) {
        logData.customId = interaction.customId;
    }

    // Log the error with context
    if (error instanceof BackendError) {
        logger.error('Backend error during interaction', {
            ...logData,
            errorCode: error.code,
            status: error.status,
            requestId: error.requestId,
            message: error.message,
        });
    } else if (error instanceof Error) {
        logger.error('Error during interaction', {
            ...logData,
            error: error.message,
            stack: error.stack,
        });
    } else {
        logger.error('Unknown error during interaction', {
            ...logData,
            error: String(error),
        });
    }
}

/**
 * Safely sends an error message to the user, handling all possible interaction states.
 */
async function sendErrorMessage(
    interaction: RepliableInteraction,
    message: string,
    ephemeral: boolean
): Promise<void> {
    try {
        const flags = ephemeral ? MessageFlags.Ephemeral : undefined;

        if (!interaction.replied && !interaction.deferred) {
            // Haven't replied yet - send as initial reply
            await interaction.reply({ content: message, flags });
        } else if (interaction.deferred) {
            // Already deferred - edit the deferred reply
            await interaction.editReply({ content: message });
        } else {
            // Already replied - send as follow-up
            await interaction.followUp({ content: message, flags });
        }
    } catch (replyError) {
        // If we can't even send an error message, log it
        logger.error('Failed to send error message to user', {
            userId: interaction.user.id,
            guildId: interaction.guildId || 'DM',
            originalMessage: message,
            replyError: replyError instanceof Error ? replyError.message : String(replyError),
        });
    }
}

/**
 * Wraps an interaction handler with automatic error handling and logging.
 * 
 * This function ensures that:
 * 1. All errors are caught and logged with full context
 * 2. Users receive friendly error messages
 * 3. No unhandled rejections or double-replies occur
 * 
 * NOTE: This wrapper does NOT automatically defer interactions.
 * Handlers are responsible for deferring or replying as needed.
 * 
 * @param interaction - The Discord interaction to handle
 * @param handler - The async function that handles the interaction logic
 * @param options - Configuration options for error handling and logging
 * 
 * @example
 * // In a command handler
 * await safeHandleInteraction(interaction, async () => {
 *   await createRun(interaction);
 * });
 * 
 * @example
 * // In a button handler (ephemeral)
 * await safeHandleInteraction(interaction, async () => {
 *   await handleOrganizerPanel(interaction, runId);
 * }, { ephemeral: true });
 */
export async function safeHandleInteraction(
    interaction: RepliableInteraction,
    handler: () => Promise<void>,
    options: SafeHandleOptions = {}
): Promise<void> {
    const {
        ephemeral = false,
        context = getInteractionContext(interaction),
    } = options;

    try {
        // Execute the handler (it should defer/reply on its own)
        await handler();
    } catch (error) {
        // Log the error with full context
        logInteractionError(error, interaction, context);

        // Get user-friendly error message
        const userMessage = getUserErrorMessage(error, context);

        // Send error message to user
        await sendErrorMessage(interaction, userMessage, ephemeral);
    }
}

/**
 * A variant of safeHandleInteraction that binds a handler method to an object.
 * Useful for class-based command handlers.
 * 
 * @example
 * await safeHandleInteraction(interaction, command.run.bind(command));
 */
export async function safeHandleInteractionBound(
    interaction: RepliableInteraction,
    handler: (interaction: RepliableInteraction) => Promise<void>,
    options: SafeHandleOptions = {}
): Promise<void> {
    return safeHandleInteraction(interaction, () => handler(interaction), options);
}

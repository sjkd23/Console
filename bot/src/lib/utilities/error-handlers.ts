import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { BackendError } from './http.js';

/**
 * Standard error handler for command interactions.
 * Handles both caught and uncaught errors with appropriate messaging.
 * 
 * @param interaction - Discord interaction
 * @param error - Error that occurred
 * @param context - Context string for logging (e.g., command name)
 * 
 * @example
 * try {
 *     // Command logic
 * } catch (err) {
 *     await handleCommandError(interaction, err, 'Mute');
 * }
 */
export async function handleCommandError(
    interaction: ChatInputCommandInteraction,
    error: unknown,
    context: string
): Promise<void> {
    console.error(`[${context}] Error:`, error);
    
    let errorMessage = `❌ **Failed to ${context.toLowerCase()}**\n\n`;
    
    if (error instanceof BackendError) {
        switch (error.code) {
            case 'NOT_AUTHORIZED':
            case 'NOT_SECURITY':
            case 'NOT_OFFICER':
            case 'NOT_ORGANIZER':
                errorMessage += '**Issue:** Authorization failed.\n\n';
                errorMessage += '**What to do:**\n';
                errorMessage += '• This is likely a server configuration issue\n';
                errorMessage += '• Contact a server administrator if this persists';
                break;
            case 'VALIDATION_ERROR':
                errorMessage += `**Issue:** ${error.message}\n\n`;
                errorMessage += 'Please check that all required fields are filled correctly.';
                break;
            case 'IGN_ALREADY_IN_USE':
                errorMessage += `**Issue:** ${error.message}\n\n`;
                errorMessage += 'Each IGN can only be linked to one Discord account.';
                break;
            case 'RAIDER_NOT_FOUND':
            case 'RUN_NOT_FOUND':
            case 'PUNISHMENT_NOT_FOUND':
                errorMessage += `**Issue:** ${error.message}\n\n`;
                errorMessage += 'The requested resource could not be found.';
                break;
            default:
                errorMessage += `**Error:** ${error.message}\n\n`;
                errorMessage += 'Please try again or contact an administrator if the problem persists.';
        }
    } else {
        errorMessage += 'An unexpected error occurred. Please try again later.';
    }
    
    await interaction.editReply(errorMessage);
}

/**
 * Wraps the final try-catch block that handles unexpected errors.
 * Use this as the outermost error handler in command run() functions.
 * 
 * @param interaction - Discord interaction
 * @param error - Error that occurred
 * @param context - Context string for logging
 * 
 * @example
 * try {
 *     // Main command logic
 * } catch (err) {
 *     await handleCommandError(interaction, err, 'Mute');
 * } catch (unhandled) {
 *     await handleUnhandledError(interaction, unhandled, 'Mute');
 * }
 */
export async function handleUnhandledError(
    interaction: ChatInputCommandInteraction,
    error: unknown,
    context: string
): Promise<void> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ Something went wrong while handling this command.');
        } else {
            await interaction.reply({
                content: '❌ Something went wrong.',
                flags: MessageFlags.Ephemeral,
            });
        }
    } catch {
        // Ignore errors in error handler
    }
    console.error(`[${context}] Unhandled error:`, error);
}

/**
 * Creates a formatted error message for backend errors.
 * 
 * @param error - Backend error
 * @param defaultMessage - Default message if error type not recognized
 * @returns Formatted error message
 */
export function formatBackendError(error: BackendError, defaultMessage: string): string {
    let message = '❌ ';
    
    switch (error.code) {
        case 'NOT_AUTHORIZED':
        case 'NOT_SECURITY':
        case 'NOT_OFFICER':
        case 'NOT_ORGANIZER':
            message += '**Authorization Failed**\n\n';
            message += error.message || 'You do not have permission to perform this action.';
            break;
        case 'VALIDATION_ERROR':
            message += '**Validation Error**\n\n';
            message += error.message || 'Invalid input provided.';
            break;
        case 'IGN_ALREADY_IN_USE':
            message += '**IGN Conflict**\n\n';
            message += error.message || 'This IGN is already in use.';
            break;
        case 'RUN_CLOSED':
        case 'RUN_NOT_LIVE':
        case 'INVALID_STATUS_TRANSITION':
            message += '**Invalid Operation**\n\n';
            message += error.message || 'This operation cannot be performed at this time.';
            break;
        default:
            message += defaultMessage + '\n\n';
            message += error.message || 'An error occurred.';
    }
    
    return message;
}

/**
 * Safely replies or edits a reply with an error message.
 * Automatically determines whether to reply or edit based on interaction state.
 * 
 * @param interaction - Discord interaction
 * @param message - Error message to send
 * @param ephemeral - Whether to send ephemerally (only for initial replies)
 */
export async function safeErrorReply(
    interaction: ChatInputCommandInteraction,
    message: string,
    ephemeral = false
): Promise<void> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(message);
        } else {
            await interaction.reply({
                content: message,
                flags: ephemeral ? MessageFlags.Ephemeral : undefined,
            });
        }
    } catch (err) {
        console.error('[ErrorReply] Failed to send error message:', err);
    }
}

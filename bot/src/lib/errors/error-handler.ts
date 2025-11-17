/**
 * Centralized error handling for bot commands.
 */

import { BackendError } from '../utilities/http.js';

export interface ErrorMessageOptions {
    /** The error that occurred */
    error: unknown;
    /** Base error message to display */
    baseMessage: string;
    /** Custom error code handlers */
    errorHandlers?: Record<string, string>;
}

/**
 * Maps backend errors to user-friendly messages with consistent formatting.
 * @param options - Error handling options
 * @returns Formatted error message string
 */
export function formatErrorMessage(options: ErrorMessageOptions): string {
    const { error, baseMessage, errorHandlers = {} } = options;
    
    let errorMessage = `**${baseMessage}**\n\n`;
    
    if (error instanceof BackendError) {
        // Check for custom handler first
        if (error.code && errorHandlers[error.code]) {
            errorMessage += errorHandlers[error.code];
        } else {
            // Default handlers for common error codes
            switch (error.code) {
                case 'NOT_AUTHORIZED':
                    errorMessage += 'You don\'t have permission for this.\n\n';
                    errorMessage += 'Make sure you have the right role, or contact an admin if something\'s wrong.';
                    break;
                case 'NOT_ORGANIZER':
                    errorMessage += 'You need the Organizer role.\n\n';
                    errorMessage += 'Ask an admin to use `/setroles` to set it up and make sure you have the Organizer Discord role.';
                    break;
                case 'VALIDATION_ERROR':
                    errorMessage += `${error.message}\n\n`;
                    errorMessage += 'Check your input and try again.';
                    break;
                default:
                    errorMessage += `${error.message}\n\n`;
                    errorMessage += 'Try again or contact an admin if this keeps happening.';
            }
        }
    } else {
        console.error(`[Error] ${baseMessage}:`, error);
        errorMessage += 'Something went wrong. Try again later.';
    }
    
    return errorMessage;
}

/**
 * Centralized error handling for bot commands.
 */

import { BackendError } from './http.js';

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
    
    let errorMessage = `❌ **${baseMessage}**\n\n`;
    
    if (error instanceof BackendError) {
        // Check for custom handler first
        if (error.code && errorHandlers[error.code]) {
            errorMessage += errorHandlers[error.code];
        } else {
            // Default handlers for common error codes
            switch (error.code) {
                case 'NOT_AUTHORIZED':
                    errorMessage += '**Issue:** You don\'t have permission to perform this action.\n\n';
                    errorMessage += '**What to do:**\n';
                    errorMessage += '• Make sure you have the required Discord role\n';
                    errorMessage += '• Contact a server administrator if you believe this is an error';
                    break;
                case 'NOT_ORGANIZER':
                    errorMessage += '**Issue:** You don\'t have the Organizer role configured for this server.\n\n';
                    errorMessage += '**What to do:**\n';
                    errorMessage += '• Ask a server admin to use `/setroles` to set up the Organizer role\n';
                    errorMessage += '• Make sure you have the Discord role that\'s mapped to Organizer';
                    break;
                case 'VALIDATION_ERROR':
                    errorMessage += `**Issue:** ${error.message}\n\n`;
                    errorMessage += 'Please check your input and try again.';
                    break;
                default:
                    errorMessage += `**Error:** ${error.message}\n\n`;
                    errorMessage += 'Please try again or contact an administrator if the problem persists.';
            }
        }
    } else {
        console.error(`[Error] ${baseMessage}:`, error);
        errorMessage += 'An unexpected error occurred. Please try again later.';
    }
    
    return errorMessage;
}

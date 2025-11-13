/**
 * Centralized logging utility for the backend.
 * Wraps pino logger with consistent formatting and context support.
 * 
 * Usage:
 *   import { logger } from './lib/logger.js';
 *   logger.info({ guildId, userId }, 'User action completed');
 *   logger.error({ err, runId }, 'Failed to end run');
 * 
 * Log levels: trace, debug, info, warn, error, fatal
 * 
 * Note: Pino expects (optional data object, message) format
 */

import pino from 'pino';

// Create the base logger instance
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    }
  } : undefined,
});

/**
 * Create a logger with a specific context prefix
 * @param context - Context string to prefix all log messages (e.g., 'RunAutoEnd', 'Quota', 'Punishments')
 */
export function createLogger(context: string) {
  return baseLogger.child({ context });
}

/**
 * Default logger instance without context
 */
export const logger = baseLogger;

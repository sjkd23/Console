/**
 * Centralized logging utility for the Discord bot.
 * Provides consistent formatting with context prefixes and log levels.
 * 
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const logger = createLogger('RunAutoEnd');
 *   logger.info('Checking for expired runs');
 *   logger.error('Failed to process run', { runId, error });
 * 
 * Log levels: debug, info, warn, error
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

class Logger {
  private context: string;
  private minLevel: LogLevel;

  constructor(context: string = 'Bot', minLevel: LogLevel = 'info') {
    this.context = context;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatMessage(level: LogLevel, message: string, data?: LogContext): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.context}]`;
    
    if (data && Object.keys(data).length > 0) {
      return `${prefix} ${message} ${JSON.stringify(data)}`;
    }
    
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: LogContext): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: LogContext): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: LogContext): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, data?: LogContext): void {
    if (this.shouldLog('error')) {
      // If data contains an error object, log it separately for better stack traces
      if (data?.error instanceof Error) {
        console.error(this.formatMessage('error', message, { ...data, error: data.error.message }));
        console.error(data.error.stack);
      } else if (data?.err instanceof Error) {
        console.error(this.formatMessage('error', message, { ...data, err: data.err.message }));
        console.error(data.err.stack);
      } else {
        console.error(this.formatMessage('error', message, data));
      }
    }
  }
}

/**
 * Create a logger instance with a specific context
 * @param context - Context string to prefix all log messages (e.g., 'RunAutoEnd', 'Quota', 'Verification')
 * @param minLevel - Minimum log level to output (defaults to 'info', or LOG_LEVEL env var)
 */
export function createLogger(context: string, minLevel?: LogLevel): Logger {
  const envLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
  return new Logger(context, minLevel || envLevel);
}

/**
 * Default logger instance without specific context
 */
export const logger = new Logger('Bot', (process.env.LOG_LEVEL as LogLevel) || 'info');

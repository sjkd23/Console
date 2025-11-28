/**
 * Centralized logging utility for the Discord bot.
 * Provides structured JSON logging compatible with pino format for better searchability.
 * 
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const logger = createLogger('RunAutoEnd');
 *   logger.info('Checking for expired runs', { guildId, count: 5 });
 *   logger.error('Failed to process run', { runId, error, guildId });
 * 
 * Log levels: debug, info, warn, error
 * 
 * Output format matches pino structure:
 *   { "level": "info", "time": <timestamp>, "context": "QuotaPanel", "msg": "...", ...fields }
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

interface LogContext {
  [key: string]: unknown;
}

/**
 * Sanitizes sensitive data from log context
 * Masks verification codes, API keys, tokens, passwords
 */
function sanitizeContext(data: LogContext): LogContext {
  const sanitized: LogContext = {};
  
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    
    // Mask sensitive fields - be specific to avoid over-masking
    // Only mask verification codes and API codes, not error codes or status codes
    if ((lowerKey === 'verificationcode' || lowerKey === 'verification_code' || lowerKey === 'code') 
        && typeof value === 'string' && value.length > 4) {
      sanitized[key] = value.substring(0, 4) + '***';
    } else if (lowerKey.includes('token') || lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey.includes('apikey') || lowerKey.includes('api_key')) {
      sanitized[key] = '***';
    } else if (value instanceof Error) {
      // Convert Error objects to structured data
      sanitized[key] = {
        message: value.message,
        name: value.name,
        stack: value.stack,
      };
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

class Logger {
  private context: string;
  private minLevel: LogLevel;

  constructor(context: string = 'Bot', minLevel: LogLevel = 'info') {
    this.context = context;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.minLevel];
  }

  /**
   * Format log message as structured JSON compatible with pino format
   */
  private formatStructured(level: LogLevel, message: string, data?: LogContext): string {
    const logEntry: Record<string, unknown> = {
      level: LOG_LEVEL_VALUES[level],
      time: Date.now(),
      context: this.context,
      msg: message,
    };
    
    if (data && Object.keys(data).length > 0) {
      const sanitized = sanitizeContext(data);
      Object.assign(logEntry, sanitized);
    }
    
    return JSON.stringify(logEntry);
  }

  debug(message: string, data?: LogContext): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatStructured('debug', message, data));
    }
  }

  info(message: string, data?: LogContext): void {
    if (this.shouldLog('info')) {
      console.log(this.formatStructured('info', message, data));
    }
  }

  warn(message: string, data?: LogContext): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatStructured('warn', message, data));
    }
  }

  error(message: string, data?: LogContext): void {
    if (this.shouldLog('error')) {
      console.error(this.formatStructured('error', message, data));
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

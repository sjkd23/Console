/**
 * HTTP request logging utility
 * Provides structured logging for all HTTP/API calls to backend
 */

import { createLogger } from './logger.js';

const logger = createLogger('HTTP');

export interface HttpLogContext {
  requestId: string;
  method: string;
  path: string;
  status?: number;
  duration?: number;
  guildId?: string;
  roleId?: string;
  userId?: string;
  error?: string;
  code?: string;
  [key: string]: unknown; // Index signature for LogContext compatibility
}

/**
 * Log HTTP request start
 */
export function logHttpStart(ctx: Omit<HttpLogContext, 'status' | 'duration'>): void {
  logger.debug('API request starting', ctx);
}

/**
 * Log successful HTTP request completion
 */
export function logHttpSuccess(ctx: HttpLogContext): void {
  logger.info('API request completed', ctx);
}

/**
 * Log failed HTTP request
 */
export function logHttpError(ctx: HttpLogContext): void {
  logger.warn('API request failed', ctx);
}

/**
 * Log HTTP request timeout
 */
export function logHttpTimeout(ctx: HttpLogContext): void {
  logger.error('API request timed out', ctx);
}

import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { backendConfig } from '../config.js';
import { logger } from '../lib/logging/logger.js';

const isTest = process.env.NODE_ENV === 'test';

const connectionString =
    isTest && backendConfig.TEST_DATABASE_URL
        ? backendConfig.TEST_DATABASE_URL
        : backendConfig.DATABASE_URL;

if (!connectionString) {
    // Fail fast with a clear log message
    logger.error('No database connection string configured. DATABASE_URL or TEST_DATABASE_URL must be set.');
    throw new Error('Database connection string is not configured');
}

export const pool = new Pool({
    connectionString,
    // optional: ssl: { rejectUnauthorized: false }
});

const SLOW_QUERY_THRESHOLD_MS = 100;

export async function query<T extends import('pg').QueryResultRow = any>(text: string, params?: any[]) {
    const queryId = randomUUID().slice(0, 8);
    const start = Date.now();
    
    // Log query start (debug level to avoid noise in production)
    logger.debug({ 
        queryId, 
        sql: text.substring(0, 200), // Truncate long queries for readability
        paramCount: params?.length || 0 
    }, 'Executing database query');
    
    try {
        const res = await pool.query<T>(text, params);
        const duration = Date.now() - start;
        
        // Log slow queries at warn level
        if (duration > SLOW_QUERY_THRESHOLD_MS) {
            logger.warn({ 
                queryId, 
                duration, 
                rowCount: res.rowCount,
                sql: text.substring(0, 200)
            }, 'Slow query detected');
        } else {
            // Log successful queries at debug level
            logger.debug({ 
                queryId, 
                duration, 
                rowCount: res.rowCount 
            }, 'Query completed');
        }
        
        return res;
    } catch (err) {
        const duration = Date.now() - start;
        
        // Log errors at error level with full context
        logger.error({ 
            queryId, 
            duration,
            sql: text,
            params,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, 'Query failed');
        
        throw err;
    }
}

// Log pool events for connection monitoring
pool.on('error', (err) => {
    logger.error({ error: err.message, stack: err.stack }, 'Unexpected database pool error');
});

pool.on('connect', () => {
    logger.debug('New database connection established');
});

pool.on('remove', () => {
    logger.debug('Database connection removed from pool');
});

process.on('SIGINT', async () => { 
    logger.info('Shutting down database connection pool');
    try { 
        await pool.end(); 
        logger.info('Database connection pool closed successfully');
    } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error closing database pool');
    } finally { 
        process.exit(0); 
    } 
});

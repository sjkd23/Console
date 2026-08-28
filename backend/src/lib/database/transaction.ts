import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';

/** Execute a unit of work atomically on a dedicated database connection. */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

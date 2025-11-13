import 'dotenv/config';
import { Pool } from 'pg';
import { backendConfig } from '../config.js';

export const pool = new Pool({
    connectionString: backendConfig.DATABASE_URL,
    // optional: ssl: { rejectUnauthorized: false }
});

export async function query<T extends import('pg').QueryResultRow = any>(text: string, params?: any[]) {
    const res = await pool.query<T>(text, params);
    return res;
}

process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });

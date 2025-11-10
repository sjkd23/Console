import 'dotenv/config';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing DATABASE_URL');

export const pool = new Pool({
    connectionString: url,
    // optional: ssl: { rejectUnauthorized: false }
});

export async function query<T extends import('pg').QueryResultRow = any>(text: string, params?: any[]) {
    const res = await pool.query<T>(text, params);
    return res;
}

process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });

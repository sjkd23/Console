import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/pool.js';

async function ensureTable() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function alreadyApplied(filename: string) {
    const r = await pool.query('SELECT 1 FROM _migrations WHERE filename = $1', [filename]);
    return r.rowCount! > 0;
}

async function applyOne(path: string, filename: string) {
    const sql = readFileSync(path, 'utf8');
    await pool.query('BEGIN');
    try {
        await pool.query(sql);
        await pool.query('INSERT INTO _migrations(filename) VALUES ($1)', [filename]);
        await pool.query('COMMIT');
        console.log('✅ applied', filename);
    } catch (e) {
        await pool.query('ROLLBACK');
        console.error('❌ failed', filename, e);
        process.exit(1);
    }
}

async function main() {
    await ensureTable();
    const dir = join(process.cwd(), 'db', 'migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
        if (await alreadyApplied(f)) {
            console.log('↷ skip', f);
            continue;
        }
        await applyOne(join(dir, f), f);
    }
    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });

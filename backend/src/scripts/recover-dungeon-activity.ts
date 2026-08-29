import { pool } from '../db/pool.js';
import {
    recoverHistoricalActivityCorrections,
    recoverHistoricalZeroPointActivity,
} from '../lib/dungeon-activity/recovery.js';

function parseApply(arguments_: readonly string[]): boolean {
    let apply = false;
    for (const argument of arguments_) {
        if (argument === '--apply') apply = true;
        else if (argument === '--dry-run') apply = false;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return apply;
}

async function main(): Promise<void> {
    const apply = parseApply(process.argv.slice(2));
    const client = await pool.connect();
    try {
        if (apply) await client.query('BEGIN');
        const corrections = await recoverHistoricalActivityCorrections(client, apply);
        const zeroPointActivity = await recoverHistoricalZeroPointActivity(client, apply);
        if (apply) await client.query('COMMIT');
        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'dry-run',
            historical_activity_corrections: corrections,
            zero_point_activity: zeroPointActivity,
        }, null, 2));
    } catch (error) {
        if (apply) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });

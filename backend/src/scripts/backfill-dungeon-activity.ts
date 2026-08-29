import { z } from 'zod';
import { pool } from '../db/pool.js';
import {
    backfillDungeonActivityBatch,
    createEmptyBackfillResult,
    getLegacyQuotaEventHighWaterMark,
    mergeBackfillResults,
} from '../lib/dungeon-activity/backfill.js';
import { analyzeDungeonActivityParity, analyzeHistoricalZeroPointGaps } from '../lib/dungeon-activity/parity.js';

const ArgsSchema = z.object({
    apply: z.boolean(),
    batchSize: z.number().int().min(1).max(10_000),
});

function parseArgs(argv: readonly string[]): z.infer<typeof ArgsSchema> {
    let apply = false;
    let batchSize = 500;

    for (const argument of argv) {
        if (argument === '--apply') apply = true;
        else if (argument === '--dry-run') apply = false;
        else if (argument.startsWith('--batch-size=')) batchSize = Number(argument.slice('--batch-size='.length));
        else throw new Error(`Unknown argument: ${argument}`);
    }

    return ArgsSchema.parse({ apply, batchSize });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const highWaterId = await getLegacyQuotaEventHighWaterMark(pool);
    const total = createEmptyBackfillResult();
    let afterId = '0';

    while (BigInt(afterId) < BigInt(highWaterId)) {
        const client = await pool.connect();
        try {
            if (args.apply) await client.query('BEGIN');
            const batch = await backfillDungeonActivityBatch(client, {
                afterId,
                highWaterId,
                limit: args.batchSize,
                apply: args.apply,
            });
            if (args.apply) await client.query('COMMIT');

            mergeBackfillResults(total, batch);
            if (!batch.lastEventId) break;
            afterId = batch.lastEventId;
        } catch (error) {
            if (args.apply) await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    const gaps = await analyzeHistoricalZeroPointGaps(pool);
    const output: Record<string, unknown> = {
        mode: args.apply ? 'apply' : 'dry-run',
        high_water_quota_event_id: highWaterId,
        backfill: total,
        zero_point_gap_candidates: gaps,
    };

    if (args.apply) output.parity = await analyzeDungeonActivityParity(pool);
    console.log(JSON.stringify(output, null, 2));
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });

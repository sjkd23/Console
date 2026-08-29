import { z } from 'zod';
import { pool } from '../db/pool.js';
import { compareCanonicalStatsToLegacy } from '../lib/dungeon-activity/stats-comparison.js';
import { recoverHistoricalZeroPointActivity } from '../lib/dungeon-activity/recovery.js';

const GuildIdSchema = z.string().regex(/^\d{15,22}$/);

async function main(): Promise<void> {
    const guildArgument = process.argv.find(argument => argument.startsWith('--guild-id='));
    const guildId = guildArgument
        ? GuildIdSchema.parse(guildArgument.slice('--guild-id='.length))
        : undefined;
    const unknownArguments = process.argv.slice(2).filter(argument => !argument.startsWith('--guild-id='));
    if (unknownArguments.length > 0) throw new Error(`Unknown argument: ${unknownArguments[0]}`);

    const [comparison, recoveryClassification] = await Promise.all([
        compareCanonicalStatsToLegacy(pool, guildId),
        recoverHistoricalZeroPointActivity(pool, false, guildId),
    ]);
    console.log(JSON.stringify({
        guild_id: guildId ?? null,
        stats_comparison: comparison,
        zero_point_recovery_classification: recoveryClassification,
    }, null, 2));
    if (comparison.summary.unexplained_mismatches > 0) process.exitCode = 2;
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });

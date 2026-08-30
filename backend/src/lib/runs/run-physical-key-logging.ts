import type { PoolClient } from 'pg';
import { isAggregateActivityKey } from '../../config/raid-config.js';
import type { RunKind } from './run-taxonomy.js';

export interface LogRunPhysicalKeysInput {
    runId: string;
    guildId: string;
    userId: string;
    dungeonKey: string;
    amount: number;
    interactionId: string;
    pointsPerKey: number;
}

export interface LogRunPhysicalKeysResult {
    logged: number;
    newTotal: number;
    pointsAwarded: number;
    remainingAllowance: number;
    duplicate: boolean;
}

export class RunPhysicalKeyLogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RunPhysicalKeyLogError';
    }
}

interface RunRow {
    guild_id: string;
    status: string;
    run_kind: RunKind;
    key_pop_count: number | string;
}

/**
 * Records actual physical keys after a run. `key_pop_count` is retained internally,
 * but is authoritative here as the number of successful Dungeon Entered events.
 */
export async function logRunPhysicalKeys(
    input: LogRunPhysicalKeysInput,
    client: PoolClient
): Promise<LogRunPhysicalKeysResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
        throw new RunPhysicalKeyLogError('Physical key amount must be a positive integer.');
    }
    const runResult = await client.query<RunRow>(
        `SELECT guild_id, status, run_kind, key_pop_count
         FROM run
         WHERE id = $1::bigint
         FOR UPDATE`,
        [input.runId]
    );
    const run = runResult.rows[0];
    if (!run) throw new RunPhysicalKeyLogError('Run not found.');
    if (run.guild_id !== input.guildId) throw new RunPhysicalKeyLogError('Run does not belong to this server.');
    if (run.status !== 'ended') throw new RunPhysicalKeyLogError('Physical run keys can only be logged after the run ends.');
    if (run.run_kind === 'oryx_3') throw new RunPhysicalKeyLogError('Oryx 3 uses its existing rune and incantation logging flow.');
    if (isAggregateActivityKey(input.dungeonKey) || input.dungeonKey === 'REALM_DUNGEON') {
        throw new RunPhysicalKeyLogError('Choose an actual physical dungeon key from this run.');
    }

    const selectionResult = await client.query(
        `SELECT 1
         FROM run_dungeon_selection
         WHERE run_id = $1::bigint AND dungeon_key = $2`,
        [input.runId, input.dungeonKey]
    );
    if (selectionResult.rowCount === 0) {
        throw new RunPhysicalKeyLogError('That dungeon was not selected for this run.');
    }

    const enteredCount = Number(run.key_pop_count);
    if (!Number.isSafeInteger(enteredCount) || enteredCount < 0) {
        throw new RunPhysicalKeyLogError('Run has an invalid Dungeon Entered count.');
    }
    // Keep the established key_pop prefix so canonical activity recovery always
    // recognizes these as physical-key points, never dungeon completion activity.
    const requestSubjectPrefix = `key_pop:run:${input.runId}:${input.interactionId}`;
    const duplicateResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint
           AND action_type = 'run_completed'
           AND subject_id LIKE $2`,
        [input.guildId, `${requestSubjectPrefix}:%`]
    );
    const duplicateCount = Number(duplicateResult.rows[0]?.count ?? 0);

    const loggedResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM quota_event
         WHERE guild_id = $1::bigint
           AND action_type = 'run_completed'
           AND subject_id LIKE $2`,
        [input.guildId, `key_pop:run:${input.runId}:%`]
    );
    const alreadyLogged = Number(loggedResult.rows[0]?.count ?? 0);

    if (duplicateCount > 0) {
        const currentKeyResult = await client.query<{ count: number }>(
            `SELECT count FROM key_pop
             WHERE guild_id = $1::bigint AND user_id = $2::bigint
               AND dungeon_key = $3 AND key_type = 'key'`,
            [input.guildId, input.userId, input.dungeonKey]
        );
        return {
            logged: 0,
            newTotal: currentKeyResult.rows[0]?.count ?? 0,
            pointsAwarded: 0,
            remainingAllowance: Math.max(0, enteredCount - alreadyLogged),
            duplicate: true,
        };
    }

    if (alreadyLogged + input.amount > enteredCount) {
        throw new RunPhysicalKeyLogError(
            `Cannot log ${input.amount} keys; only ${Math.max(0, enteredCount - alreadyLogged)} remain in this run's allowance.`
        );
    }

    let pointsAwarded = 0;
    for (let index = 1; index <= input.amount; index += 1) {
        const event = await client.query<{ points: number | string }>(
            `INSERT INTO quota_event
                (guild_id, actor_user_id, action_type, subject_id, dungeon_key, points, quota_points)
             VALUES ($1::bigint, $2::bigint, 'run_completed', $3, $4, $5, 0)
             ON CONFLICT (guild_id, subject_id)
                 WHERE action_type = 'run_completed' AND subject_id IS NOT NULL
             DO NOTHING
             RETURNING points`,
            [
                input.guildId,
                input.userId,
                `${requestSubjectPrefix}:${index}`,
                input.dungeonKey,
                input.pointsPerKey,
            ]
        );
        pointsAwarded += Number(event.rows[0]?.points ?? 0);
    }

    const keyResult = await client.query<{ count: number }>(
        `INSERT INTO key_pop (guild_id, user_id, dungeon_key, key_type, count, last_popped_at)
         VALUES ($1::bigint, $2::bigint, $3, 'key', $4, now())
         ON CONFLICT (guild_id, user_id, dungeon_key, key_type)
         DO UPDATE SET count = key_pop.count + EXCLUDED.count, last_popped_at = now()
         RETURNING count`,
        [input.guildId, input.userId, input.dungeonKey, input.amount]
    );

    return {
        logged: input.amount,
        newTotal: keyResult.rows[0]?.count ?? 0,
        pointsAwarded,
        remainingAllowance: enteredCount - alreadyLogged - input.amount,
        duplicate: false,
    };
}

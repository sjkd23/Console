import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { logRunPhysicalKeys, RunPhysicalKeyLogError } from './run-physical-key-logging.js';

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

function makeClient(options: { entered?: number; alreadyLogged?: number; duplicate?: number } = {}) {
    const query = vi.fn(async (sql: string, _parameters?: readonly unknown[]) => {
        if (sql.includes('FROM run\n')) return result([{ guild_id: '1', status: 'ended', run_kind: 'multi_exalt', key_pop_count: options.entered ?? 3 }]);
        if (sql.includes('FROM run_dungeon_selection')) return result([{ '?column?': 1 }]);
        if (sql.includes('subject_id LIKE') && String(_parameters?.[1]).includes('key_pop:run:42:999:%')) {
            return result([{ count: String(options.duplicate ?? 0) }]);
        }
        if (sql.includes('subject_id LIKE')) return result([{ count: String(options.alreadyLogged ?? 0) }]);
        if (sql.includes('INSERT INTO quota_event')) return result([{ points: 5 }]);
        if (sql.includes('INSERT INTO key_pop')) return result([{ count: 7 }]);
        if (sql.includes('SELECT count FROM key_pop')) return result([{ count: 7 }]);
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    return { client: { query } as unknown as PoolClient, query };
}

const input = {
    runId: '42',
    guildId: '1',
    userId: '2',
    dungeonKey: 'NEST',
    amount: 2,
    interactionId: '999',
    pointsPerKey: 5,
};

describe('run physical key logging allowance', () => {
    it('logs selected physical keys transactionally within the entered count', async () => {
        const { client, query } = makeClient();
        await expect(logRunPhysicalKeys(input, client)).resolves.toEqual({
            logged: 2,
            newTotal: 7,
            pointsAwarded: 10,
            remainingAllowance: 1,
            duplicate: false,
        });
        const insertedSubjects = query.mock.calls
            .filter(([sql]) => String(sql).includes('INSERT INTO quota_event'))
            .map(([, parameters]) => (parameters as unknown[])[2]);
        expect(insertedSubjects).toEqual([
            'key_pop:run:42:999:1',
            'key_pop:run:42:999:2',
        ]);
    });

    it('rejects logging beyond the authoritative entered count', async () => {
        const { client } = makeClient({ entered: 3, alreadyLogged: 2 });
        await expect(logRunPhysicalKeys(input, client)).rejects.toThrow(/only 1 remain/i);
    });

    it('treats a repeated interaction as an idempotent no-op', async () => {
        const { client } = makeClient({ duplicate: 2, alreadyLogged: 2 });
        await expect(logRunPhysicalKeys(input, client)).resolves.toMatchObject({
            logged: 0,
            duplicate: true,
            remainingAllowance: 1,
        });
    });

    it.each(['MISC_DUNGEONS', 'EXALTATION_DUNGEONS', 'REALM_DUNGEON'])(
        'rejects non-physical key ledger value %s',
        async dungeonKey => {
            const { client } = makeClient();
            await expect(logRunPhysicalKeys({ ...input, dungeonKey }, client))
                .rejects.toBeInstanceOf(RunPhysicalKeyLogError);
        }
    );
});

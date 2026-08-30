export function normalizeRunId(value: unknown): number {
    const runId = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value)
            ? Number(value)
            : Number.NaN;

    if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new Error(`Invalid or unsafe run ID returned by PostgreSQL: ${String(value)}`);
    }

    return runId;
}

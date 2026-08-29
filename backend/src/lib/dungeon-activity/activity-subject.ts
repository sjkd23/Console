export function organizerKeyPopActivitySubjectId(runId: string | number, keyPopNumber: number): string {
    return `run:${runId}:keypop:${keyPopNumber}:organizer`;
}

export function organizerRunActivitySubjectId(runId: string | number, dungeonStatsKey: string): string {
    return dungeonStatsKey === 'ORYX_3'
        ? `run:${runId}:o3:organizer`
        : `run:${runId}:completion:organizer`;
}

export function raiderKeyPopActivitySubjectId(
    runId: string | number,
    keyPopNumber: number,
    userId: string
): string {
    return `run:${runId}:keypop:${keyPopNumber}:raider:${userId}`;
}

export function raiderParticipantActivitySubjectId(runId: string | number, userId: string): string {
    return `run:${runId}:completion:raider:${userId}`;
}

export function manualRunActivitySubjectId(quotaSubjectId: string): string {
    return `${quotaSubjectId}:organizer`;
}

export function ambiguousHistoricalActivitySubjectId(quotaEventId: string, role: 'organizer' | 'raider'): string {
    return `backfill:quota_event:${quotaEventId}:${role}`;
}

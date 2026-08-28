import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const serviceSource = readFileSync(resolve(process.cwd(), 'src/lib/services/quota-period-service.ts'), 'utf8');
const migrationSource = readFileSync(resolve(process.cwd(), 'src/db/migrations/059_quota_periods.sql'), 'utf8');
const correctiveMigrationSource = readFileSync(resolve(process.cwd(), 'src/db/migrations/061_correct_quota_period_transition.sql'), 'utf8');
const quotaSource = readFileSync(resolve(process.cwd(), 'src/lib/quota/quota.ts'), 'utf8');

describe('quota period persistence invariants', () => {
    it('never creates synthetic quota events', () => {
        expect(serviceSource).not.toMatch(/INSERT\s+INTO\s+quota_event/i);
    });

    it('uses the exact role and half-open persisted event window', () => {
        expect(serviceSource).toContain('quota_role_id = $2::bigint');
        expect(serviceSource).toContain('created_at >= $3::timestamptz');
        expect(serviceSource).toContain('created_at < $4::timestamptz');
    });

    it('constrains active periods, successors, and member results for retry safety', () => {
        expect(migrationSource).toContain('idx_quota_period_one_active');
        expect(migrationSource).toContain('idx_quota_period_one_successor');
        expect(migrationSource).toContain('PRIMARY KEY (period_id, user_id)');
    });

    it('removes the legacy overdue-to-now period helpers', () => {
        expect(quotaSource).not.toContain('getQuotaPeriodStart');
        expect(quotaSource).not.toContain('getQuotaPeriodEnd');
    });

    it('ranks the live leaderboard by current-period earnings without carry', () => {
        expect(serviceSource).toContain('ORDER BY COALESCE(earned.earned_points, 0) DESC');
        expect(serviceSource).not.toContain('ORDER BY COALESCE(earned.earned_points, 0) + COALESCE(carry.carry_in, 0) DESC');
    });

    it('treats zero-point configs as inactive at initialization, scan, and creation', () => {
        expect(migrationSource).toContain('WHERE config.required_points > 0');
        expect(serviceSource).toContain('if (Number(config.required_points) <= 0)');
        expect(serviceSource).toContain('WHERE config.required_points > 0');
    });

    it('cannot perpetuate a zero-point successor chain', () => {
        expect(serviceSource).toContain('if (Number(config.required_points) > 0)');
        expect(serviceSource).toContain("closeReason: 'deactivated'");
        expect(serviceSource).toContain('createSuccessor: false');
    });

    it('seeds only active transition roots and never migration-generated finalized logs', () => {
        expect(migrationSource).toContain("NULL,\n    'active'");
        expect(migrationSource).not.toMatch(/INSERT INTO quota_period[\s\S]*?'finalized'/);
        expect(migrationSource).not.toContain('INSERT INTO quota_period_member_result');
    });

    it('corrective cleanup preserves raw events/config while removing faulty feature rows', () => {
        expect(correctiveMigrationSource).toContain('TRUNCATE TABLE quota_period_member_result, quota_period');
        expect(correctiveMigrationSource).not.toMatch(/(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?quota_event/i);
        expect(correctiveMigrationSource).not.toMatch(/(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?quota_role_config/i);
    });

    it('ordinary log retry excludes already-posted periods', () => {
        expect(serviceSource).toContain('AND quota_log_posted_at IS NULL');
        expect(serviceSource).toContain('AND required_points > 0');
    });
});

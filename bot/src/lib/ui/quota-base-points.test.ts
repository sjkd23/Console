import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuotaBasePointsModal, QuotaBasePointsSchema, minuteQuotaPointSource, MINUTE_QUOTA_LABEL } from './quota-base-points.js';
import { DecimalPointsSchema } from '../utilities/decimal-points.js';
import { OrganizerMinuteQuotaSchema } from '../utilities/minute-quota-contract.js';
import { buildQuotaConfigPanel } from './quota-config-panel.js';

describe('minute configuration and backend contract', () => {
    it('displays the configured rate even when quota automation is inactive', async context => {
        context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
            config: { required_points: 0, reset_interval_days: 7, rollover_enabled: false,
                base_exalt_points: 1, base_non_exalt_points: 0, misc_points_per_minute: 0.1 },
            active_period: null, dungeon_overrides: {},
        }), { status: 200 }));
        const panel = await buildQuotaConfigPanel('1', '2');
        assert.ok(panel.embed.toJSON().fields?.some(field => field.name === MINUTE_QUOTA_LABEL && field.value === '0.1/min'));
        assert.ok(panel.embed.toJSON().fields?.some(field => field.name.includes('Base Non-Exalt') && field.value === '0'));
        assert.match(panel.embed.toJSON().description ?? '', /single non-exalt runs, Realm Clearing, and multi non-exalt runs/);
    });
    it('prefills the shared 0.10 default and preserves configured zero', () => {
        const defaults = buildQuotaBasePointsModal('1', '2', null).toJSON();
        assert.match(JSON.stringify(defaults), /"value":"0.10"/);
        assert.match(JSON.stringify(defaults), /"custom_id":"base_non_exalt_points"[^}]*"value":"0.00"/);
        const configured = buildQuotaBasePointsModal('1', '2', {
            base_exalt_points: 0, base_non_exalt_points: 0, misc_points_per_minute: 0,
        }).toJSON();
        assert.equal((JSON.stringify(configured).match(/"value":"0.00"/g) ?? []).length, 3);
        assert.equal(minuteQuotaPointSource(0), '**Non-Exalt Dungeons:** 0/min');
        assert.equal(minuteQuotaPointSource(0.1), '**Non-Exalt Dungeons:** 0.1/min');
    });
    it('validates all three modal fields as entire decimal inputs', () => {
        assert.deepEqual(QuotaBasePointsSchema.parse({
            base_exalt_points: '0.29', base_non_exalt_points: '0.57', misc_points_per_minute: '0.10',
        }), { base_exalt_points: 0.29, base_non_exalt_points: 0.57, misc_points_per_minute: 0.1 });
        for (const value of [0, 0.1, 0.29, 0.57, 1.1, '0.10']) assert.equal(DecimalPointsSchema.parse(value), Number(value));
        for (const value of ['0.1abc', 'NaN', 'Infinity', '-0.1', '0.001', '0.100', '100000000', '', NaN, Infinity]) {
            assert.equal(DecimalPointsSchema.safeParse(value).success, false);
        }
    });
    it('preserves null versus zero and trusts the backend maximum rather than recomputing it', () => {
        const empty = { eligible: false, snapshottedRate: null, quotaRoleId: null,
            maxWholeMinutes: null, maxPoints: null, invalidReason: null };
        assert.deepEqual(OrganizerMinuteQuotaSchema.parse(empty), empty);
        const completed = { ...empty, eligible: true, snapshottedRate: 0.1, quotaRoleId: '123', maxWholeMinutes: 3, maxPoints: 0.3 };
        assert.deepEqual(OrganizerMinuteQuotaSchema.parse(completed), completed);
        assert.equal(OrganizerMinuteQuotaSchema.parse({ ...completed, snapshottedRate: 0, maxPoints: 0 }).snapshottedRate, 0);
        assert.equal(OrganizerMinuteQuotaSchema.safeParse({ ...completed, maxWholeMinutes: 1.5 }).success, false);
        assert.equal(OrganizerMinuteQuotaSchema.safeParse({ ...completed, maxPoints: 100000000 }).success, false);
    });
});

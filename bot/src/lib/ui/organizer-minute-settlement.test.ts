import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { formatNonExaltRunTime } from '../../commands/stats.js';
import type { OrganizerMinuteSettlement } from '../utilities/organizer-minute-settlement-contract.js';
import {
    buildMinuteModifyModal,
    buildMinuteRecordDm,
    buildMinuteRecordLog,
    buildMinuteSettlementMessage,
    sendMinuteRecordDm,
} from './organizer-minute-settlement.js';

function settlement(overrides: Partial<OrganizerMinuteSettlement> = {}): OrganizerMinuteSettlement {
    return {
        runId: 12345,
        guildId: '100000000000000001',
        organizerId: '100000000000000002',
        runKind: 'realm_clearing',
        runLabel: 'Realm Clearing',
        quotaRoleId: '100000000000000003',
        rate: 0.1,
        maxMinutes: 45,
        selectedMinutes: 45,
        selectedPoints: 4.5,
        maxPoints: 4.5,
        status: 'pending',
        revision: 0,
        createdAt: '2026-09-03T00:00:00.000Z',
        updatedAt: '2026-09-03T00:00:00.000Z',
        resolvedAt: null,
        quotaEventId: null,
        quotaEventCreatedAt: null,
        ...overrides,
    };
}

describe('organizer minute settlement UI', () => {
    it('renders the initial maximum and trusted run/revision-only controls', () => {
        const message = buildMinuteSettlementMessage(settlement());
        const json = message.embeds[0].toJSON();
        assert.match(json.description ?? '', /Run duration:\*\* 45 minutes/);
        assert.doesNotMatch(json.description ?? '', /Logging:|Selected:|whole/i);
        assert.match(json.description ?? '', /4\.5 quota points/);
        assert.match(json.description ?? '', /Click Confirm if this is accurate, Modify to change the number of minutes you want to log, or Cancel to skip logging these minutes\./);
        assert.deepEqual(message.components[0].components.map(component => {
            const json = component.toJSON();
            return 'custom_id' in json ? json.custom_id : undefined;
        }), [
            'minute:confirm:12345:0', 'minute:modify:12345:0', 'minute:cancel:12345',
        ]);
    });

    it('distinguishes modified logged minutes, pluralizes naturally, and keeps terminal receipts concise', () => {
        const one = buildMinuteSettlementMessage(settlement({ maxMinutes: 1, selectedMinutes: 1, selectedPoints: 0.1 }));
        assert.match(one.embeds[0].toJSON().description ?? '', /1 minute/);
        const two = buildMinuteSettlementMessage(settlement({ maxMinutes: 2, selectedMinutes: 2, selectedPoints: 1 }));
        assert.match(two.embeds[0].toJSON().description ?? '', /2 minutes/);
        const modified = buildMinuteSettlementMessage(settlement({ revision: 1, selectedMinutes: 30, selectedPoints: 3 }));
        const modifiedDescription = modified.embeds[0].toJSON().description ?? '';
        assert.match(modifiedDescription, /Run duration:\*\* 45 minutes/);
        assert.match(modifiedDescription, /Logging:\*\* 30 minutes/);
        assert.doesNotMatch(modifiedDescription, /whole|selected_minutes|maximum eligible/i);
        const confirmed = buildMinuteSettlementMessage(settlement({ status: 'confirmed', selectedMinutes: 15, selectedPoints: 1.5 }));
        assert.match(confirmed.embeds[0].toJSON().description ?? '', /Awarded \*\*1\.5 quota points\*\* for \*\*15 minutes\*\*/);
        assert.deepEqual(confirmed.components, []);
        const cancelled = buildMinuteSettlementMessage(settlement({ status: 'cancelled' }));
        assert.equal(cancelled.embeds[0].toJSON().description, 'Minute logging cancelled. No minute quota points were awarded.');
        assert.deepEqual(cancelled.components, []);
    });

    it('builds a restart-safe modify modal with only run ID and revision', () => {
        const modal = buildMinuteModifyModal(12345, 7, 20).toJSON();
        assert.equal(modal.custom_id, 'minute:submit:12345:7');
        const row = modal.components[0];
        assert.ok('components' in row);
        const input = row.components[0];
        assert.ok('value' in input);
        assert.equal(input.value, '20');
        assert.equal('label' in input ? input.label : undefined, 'Minutes to log');
    });

    it('renders organizer, staff, and automatic recovery DMs from the authoritative receipt', () => {
        const backup = buildMinuteRecordDm(settlement(), 'organizer_end').embeds[0].toJSON().description ?? '';
        assert.match(backup, /Realm Clearing/);
        assert.match(backup, /45 minutes/);
        assert.match(backup, /4\.5 quota points/);
        assert.match(backup, /0\.1\/min/);
        assert.match(backup, /Run reference:\*\* 12345/);
        assert.match(backup, /\/logminutes run:12345 minutes:45/);
        assert.doesNotMatch(backup, /whole|upper staff|contact.*staff/i);
        for (const endType of ['staff_end', 'automatic_end'] as const) {
            const recovery = buildMinuteRecordDm(settlement(), endType).embeds[0].toJSON().description ?? '';
            assert.match(recovery, /ended without your minute logging prompt/);
            assert.match(recovery, /\/logminutes run:12345 minutes:45/);
            assert.doesNotMatch(recovery, /whole|upper staff|contact.*staff/i);
        }
    });

    it('logs one operational record only after a successful DM', async () => {
        let logCalls = 0;
        const client = {
            users: { fetch: async () => ({ send: async () => undefined }) },
        } as unknown as Client;
        const delivered = await sendMinuteRecordDm(client, settlement(), 'staff_end', {
            logDelivery: async () => { logCalls += 1; },
        });
        assert.equal(delivered, true);
        assert.equal(logCalls, 1);

        const record = buildMinuteRecordLog(settlement(), 'staff_end');
        const rendered = JSON.stringify(record);
        assert.match(rendered, /100000000000000002/);
        assert.match(rendered, /Realm Clearing/);
        assert.match(rendered, /12345/);
        assert.match(rendered, /45 minutes/);
        assert.match(rendered, /0\.1\/min/);
        assert.match(rendered, /4\.5 points/);
        assert.match(rendered, /Staff End/);
        assert.doesNotMatch(rendered, /\/logminutes|recover|contact/i);
    });

    it('does not log a failed DM and treats delivery and bot-log failures as harmless', async () => {
        let failedDmLogCalls = 0;
        const client = {
            users: { fetch: async () => ({ send: async () => { throw new Error('DM closed'); } }) },
        } as unknown as Client;
        const delivered = await sendMinuteRecordDm(client, settlement(), 'organizer_end', {
            logDelivery: async () => { failedDmLogCalls += 1; },
        });
        assert.equal(delivered, false);
        assert.equal(failedDmLogCalls, 0);

        let sends = 0;
        const successfulClient = {
            users: { fetch: async () => ({ send: async () => { sends += 1; } }) },
        } as unknown as Client;
        await assert.doesNotReject(sendMinuteRecordDm(successfulClient, settlement(), 'automatic_end', {
            logDelivery: async () => { throw new Error('bot-log unavailable'); },
        }));
        assert.equal(sends, 1);
    });

    it('formats actual non-exalt run time for /stats', () => {
        assert.equal(formatNonExaltRunTime(0), '0 minutes');
        assert.equal(formatNonExaltRunTime(1), '1 minute');
        assert.equal(formatNonExaltRunTime(59), '59 minutes');
        assert.equal(formatNonExaltRunTime(60), '1h (60 minutes)');
        assert.equal(formatNonExaltRunTime(61), '1h 1m (61 minutes)');
        assert.equal(formatNonExaltRunTime(237), '3h 57m (237 minutes)');
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { setchannels } from '../../commands/configs/setchannels.js';
import {
    buildActiveRunsComponents,
    buildActiveRunsEmbed,
    buildActiveRunsMirror,
    isActiveRunsStatus,
} from './active-runs-mirror.js';

const dungeon = dungeonByCode.NEST;
if (!dungeon) throw new Error('NEST test dungeon metadata is missing.');

const startingRun = {
    id: 42,
    status: 'open' as const,
    runKind: 'single' as const,
    selectedDungeons: [{ dungeonKey: 'NEST', dungeonLabel: 'The Nest', selectionOrder: 1 }],
    organizerId: '100000000000000001',
    party: '2',
    location: 'USWest',
    o3Stage: null,
};

describe('Active Runs configuration', () => {
    it('adds Active Runs to /setchannels without removing existing channel options', () => {
        const options = setchannels.data.toJSON().options ?? [];
        const names = options.map(option => option.name);
        assert.ok(names.includes('raid'));
        assert.ok(names.includes('active_runs'));
        assert.ok(names.includes('raid_log'));
    });
});

describe('Active Runs mirror rendering', () => {
    it('shows dungeon, party, location, and organizer without redundant status or link fields', () => {
        const raidPanelUrl = 'https://discord.com/channels/1/2/3';
        const data = buildActiveRunsEmbed({
            run: startingRun,
            dungeons: [dungeon],
            raidPanelUrl,
        }).toJSON();
        const fields = new Map((data.fields ?? []).map(field => [field.name, field.value]));

        assert.match(data.title ?? '', /Starting Soon: The Nest/);
        assert.equal(fields.get('Dungeon'), 'The Nest');
        assert.equal(fields.get('Party'), '2');
        assert.equal(fields.get('Location'), 'USWest');
        assert.equal(fields.has('Status'), false);
        assert.equal(fields.get('Organizer'), '<@100000000000000001>');
        assert.equal(fields.has('Raid Panel'), false);
        assert.equal(data.color, dungeon.dungeonColors?.[0]);
        assert.equal(data.thumbnail?.url, dungeon.portalLink?.url);
    });

    it('uses the existing LIVE terminology after the run starts', () => {
        const data = buildActiveRunsEmbed({
            run: { ...startingRun, status: 'live' },
            dungeons: [dungeon],
            raidPanelUrl: 'https://discord.com/channels/1/2/3',
        }).toJSON();
        assert.match(data.title ?? '', /LIVE: The Nest/);
        assert.equal(data.fields?.some(field => field.name === 'Status'), false);
    });

    it('shows live Oryx 3 location and party while the realm is open', () => {
        const o3 = dungeonByCode.ORYX_3;
        if (!o3) throw new Error('ORYX_3 test dungeon metadata is missing.');
        const data = buildActiveRunsEmbed({
            run: {
                ...startingRun,
                status: 'live',
                runKind: 'oryx_3',
                selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
                party: '3/4',
                location: 'USWest',
            },
            dungeons: [o3],
            raidPanelUrl: 'https://discord.com/channels/1/2/3',
        }).toJSON();
        const fields = new Map((data.fields ?? []).map(field => [field.name, field.value]));

        assert.match(data.title ?? '', /LIVE: Oryx 3/);
        assert.equal(fields.has('Status'), false);
        assert.equal(fields.get('Party'), '3/4');
        assert.equal(fields.get('Location'), 'USWest');
    });

    it('shows closed Oryx 3 state without persisted live-only location or party fields', () => {
        const o3 = dungeonByCode.ORYX_3;
        if (!o3) throw new Error('ORYX_3 test dungeon metadata is missing.');
        const data = buildActiveRunsEmbed({
            run: {
                ...startingRun,
                status: 'live',
                runKind: 'oryx_3',
                selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
                party: '3/4',
                location: 'USWest',
                o3Stage: 'closed',
            },
            dungeons: [o3],
            raidPanelUrl: 'https://discord.com/channels/1/2/3',
        }).toJSON();
        const rendered = JSON.stringify(data);
        const fields = new Map((data.fields ?? []).map(field => [field.name, field.value]));

        assert.match(data.title ?? '', /Closed: Oryx 3/);
        assert.equal(fields.has('Status'), false);
        assert.equal(fields.has('Party'), false);
        assert.equal(fields.has('Location'), false);
        assert.doesNotMatch(rendered, /3\/4|USWest|Party|Location/);
    });

    it('does not apply the Oryx 3 privacy rule to unrelated dungeons', () => {
        const data = buildActiveRunsEmbed({
            run: { ...startingRun, status: 'live', o3Stage: 'closed' },
            dungeons: [dungeon],
            raidPanelUrl: 'https://discord.com/channels/1/2/3',
        }).toJSON();
        const fields = new Map((data.fields ?? []).map(field => [field.name, field.value]));

        assert.equal(fields.has('Status'), false);
        assert.equal(fields.get('Party'), '2');
        assert.equal(fields.get('Location'), 'USWest');
    });

    it('contains only Organizer Panel and Jump to Raid controls', () => {
        const raidPanelUrl = 'https://discord.com/channels/1/2/3';
        const rows = buildActiveRunsComponents(startingRun.id, raidPanelUrl).map(row => row.toJSON());
        const buttons = rows.flatMap(row => row.components);
        assert.equal(buttons.length, 2);
        const organizerButton = buttons.find(button => 'custom_id' in button);
        const jumpButton = buttons.find(button => 'url' in button);
        assert.ok(organizerButton && 'custom_id' in organizerButton);
        assert.equal(organizerButton.custom_id, 'run:org:42');
        assert.equal(organizerButton.label, 'Organizer Panel');
        assert.ok(jumpButton && 'url' in jumpButton);
        assert.equal(jumpButton.label, 'Jump to Raid');
        assert.equal(jumpButton.url, raidPanelUrl);
        const labels = buttons.map(button => 'label' in button ? button.label ?? '' : '');
        assert.ok(!labels.some(label => /join|leave|key|interest/i.test(label)));
    });

    it('has no normal message content and disables all mention parsing', () => {
        const payload = buildActiveRunsMirror({
            run: startingRun,
            dungeons: [dungeon],
            raidPanelUrl: 'https://discord.com/channels/1/2/3',
        });
        assert.equal(Object.hasOwn(payload, 'content'), false);
        assert.equal(Object.hasOwn(payload, 'files'), false);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.ok(!JSON.stringify(payload).includes('@here'));
        assert.ok(!JSON.stringify(payload).includes('<@&'));
    });

    it('includes only open and live run states', () => {
        assert.equal(isActiveRunsStatus('open'), true);
        assert.equal(isActiveRunsStatus('live'), true);
        assert.equal(isActiveRunsStatus('ended'), false);
    });
});

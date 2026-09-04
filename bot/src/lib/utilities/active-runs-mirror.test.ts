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
    it('shows dungeon, party, location, status, and organizer without a duplicate link field', () => {
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
        assert.equal(fields.get('Status'), 'Starting Soon');
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
        const status = data.fields?.find(field => field.name === 'Status');
        assert.match(data.title ?? '', /LIVE: The Nest/);
        assert.equal(status?.value, 'LIVE');
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

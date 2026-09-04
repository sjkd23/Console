import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ButtonStyle } from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import {
    buildHeadcountActionRows,
    buildHeadcountInterestSummary,
} from './headcount-components.js';

interface TestButtonData {
    custom_id: string;
    label?: string;
    style: number;
}

function getButtonData(button: { toJSON(): unknown }): TestButtonData {
    const data = button.toJSON();
    assert.ok(typeof data === 'object' && data !== null);
    assert.ok('custom_id' in data && typeof data.custom_id === 'string');
    assert.ok('style' in data && typeof data.style === 'number');
    assert.ok(!('label' in data) || typeof data.label === 'string');
    return data as TestButtonData;
}

function getDungeons(codes: readonly string[]): DungeonInfo[] {
    return codes.map(code => {
        const dungeon = dungeonByCode[code];
        assert.ok(dungeon, `Missing test dungeon ${code}`);
        return dungeon;
    });
}

describe('headcount public controls', () => {
    it('renders a single green dungeon-name interest button above its key button', () => {
        const rows = buildHeadcountActionRows(getDungeons(['FUNGAL_CAVERN']), 'token');
        const json = rows.map(row => row.components.map(getButtonData));

        assert.equal(json[0][0].label, 'Fungal Cavern');
        assert.equal(json[0][0].style, ButtonStyle.Success);
        assert.equal(json[0][0].custom_id, 'headcount:interest:token:FUNGAL_CAVERN');
        assert.match(json[1][0].custom_id, /^headcount:key:token:FUNGAL_CAVERN:/);
    });

    it('renders one ordered interest button per dungeon with ordered keys directly below', () => {
        const dungeonCodes = ['NEST', 'FUNGAL_CAVERN', 'STEAMWORKS'];
        const rows = buildHeadcountActionRows(getDungeons(dungeonCodes), 'ordered');
        const json = rows.map(row => row.components.map(getButtonData));

        assert.deepEqual(
            json[0].map(component => component.label),
            ['Nest', 'Fungal Cavern', 'Steamworks']
        );
        assert.ok(json[0].every(component => component.style === ButtonStyle.Success));
        assert.deepEqual(
            json[1].map(component => component.custom_id.split(':')[3]),
            dungeonCodes
        );
        assert.ok(json.flat().every(component => component.label !== 'Join'));
        assert.ok(json.flat().every(component => component.label !== 'Interested'));
    });

    it('keeps the maximum supported five dungeons and multi-key offers within Discord limits', () => {
        const rows = buildHeadcountActionRows(
            getDungeons(['ORYX_3', 'LOST_HALLS', 'THE_VOID', 'NEST', 'FUNGAL_CAVERN']),
            'limits'
        );

        assert.ok(rows.length <= 5);
        assert.ok(rows.every(row => row.components.length <= 5));
        assert.throws(
            () => buildHeadcountActionRows(
                getDungeons(['ORYX_3', 'LOST_HALLS', 'THE_VOID', 'NEST', 'FUNGAL_CAVERN', 'STEAMWORKS']),
                'too-many'
            ),
            /between 1 and 5 dungeons/
        );
    });

    it('displays per-dungeon counts without exposing interested user names', () => {
        const summary = buildHeadcountInterestSummary(
            ['LOST_HALLS', 'FUNGAL_CAVERN'],
            new Map([
                ['LOST_HALLS', new Set(['user-1', 'user-2'])],
                ['FUNGAL_CAVERN', new Set(['user-2'])],
            ])
        );

        assert.equal(summary,
            '**Lost Halls:** 2 interested\n' +
            '**Fungal Cavern:** 1 interested');
        assert.doesNotMatch(summary, /<@/);
        assert.doesNotMatch(summary, /user-/);
    });
});

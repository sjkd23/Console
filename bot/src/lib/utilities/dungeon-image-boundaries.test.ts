import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('dungeon image publication boundaries', () => {
    it('keeps single- and multi-dungeon headcount creation outside the image path', () => {
        const headcountSource = source('../../commands/organizer/headcount.ts');
        assert.doesNotMatch(headcountSource, /getDungeonImage|dungeon-images|publishCreatedRun/);
    });

    it('keeps the Active Runs mirror outside the image path', () => {
        const mirrorSource = source('./active-runs-mirror.ts');
        assert.doesNotMatch(mirrorSource, /getDungeonImage|dungeon-images/);
    });

    it('routes headcount-converted run panels through the shared publication path', () => {
        const conversionSource = source('../../interactions/buttons/raids/headcount-convert.ts');
        assert.match(conversionSource, /publishCreatedRun/);
        assert.doesNotMatch(conversionSource, /getDungeonImage|AttachmentBuilder/);
    });
});

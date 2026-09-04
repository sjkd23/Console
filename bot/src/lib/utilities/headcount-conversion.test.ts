import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import {
    buildHeadcountConversionOptions,
    collectSelectedDungeonKeyOffers,
    getHeadcountConversionEndState,
    getHeadcountConversionMode,
    getConversionOrganizerUsername,
    MULTI_DUNGEON_HEADCOUNT_TITLE,
    retireConvertedHeadcountMessage,
    validateHeadcountConversionFreshness,
    validateHeadcountRunSubset,
} from './headcount-conversion.js';

function dungeons(...codes: string[]): DungeonInfo[] {
    return codes.map(code => {
        const dungeon = dungeonByCode[code];
        assert.ok(dungeon, `missing fixture dungeon ${code}`);
        return dungeon;
    });
}

describe('headcount to run selection policy', () => {
    it('uses a normal hyphen in the multi-dungeon headcount title', () => {
        assert.equal(MULTI_DUNGEON_HEADCOUNT_TITLE, '🎯 Headcount - Multiple Dungeons');
        assert.equal(MULTI_DUNGEON_HEADCOUNT_TITLE.includes('—'), false);
    });

    it('requires explicit selection for every multi-dungeon headcount, including legal all-exalt sets', () => {
        assert.equal(getHeadcountConversionMode(dungeons('NEST')), 'direct');
        assert.equal(getHeadcountConversionMode(dungeons('NEST', 'FUNGAL_CAVERN', 'STEAMWORKS')), 'select');
    });

    it('exposes every mixed-headcount dungeon with none selected by default', () => {
        const available = dungeons('REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3');
        const options = buildHeadcountConversionOptions(available, []);

        assert.deepEqual(options.map(option => option.value), [
            'REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3',
        ]);
        assert.ok(options.every(option => option.default === false));
    });

    it('accepts legal explicit subsets', () => {
        const available = dungeons('REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3');

        assert.equal(validateHeadcountRunSubset(available, ['REALM_DUNGEON']), null);
        assert.equal(validateHeadcountRunSubset(available, ['REALM_DUNGEON', 'SNAKE_PIT']), null);
        assert.equal(validateHeadcountRunSubset(available, ['NEST']), null);
        assert.equal(validateHeadcountRunSubset(available, ['SNAKE_PIT']), null);
        assert.equal(validateHeadcountRunSubset(available, ['ORYX_3']), null);
    });

    it('rejects illegal chosen subsets from an otherwise valid mixed headcount', () => {
        const available = dungeons('REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3');

        assert.match(validateHeadcountRunSubset(available, ['REALM_DUNGEON', 'NEST']) ?? '', /cannot mix/i);
        assert.match(validateHeadcountRunSubset(available, ['REALM_DUNGEON', 'ORYX_3']) ?? '', /alone/i);
        assert.match(validateHeadcountRunSubset(available, ['NEST', 'SNAKE_PIT']) ?? '', /cannot mix/i);
        assert.match(validateHeadcountRunSubset(available, ['ORYX_3', 'NEST']) ?? '', /alone/i);
    });

    it('preserves the original headcount on cancel and timeout', () => {
        assert.deepEqual(getHeadcountConversionEndState('cancelled'), {
            preserveHeadcount: true,
            message: 'Conversion cancelled. The headcount remains active.',
        });
        assert.deepEqual(getHeadcountConversionEndState('timeout'), {
            preserveHeadcount: true,
            message: 'Conversion timed out. The headcount remains active.',
        });
    });

    it('transfers only selected-dungeon offers and deduplicates shared user/mapKey offers', () => {
        const offers = new Map([
            ['NEST', new Map([['INC', new Map([['user-1', 2]])]])],
            ['FUNGAL_CAVERN', new Map([['INC', new Map([['user-1', 5], ['user-2', 3]])]])],
            ['SNAKE_PIT', new Map([['SNAKE_KEY', new Map([['user-3', 4]])]])],
        ]);

        assert.deepEqual(collectSelectedDungeonKeyOffers(offers, ['NEST', 'FUNGAL_CAVERN']), [
            { userId: 'user-1', keyType: 'INC', quantity: 5 },
            { userId: 'user-2', keyType: 'INC', quantity: 3 },
        ]);
    });

    it('does not transfer a legacy fake Realm key offer', () => {
        const offers = new Map([
            ['REALM_DUNGEON', new Map([['REALM_DUNGEON_KEY', new Map([['user-1', 1]])]])],
            ['SNAKE_PIT', new Map([['SNAKE_KEY', new Map([['user-2', 2]])]])],
        ]);

        assert.deepEqual(collectSelectedDungeonKeyOffers(offers, ['REALM_DUNGEON', 'SNAKE_PIT']), [
            { userId: 'user-2', keyType: 'SNAKE_KEY', quantity: 2 },
        ]);
    });

    it('rejects confirmation after the headcount ended', () => {
        const available = dungeons('NEST', 'FUNGAL_CAVERN');
        assert.match(validateHeadcountConversionFreshness({
            expectedMessageId: 'headcount-1',
            expectedChannelId: 'channel-1',
            activeHeadcount: null,
            originalDungeonCodes: ['NEST', 'FUNGAL_CAVERN'],
            selectedDungeonCodes: ['NEST'],
            hasActiveRun: false,
        }, available) ?? '', /no longer active/i);
    });

    it('rejects confirmation when another run was created', () => {
        const available = dungeons('NEST', 'FUNGAL_CAVERN');
        assert.match(validateHeadcountConversionFreshness({
            expectedMessageId: 'headcount-1',
            expectedChannelId: 'channel-1',
            activeHeadcount: {
                messageId: 'headcount-1', channelId: 'channel-1',
                dungeonCodes: ['NEST', 'FUNGAL_CAVERN'],
            },
            originalDungeonCodes: ['NEST', 'FUNGAL_CAVERN'],
            selectedDungeonCodes: ['NEST'],
            hasActiveRun: true,
        }, available) ?? '', /active run/i);
    });

    it('rejects a stale selector after its original tracked headcount was replaced', () => {
        const available = dungeons('NEST', 'FUNGAL_CAVERN');
        assert.match(validateHeadcountConversionFreshness({
            expectedMessageId: 'old-headcount',
            expectedChannelId: 'channel-1',
            activeHeadcount: {
                messageId: 'new-headcount', channelId: 'channel-1',
                dungeonCodes: ['NEST', 'FUNGAL_CAVERN'],
            },
            originalDungeonCodes: ['NEST', 'FUNGAL_CAVERN'],
            selectedDungeonCodes: ['NEST'],
            hasActiveRun: false,
        }, available) ?? '', /no longer active/i);
    });

    it('uses the original organizer identity for cross-organizer conversion', () => {
        assert.equal(getConversionOrganizerUsername('original-id', {
            id: 'original-id',
            user: { username: 'OriginalOrganizer' },
        }), 'OriginalOrganizer');
    });

    it('closes an old headcount when deletion fails', async () => {
        let editOptions: unknown;
        const result = await retireConvertedHeadcountMessage({
            delete: async () => { throw new Error('missing permission'); },
            edit: async options => { editOptions = options; },
        });

        assert.equal(result, 'closed');
        assert.deepEqual(editOptions, {
            content: '✅ This headcount was converted to a run.',
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
        });
    });

    it('reports a still-active old headcount when neither delete nor disable succeeds', async () => {
        const result = await retireConvertedHeadcountMessage({
            delete: async () => { throw new Error('delete failed'); },
            edit: async () => { throw new Error('edit failed'); },
        });
        assert.equal(result, 'still_active');
    });
});

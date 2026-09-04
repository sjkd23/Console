import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import {
    clearHeadcountState,
    getDungeonCodes,
    getInterestedUsers,
    resolveHeadcountDungeonCodes,
    setDungeonCodes,
    toggleDungeonInterest,
} from './headcount-state.js';

describe('normalized in-memory headcount selection', () => {
    it('retains ordered dungeon codes independently of public key buttons', () => {
        const messageId = 'headcount-with-no-key-buttons';
        setDungeonCodes(messageId, ['REALM_DUNGEON', 'NEST', 'SNAKE_PIT']);

        assert.deepEqual(getDungeonCodes(new EmbedBuilder(), messageId), [
            'REALM_DUNGEON', 'NEST', 'SNAKE_PIT',
        ]);

        clearHeadcountState(messageId);
        assert.deepEqual(getDungeonCodes(new EmbedBuilder(), messageId), []);
    });

    it('reopens Woodland Labyrinth from stored state despite having no key buttons', () => {
        const messageId = 'woodland-keyless';
        setDungeonCodes(messageId, ['WOODLAND_LABYRINTH']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, []), ['WOODLAND_LABYRINTH']);
        clearHeadcountState(messageId);
    });

    it('reopens Realm Clearing from stored state despite having no key buttons', () => {
        const messageId = 'realm-keyless';
        setDungeonCodes(messageId, ['REALM_DUNGEON']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, []), ['REALM_DUNGEON']);
        clearHeadcountState(messageId);
    });

    it('preserves stored order for mixed keyable and keyless selections', () => {
        const messageId = 'mixed-keyless';
        setDungeonCodes(messageId, ['WOODLAND_LABYRINTH', 'NEST', 'REALM_DUNGEON']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, ['NEST']), [
            'WOODLAND_LABYRINTH', 'NEST', 'REALM_DUNGEON',
        ]);
        clearHeadcountState(messageId);
    });

    it('uses component-derived codes only for legacy unstored panels', () => {
        assert.deepEqual(resolveHeadcountDungeonCodes('legacy-panel', ['NEST', 'SNAKE_PIT']), [
            'NEST', 'SNAKE_PIT',
        ]);
    });
});

describe('per-dungeon headcount interest', () => {
    it('toggles one dungeon without changing another dungeon', () => {
        const messageId = 'independent-dungeons';

        assert.deepEqual(toggleDungeonInterest(messageId, 'LOST_HALLS', 'user-1'), {
            interested: true,
            count: 1,
        });
        assert.equal(getInterestedUsers(messageId, 'FUNGAL_CAVERN').has('user-1'), false);

        toggleDungeonInterest(messageId, 'FUNGAL_CAVERN', 'user-1');
        assert.equal(getInterestedUsers(messageId, 'LOST_HALLS').has('user-1'), true);
        assert.equal(getInterestedUsers(messageId, 'FUNGAL_CAVERN').has('user-1'), true);

        assert.deepEqual(toggleDungeonInterest(messageId, 'LOST_HALLS', 'user-1'), {
            interested: false,
            count: 0,
        });
        assert.equal(getInterestedUsers(messageId, 'FUNGAL_CAVERN').has('user-1'), true);
        clearHeadcountState(messageId);
    });

    it('keeps users independent and cannot create duplicate interest records', () => {
        const messageId = 'independent-users';
        const interestedUsers = getInterestedUsers(messageId, 'NEST');

        interestedUsers.add('user-1');
        interestedUsers.add('user-1');
        interestedUsers.add('user-2');

        assert.equal(interestedUsers.size, 2);
        assert.equal(toggleDungeonInterest(messageId, 'NEST', 'user-1').interested, false);
        assert.equal(interestedUsers.has('user-2'), true);
        clearHeadcountState(messageId);
    });
});

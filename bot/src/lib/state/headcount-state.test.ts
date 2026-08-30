import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import {
    clearParticipants,
    getDungeonCodes,
    resolveHeadcountDungeonCodes,
    setDungeonCodes,
} from './headcount-state.js';

describe('normalized in-memory headcount selection', () => {
    it('retains ordered dungeon codes independently of public key buttons', () => {
        const messageId = 'headcount-with-no-key-buttons';
        setDungeonCodes(messageId, ['REALM_DUNGEON', 'NEST', 'SNAKE_PIT']);

        assert.deepEqual(getDungeonCodes(new EmbedBuilder(), messageId), [
            'REALM_DUNGEON', 'NEST', 'SNAKE_PIT',
        ]);

        clearParticipants(messageId);
        assert.deepEqual(getDungeonCodes(new EmbedBuilder(), messageId), []);
    });

    it('reopens Woodland Labyrinth from stored state despite having no key buttons', () => {
        const messageId = 'woodland-keyless';
        setDungeonCodes(messageId, ['WOODLAND_LABYRINTH']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, []), ['WOODLAND_LABYRINTH']);
        clearParticipants(messageId);
    });

    it('reopens Realm Clearing from stored state despite having no key buttons', () => {
        const messageId = 'realm-keyless';
        setDungeonCodes(messageId, ['REALM_DUNGEON']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, []), ['REALM_DUNGEON']);
        clearParticipants(messageId);
    });

    it('preserves stored order for mixed keyable and keyless selections', () => {
        const messageId = 'mixed-keyless';
        setDungeonCodes(messageId, ['WOODLAND_LABYRINTH', 'NEST', 'REALM_DUNGEON']);
        assert.deepEqual(resolveHeadcountDungeonCodes(messageId, ['NEST']), [
            'WOODLAND_LABYRINTH', 'NEST', 'REALM_DUNGEON',
        ]);
        clearParticipants(messageId);
    });

    it('uses component-derived codes only for legacy unstored panels', () => {
        assert.deepEqual(resolveHeadcountDungeonCodes('legacy-panel', ['NEST', 'SNAKE_PIT']), [
            'NEST', 'SNAKE_PIT',
        ]);
    });
});

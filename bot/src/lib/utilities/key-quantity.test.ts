import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildKeyQuantityModal,
    formatKeyOfferUsers,
    getKeyOfferQuantity,
    parseKeyQuantity,
    parseKeyQuantityAction,
    registerKeyQuantityIntent,
    removeKeyOffer,
    resolveKeyQuantityIntent,
    setKeyOfferQuantity,
    totalKeyQuantity,
    type HeadcountKeyOfferStore,
    type KeyQuantityIntent,
} from './key-quantity.js';

describe('key quantity validation', () => {
    it('accepts the inclusive bounds and trims whitespace', () => {
        assert.equal(parseKeyQuantity('1'), 1);
        assert.equal(parseKeyQuantity('10'), 10);
        assert.equal(parseKeyQuantity('  5  '), 5);
    });

    it('rejects zero, values over ten, negatives, decimals, and non-numeric input', () => {
        for (const input of ['0', '11', '-1', '1.5', 'three', '', '  ']) {
            assert.equal(parseKeyQuantity(input), null, `expected ${JSON.stringify(input)} to fail`);
        }
    });
});

describe('key quantity modal intents', () => {
    const runIntent: KeyQuantityIntent = {
        context: 'run', runId: '42', userId: '100000000000000001', keyType: 'NEST_KEY',
    };
    const headcountIntent: KeyQuantityIntent = {
        context: 'headcount', messageId: '100000000000000002', userId: '100000000000000001',
        dungeonCode: 'FUNGAL_CAVERN', keyType: 'FUNGAL_CAVERN_KEY',
    };

    it('builds a run modal resolving the correct run, user, and key', () => {
        const modal = buildKeyQuantityModal(runIntent, 'Nest Key').toJSON();
        const action = parseKeyQuantityAction(modal.custom_id);
        assert.ok(action);
        assert.equal(action.action, 'submit');
        assert.deepEqual(resolveKeyQuantityIntent(action.token), runIntent);
        const row = modal.components[0];
        assert.ok('components' in row);
        assert.equal(row.components[0].value, '1');
    });

    it('builds a headcount modal resolving the correct message, dungeon, user, and key', () => {
        const modal = buildKeyQuantityModal(headcountIntent, 'Fungal Cavern Key', 4).toJSON();
        const action = parseKeyQuantityAction(modal.custom_id);
        assert.ok(action);
        assert.deepEqual(resolveKeyQuantityIntent(action.token), headcountIntent);
        const row = modal.components[0];
        assert.ok('components' in row);
        assert.equal(row.components[0].value, '4');
    });

    it('rejects malformed or unknown modal tokens', () => {
        assert.equal(parseKeyQuantityAction('keyqty:submit:not-a-uuid'), null);
        assert.equal(resolveKeyQuantityIntent('00000000-0000-4000-8000-000000000000'), null);
        const token = registerKeyQuantityIntent(runIntent);
        assert.deepEqual(resolveKeyQuantityIntent(token), runIntent);
    });
});

describe('headcount key quantity state', () => {
    it('creates, replaces, totals, formats, and removes one user/key row', () => {
        const store: HeadcountKeyOfferStore = new Map();
        setKeyOfferQuantity(store, 'NEST', 'NEST_KEY', 'user-1', 2);
        setKeyOfferQuantity(store, 'NEST', 'NEST_KEY', 'user-1', 5);
        setKeyOfferQuantity(store, 'NEST', 'NEST_KEY', 'user-2', 3);

        assert.equal(getKeyOfferQuantity(store, 'NEST', 'NEST_KEY', 'user-1'), 5);
        const offers = [...(store.get('NEST')?.get('NEST_KEY') ?? [])]
            .map(([userId, quantity]) => ({ userId, quantity }));
        assert.equal(offers.length, 2);
        assert.equal(totalKeyQuantity(offers), 8);
        assert.equal(formatKeyOfferUsers(offers), '<@user-1> ×5, <@user-2> ×3');

        assert.equal(removeKeyOffer(store, 'NEST', 'NEST_KEY', 'user-1'), true);
        assert.equal(getKeyOfferQuantity(store, 'NEST', 'NEST_KEY', 'user-1'), null);
        assert.equal(removeKeyOffer(store, 'NEST', 'NEST_KEY', 'user-1'), false);
    });
});

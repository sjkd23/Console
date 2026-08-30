import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchOrganizerStartContext } from './organizer-start-context.js';

describe('original organizer Start context', () => {
    it('forces a fresh fetch for the original organizer, not acting staff', async () => {
        const context = await fetchOrganizerStartContext('123', async options => {
            assert.deepEqual(options, { user: '123', force: true });
            return { id: '123', roles: { cache: new Map([['456', { id: '456', position: 7 }]]) } };
        });
        assert.deepEqual(context, { organizerRoles: ['456'], organizerRolePositions: { '456': 7 } });
    });
    it('rejects unavailable or mismatched member state instead of returning empty roles', async () => {
        await assert.rejects(fetchOrganizerStartContext('123', async () => { throw new Error('Discord unavailable'); }), /Discord unavailable/);
        await assert.rejects(fetchOrganizerStartContext('123', async () => ({ id: '999', roles: { cache: new Map() } })), /different member/);
    });
    it('allows a successfully fetched member with no matching configuration to supply their actual roles', async () => {
        const context = await fetchOrganizerStartContext('123', async () => ({ id: '123', roles: { cache: new Map() } }));
        assert.deepEqual(context, { organizerRoles: [], organizerRolePositions: {} });
    });
});

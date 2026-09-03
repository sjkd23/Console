import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logminutes } from './logminutes.js';

describe('/logminutes command contract', () => {
    it('is available for organizer self-recovery and accepts only run and integer-minute inputs', () => {
        assert.equal(logminutes.requiredRole, undefined);
        const command = logminutes.data.toJSON();
        assert.equal(command.name, 'logminutes');
        assert.doesNotMatch(command.description, /moderator|staff/i);
        assert.deepEqual(command.options?.map(option => option.name), ['run', 'minutes']);
        for (const option of command.options ?? []) {
            assert.equal(option.type, 4);
            assert.equal(option.required, true);
            assert.equal(option.min_value, 1);
        }
        assert.ok(!(command.options ?? []).some(option => ['organizer', 'user', 'rate', 'points', 'role'].includes(option.name)));
    });
});

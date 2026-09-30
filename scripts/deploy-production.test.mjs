import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, sha } from './lib/shell-test-fixture.mjs';

test('pulls both images, validates their runtime env, then starts without building', t => {
    const result = fixture(t).run('deploy-production.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.indexOf('config --quiet') < result.calls.indexOf('pull backend bot'));
    assert.ok(result.calls.indexOf('pull backend bot') < result.calls.indexOf('run --rm --no-deps'));
    assert.ok(result.calls.lastIndexOf('run --rm --no-deps') < result.calls.indexOf('up -d --no-build --pull never'));
    assert.match(result.calls, /compose .* ps/);
    assert.doesNotMatch(result.calls, /compose .* (build|down|prune)( |$)|pull db/m);
});
test('accepts a full release SHA', t => {
    const result = fixture(t).run('deploy-production.sh', { MOCK_TAG: sha });
    assert.equal(result.status, 0, result.stderr);
});
test('pulls PostgreSQL on first installation only', t => {
    const result = fixture(t).run('deploy-production.sh', { MOCK_NO_POSTGRES: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /pull db/);
});
for (const env of [
    { MOCK_DAEMON_FAIL: 'true' }, { MOCK_CONFIG_FAIL: 'true' }, { MOCK_PULL_FAIL: 'true' },
    { MOCK_ENV_FAIL: 'true' }, { MOCK_TAG: 'bad-tag' }, { MOCK_BACKEND_SHA: 'f'.repeat(40) },
    { CONSOLE_PGDATA_HOST_PATH: '/mnt/console/pgdata' },
    { MOCK_CURRENT_MOUNT: 'bind' },
]) {
    test(`stops before starting services on ${Object.keys(env)[0]}`, t => {
        const result = fixture(t).run('deploy-production.sh', env);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.calls, / up /);
    });
}
test('missing deployment settings fail before Docker calls', t => {
    const f = fixture(t);
    rmSync(join(f.root, '.env.production'));
    const result = f.run('deploy-production.sh');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
});
test('missing application secrets fail before Docker calls', t => {
    const f = fixture(t);
    rmSync(join(f.root, 'bot', '.env'));
    const result = f.run('deploy-production.sh');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
});
test('encrypted deployment requires a recorded UUID and existing mounted PGDATA', t => {
    const result = fixture(t).run('deploy-production.sh', {
        CONSOLE_PGDATA_HOST_PATH: '/missing-console-test/pgdata', CONSOLE_EXPECTED_VOLUME_UUID: 'test-uuid',
    }, ['--pg-volume']);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /pull backend bot| up /);
});
function encryptedFixture(t) {
    const f = fixture(t);
    const path = join(f.root, 'pgdata');
    mkdirSync(path);
    writeFileSync(join(path, 'PG_VERSION'), '14\n');
    const shellPath = path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
    return { f, env: { CONSOLE_PGDATA_HOST_PATH: shellPath, CONSOLE_EXPECTED_VOLUME_UUID: 'test-uuid', MOCK_CURRENT_MOUNT: 'bind' } };
}
test('encrypted deployments retain the PG override after checking the mount', t => {
    const { f, env } = encryptedFixture(t);
    const result = f.run('deploy-production.sh', env, ['--pg-volume']);
    assert.equal(result.status, 0, result.stderr);
    for (const call of result.calls.split('\n').filter(line => /config |pull backend bot| up /.test(line))) {
        assert.match(call, /docker-compose.pg-volume.yml/);
    }
});
for (const check of [{ MOCK_UUID: 'wrong-uuid' }, { MOCK_MOUNT_FAIL: 'true' }]) {
    test(`encrypted deployments stop on ${Object.keys(check)[0]}`, t => {
        const { f, env } = encryptedFixture(t);
        const result = f.run('deploy-production.sh', { ...env, ...check }, ['--pg-volume']);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.calls, /pull backend bot| up /);
    });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('validates only bot/backend when Compose includes the PostgreSQL dependency', t => {
    const f = fixture(t);
    const result = f.run('deploy-production.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /config --no-env-resolution --format yaml backend bot/);
    assert.doesNotMatch(result.calls, /config --images|image inspect --format .* postgres:14/);
    assert.equal((result.calls.match(/image inspect --format/g) ?? []).length, 2);
});

test('uses the real resolved Compose model with dependency services present', t => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const model = execFileSync('docker', [
        'compose', '--env-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '-f', 'docker-compose.yml', '-f', 'scripts/compose-check.override.yml',
        'config', '--no-env-resolution', '--format', 'yaml', 'backend', 'bot',
    ], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, CONSOLE_IMAGE_NAMESPACE: 'sjkd23/console', CONSOLE_IMAGE_TAG: sha },
    });
    assert.match(model, /\r?\n  db:\r?\n/);
    assert.match(model, /image: postgres:14/);
    const result = fixture(t).run('deploy-production.sh', { MOCK_COMPOSE_MODEL: model });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, new RegExp(`image inspect --format .* ghcr.io/sjkd23/console-backend:${sha}`));
    assert.match(result.calls, new RegExp(`image inspect --format .* ghcr.io/sjkd23/console-bot:${sha}`));
    assert.doesNotMatch(result.calls, /image inspect --format .* postgres:14/);
});

function model(backend, bot, extra = '') {
    return `name: console\nservices:\n  bot:\n    environment:\n      image: ignored-nested-value\n    image: ${bot}\n  db:\n    image: postgres:14\n  backend:\n    image: ${backend}\n${extra}`;
}
test('service field selection ignores order, nested fields and unrelated GHCR images', t => {
    const backend = `ghcr.io/sjkd23/console-backend:${sha}`, bot = `ghcr.io/sjkd23/console-bot:${sha}`;
    const result = fixture(t).run('deploy-production.sh', {
        MOCK_COMPOSE_MODEL: model(`'${backend}'`, `"${bot}"`,
            `  worker:\n    image: ${bot}\nvolumes:\n  bot:\n    image: ignored-outside-services\n`),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.calls.match(/image inspect --format/g) ?? []).length, 2);
});

for (const [name, composeModel] of [
    ['missing bot', `services:\n  backend:\n    image: ghcr.io/sjkd23/console-backend:${sha}\n  db:\n    image: postgres:14\n`],
    ['duplicate backend', model(`ghcr.io/sjkd23/console-backend:${sha}`, `ghcr.io/sjkd23/console-bot:${sha}`, `  backend:\n    image: ghcr.io/sjkd23/console-backend:${sha}\n`)],
    ['wrong service image', model(`ghcr.io/sjkd23/console-bot:${sha}`, `ghcr.io/sjkd23/console-bot:${sha}`)],
    ['database used as bot', model(`ghcr.io/sjkd23/console-backend:${sha}`, 'postgres:14')],
    ['invalid namespace', model(`ghcr.io/UPPER/console-backend:${sha}`, `ghcr.io/UPPER/console-bot:${sha}`)],
    ['different namespaces', model(`ghcr.io/sjkd23/console-backend:${sha}`, `ghcr.io/other/console-bot:${sha}`)],
    ['different tags', model(`ghcr.io/sjkd23/console-backend:${sha}`, 'ghcr.io/sjkd23/console-bot:latest')],
]) {
    test(`rejects ${name} before pulling applications`, t => {
        const result = fixture(t).run('deploy-production.sh', { MOCK_COMPOSE_MODEL: composeModel });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.calls, /pull backend bot| up /);
    });
}

test('rejects a matched revision pair that differs from the explicit SHA tag', t => {
    const result = fixture(t).run('deploy-production.sh', { MOCK_TAG: 'f'.repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Image revision differs from requested SHA/);
    assert.doesNotMatch(result.calls, / up /);
});
test('rejects a malformed revision label', t => {
    const result = fixture(t).run('deploy-production.sh', { MOCK_BACKEND_SHA: 'invalid' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing release revision/);
    assert.doesNotMatch(result.calls, / up /);
});
test('pulls PostgreSQL on first installation only', t => {
    const result = fixture(t).run('deploy-production.sh', { MOCK_NO_POSTGRES: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /pull db/);
});
for (const env of [
    { MOCK_DAEMON_FAIL: 'true' }, { MOCK_CONFIG_FAIL: 'true' }, { MOCK_MODEL_FAIL: 'true' }, { MOCK_PULL_FAIL: 'true' },
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'backend/package.json'));

function cleanCheckout(t) {
    const checkout = mkdtempSync(join(tmpdir(), 'console-compose-clean-'));
    t.after(() => rmSync(checkout, { recursive: true, force: true }));
    for (const file of [
        'docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.pg-volume.yml',
        'scripts/check-compose-separation.mjs', 'scripts/compose-check.override.yml',
        'backend/Dockerfile', 'bot/Dockerfile', 'backend/package.json',
    ]) {
        mkdirSync(dirname(join(checkout, file)), { recursive: true });
        copyFileSync(join(root, file), join(checkout, file));
    }
    // Reuse the installed checker dependency without copying runtime files.
    mkdirSync(join(checkout, 'backend/node_modules'));
    symlinkSync(dirname(require.resolve('zod/package.json')), join(checkout, 'backend/node_modules/zod'), process.platform === 'win32' ? 'junction' : 'dir');
    return checkout;
}

function runCheck(checkout) {
    return spawnSync(process.execPath, ['scripts/check-compose-separation.mjs'], {
        cwd: checkout, encoding: 'utf8',
        env: { ...process.env, COMPOSE_FILE: '', CONSOLE_IMAGE_TAG: '', CONSOLE_PGDATA_HOST_PATH: '' },
    });
}

test('structural check succeeds with every ignored runtime env file absent', t => {
    const checkout = cleanCheckout(t);
    const runtimeFiles = ['.env', '.env.production', 'backend/.env', 'bot/.env'];
    for (const file of runtimeFiles) assert.equal(existsSync(join(checkout, file)), false);

    // Ordinary deployment rendering must still require the real service env files.
    const deployment = spawnSync('docker', [
        'compose', '--env-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--file', 'docker-compose.yml', 'config', '--format', 'json',
    ], { cwd: checkout, encoding: 'utf8' });
    assert.notEqual(deployment.status, 0);
    assert.match(deployment.stderr, /env file .*\.env.*(not found|no such file)/i);

    const result = runCheck(checkout);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Compose checks passed/);
    for (const file of runtimeFiles) assert.equal(existsSync(join(checkout, file)), false, 'Checker must not create runtime env files');
});

test('clean-checkout rendering still rejects a production build definition', t => {
    const checkout = cleanCheckout(t);
    const file = join(checkout, 'docker-compose.yml');
    const compose = readFileSync(file, 'utf8');
    writeFileSync(file, compose.replace('  backend:', '  backend:\n    build:\n      context: ./backend\n      dockerfile: Dockerfile'));
    const result = runCheck(checkout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backend production must never contain build/);
});

test('clean-checkout rendering still requires explicit PG host-path protection', t => {
    const checkout = cleanCheckout(t);
    const file = join(checkout, 'docker-compose.pg-volume.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/bind:\r?\n\s+create_host_path: false/, 'bind: {}'));
    const result = runCheck(checkout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PG override must explicitly disable host-path creation/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { z } = createRequire(join(root, 'backend/package.json'))('zod');
const volumeSchema = z.object({
    type: z.string(), source: z.string().optional(), target: z.string(),
    bind: z.object({ create_host_path: z.boolean().optional() }).optional(),
}).passthrough();
const serviceSchema = z.object({
    image: z.string(), build: z.unknown().optional(),
    entrypoint: z.array(z.string()).nullable().optional(),
    command: z.array(z.string()).nullable().optional(),
    volumes: z.array(volumeSchema).optional(),
}).passthrough();
const configSchema = z.object({ services: z.record(serviceSchema) }).passthrough();
const buildSchema = z.object({ context: z.string(), dockerfile: z.string() });

function renderCompose(files, settings = {}) {
    return configSchema.parse(JSON.parse(execFileSync('docker', [
        'compose', '--env-file', process.platform === 'win32' ? 'NUL' : '/dev/null',
        ...files.flatMap(file => ['--file', file]),
        'config', '--no-env-resolution', '--format', 'json',
    ], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, CONSOLE_IMAGE_NAMESPACE: 'sjkd23/console', CONSOLE_IMAGE_TAG: 'latest', ...settings },
    })));
}

function checkProduction(config, namespace, tag) {
    for (const name of ['backend', 'bot']) {
        const service = config.services[name];
        assert.ok(service, `${name} must exist`);
        assert.equal(service.build, undefined, `${name} production must never contain build`);
        assert.equal(service.image, `ghcr.io/${namespace}-${name}:${tag}`);
        assert.ok(![...(service.entrypoint ?? []), ...(service.command ?? [])].join(' ').includes('dev-entrypoint'));
        assert.ok(!(service.volumes ?? []).some(volume => ['/app', '/app/node_modules'].includes(volume.target)));
    }
}

const production = renderCompose(['docker-compose.yml']);
checkProduction(production, 'sjkd23/console', 'latest');
const sha = '0123456789abcdef0123456789abcdef01234567';
const pinned = renderCompose(['docker-compose.yml'], { CONSOLE_IMAGE_TAG: sha });
checkProduction(pinned, 'sjkd23/console', sha);
const renamed = renderCompose(['docker-compose.yml'], { CONSOLE_IMAGE_NAMESPACE: 'other-owner/other-repo', CONSOLE_IMAGE_TAG: sha });
checkProduction(renamed, 'other-owner/other-repo', sha);

const pgdata = process.platform === 'win32' ? 'C:/console-compose-check/pgdata' : '/mnt/console-compose-check/pgdata';
const encrypted = renderCompose(['docker-compose.yml', 'docker-compose.pg-volume.yml'], {
    CONSOLE_IMAGE_TAG: sha, CONSOLE_PGDATA_HOST_PATH: pgdata,
});
checkProduction(encrypted, 'sjkd23/console', sha);
const mounts = encrypted.services.db.volumes.filter(volume => volume.target === '/var/lib/postgresql/data');
assert.equal(mounts.length, 1, 'Encrypted override must replace rather than append the PGDATA mount');
assert.equal(mounts[0].type, 'bind');
assert.equal(mounts[0].source.replaceAll('\\', '/'), pgdata);
assert.equal(mounts[0].bind?.create_host_path, false);
const { volumes: originalVolumes, ...originalDb } = production.services.db;
const { volumes: encryptedVolumes, ...encryptedDb } = encrypted.services.db;
assert.deepEqual(encryptedDb, originalDb, 'Storage override must preserve all other DB settings');
assert.equal(originalVolumes[0].type, 'volume');

const development = renderCompose(['docker-compose.yml', 'docker-compose.dev.yml']);
for (const name of ['backend', 'bot']) {
    const service = development.services[name];
    const build = buildSchema.parse(service.build);
    assert.equal(build.dockerfile, 'Dockerfile.dev');
    assert.ok(build.context.replaceAll('\\', '/').endsWith(`/${name}`));
    assert.equal(service.image, `rotmg-raid-${name}:development`);
    assert.ok(service.command.join(' ').includes('dev-entrypoint'));
    assert.ok(service.command.join(' ').includes('npm run dev'));
    assert.ok(service.volumes.some(volume => volume.target === '/app/node_modules'));
    assert.ok(!readFileSync(join(root, name, 'Dockerfile'), 'utf8').includes('dev-entrypoint'));
}
assert.deepEqual(development.services.db, production.services.db);
const backendDockerfile = readFileSync(join(root, 'backend/Dockerfile'), 'utf8');
assert.ok(backendDockerfile.includes('node dist/scripts/migrate.js && exec node dist/server.js'));
assert.ok(readFileSync(join(root, 'bot/Dockerfile'), 'utf8').includes('"node", "dist/index.js"'));
console.log('Compose checks passed: image-only production, SHA/namespace selection, encrypted mount replacement, development builds, startup migrations.');

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const productionFiles = ['docker-compose.yml'];
const developmentFiles = ['docker-compose.yml', 'docker-compose.dev.yml'];
const applicationServices = ['backend', 'bot'];

function fail(message) {
    throw new Error(message);
}

function renderCompose(files) {
    const fileArguments = files.flatMap(file => ['--file', file]);
    const output = execFileSync(
        'docker',
        ['compose', ...fileArguments, 'config', '--no-env-resolution', '--format', 'json'],
        { cwd: root, encoding: 'utf8' },
    );

    return JSON.parse(output);
}

function commandText(service) {
    return [...(service.entrypoint ?? []), ...(service.command ?? [])].join(' ');
}

const production = renderCompose(productionFiles);
const development = renderCompose(developmentFiles);

for (const serviceName of applicationServices) {
    const productionService = production.services?.[serviceName];
    const developmentService = development.services?.[serviceName];

    if (productionService?.build?.dockerfile !== 'Dockerfile') {
        fail(`${serviceName} production must build with Dockerfile`);
    }
    if (!productionService.image?.endsWith(':production')) {
        fail(`${serviceName} production must use a production-only image tag`);
    }
    if (commandText(productionService).includes('dev-entrypoint')) {
        fail(`${serviceName} production must not invoke dev-entrypoint`);
    }
    if ((productionService.volumes ?? []).some(volume => volume.target === '/app' || volume.target === '/app/node_modules')) {
        fail(`${serviceName} production must not use development application volumes`);
    }

    if (developmentService?.build?.dockerfile !== 'Dockerfile.dev') {
        fail(`${serviceName} development must build with Dockerfile.dev`);
    }
    if (!developmentService.image?.endsWith(':development')) {
        fail(`${serviceName} development must use a development-only image tag`);
    }
    if (!commandText(developmentService).includes('dev-entrypoint')) {
        fail(`${serviceName} development must invoke dev-entrypoint`);
    }
    if (!commandText(developmentService).includes('npm run dev')) {
        fail(`${serviceName} development must run the watch process`);
    }
    if (!(developmentService.volumes ?? []).some(volume => volume.target === '/app/node_modules')) {
        fail(`${serviceName} development must retain its dependency volume`);
    }

    const productionDockerfile = readFileSync(join(root, serviceName, 'Dockerfile'), 'utf8');
    if (productionDockerfile.includes('dev-entrypoint')) {
        fail(`${serviceName}/Dockerfile must not reference dev-entrypoint`);
    }
}

const backendDockerfile = readFileSync(join(root, 'backend', 'Dockerfile'), 'utf8');
if (!backendDockerfile.includes('node dist/scripts/migrate.js') || !backendDockerfile.includes('node dist/server.js')) {
    fail('backend/Dockerfile must run compiled migrations before the compiled server');
}

const botDockerfile = readFileSync(join(root, 'bot', 'Dockerfile'), 'utf8');
if (!botDockerfile.includes('node", "dist/index.js')) {
    fail('bot/Dockerfile must run the compiled bot entry point');
}

console.log('Compose separation check passed.');

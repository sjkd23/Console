import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = readdirSync(join(root, 'src'), { recursive: true })
    .filter(file => file.endsWith('.test.ts'))
    .sort()
    .map(file => join(root, 'src', file));
if (tests.length === 0) throw new Error('No bot tests found');

// Existing tests use node:test module mocks (Node 22+); tsx preserves source fixtures.
const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--import', 'tsx', '--test', ...tests,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

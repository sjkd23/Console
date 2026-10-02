import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
export const sha = '0123456789abcdef0123456789abcdef01234567';
export function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'console-shell-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const folder of ['scripts', 'bin', 'bot', 'backend']) mkdirSync(join(root, folder));
    for (const name of ['deploy-production.sh', 'publish-images.sh']) copyFileSync(join(scripts, name), join(root, 'scripts', name));
    writeFileSync(join(root, '.env.production'), 'CONSOLE_IMAGE_TAG=latest\n');
    for (const name of ['bot', 'backend']) writeFileSync(join(root, name, '.env'), 'DUMMY=ci-only\n');
    writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n');
    const log = join(root, 'calls.log');
    writeFileSync(log, '');
    writeFileSync(join(root, 'bin', 'docker'), `#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  info) test "\x24{MOCK_DAEMON_FAIL:-false}" != true ;;
  inspect*) printf '%s\n' "\x24{MOCK_CURRENT_MOUNT:-volume}" ;;
  *'config --quiet') test "\x24{MOCK_CONFIG_FAIL:-false}" != true ;;
  *'config --images backend bot')
    # Compose includes dependency images even when applications are selected.
    printf 'postgres:14\nghcr.io/sjkd23/console-backend:%s\nghcr.io/sjkd23/console-bot:%s\n' "\x24{MOCK_TAG:-latest}" "\x24{MOCK_TAG:-latest}" ;;
  *'config --no-env-resolution --format yaml backend bot')
    test "\x24{MOCK_MODEL_FAIL:-false}" != true
    if test -n "\x24{MOCK_COMPOSE_MODEL:-}"; then
      printf '%s\n' "$MOCK_COMPOSE_MODEL"
    else
      printf 'name: console\nservices:\n  db:\n    image: postgres:14\n  backend:\n    image: ghcr.io/sjkd23/console-backend:%s\n  bot:\n    image: ghcr.io/sjkd23/console-bot:%s\n' "\x24{MOCK_TAG:-latest}" "\x24{MOCK_TAG:-latest}"
    fi ;;
  *'pull backend bot') test "\x24{MOCK_PULL_FAIL:-false}" != true ;;
  'image inspect postgres:14') test "\x24{MOCK_NO_POSTGRES:-false}" != true ;;
  'image inspect '*console-backend:*) printf '%s\n' "\x24{MOCK_BACKEND_SHA:-$MOCK_SHA}" ;;
  'image inspect '*) printf '%s\n' "$MOCK_SHA" ;;
  *'run --rm --no-deps'*) test "\x24{MOCK_ENV_FAIL:-false}" != true ;;
  'buildx imagetools inspect '*|pull*latest)
    if test "\x24{MOCK_REGISTRY_FAIL:-false}" = true; then echo unauthorized >&2; exit 1; fi
    if [[ "$*" = pull* ]]; then exists=\x24{MOCK_LATEST_EXISTS:-false}; else exists=\x24{MOCK_SHA_EXISTS:-false}; fi
    if test "$exists" != true; then echo 'manifest unknown: not found' >&2; exit 1; fi ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'mountpoint'), '#!/usr/bin/env bash\ntest "${MOCK_MOUNT_FAIL:-false}" != true\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'findmnt'), '#!/usr/bin/env bash\nprintf "%s\\n" "${MOCK_UUID:-test-uuid}"\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'gh'), `#!/usr/bin/env bash
set -eu
printf 'gh %s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *'.owner.type') printf '%s\n' "\x24{MOCK_OWNER_TYPE:-User}" ;;
  *'/versions?'*)
    if test "\x24{MOCK_REGISTRY_FAIL:-false}" = true; then echo 'gh: HTTP 403' >&2; exit 1; fi
    if test "\x24{MOCK_SHA_EXISTS:-false}" = true; then echo 123; else echo 'gh: HTTP 404' >&2; exit 1; fi ;;
  *) printf '%s\n' "\x24{MOCK_ANCESTRY:-ahead}" ;;
esac
`, { mode: 0o755 });

    return {
        root,
        run(name, env = {}, args = []) {
            const bash = process.env.CONSOLE_TEST_BASH ?? 'bash';
            const result = spawnSync(bash, [join(root, 'scripts', name).replaceAll('\\', '/'), ...args], {
                encoding: 'utf8',
                env: {
                    ...process.env, CONSOLE_PGDATA_HOST_PATH: '', CONSOLE_DEPLOY_ENV_FILE: '',
                    CONSOLE_REPOSITORY: 'sjkd23/Console', CONSOLE_COMMIT_SHA: sha,
                    CONSOLE_REF: 'refs/heads/main', MOCK_SHA: sha,
                    MOCK_LOG: log.replaceAll('\\', '/'), PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
                    ...env,
                },
            });
            if (result.error) throw result.error;
            return { ...result, calls: readFileSync(log, 'utf8') };
        },
    };
}

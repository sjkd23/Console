# Console production publishing and deployment

GitHub Actions tests and builds Console, then publishes two images. Production only
pulls and starts them. GitHub Actions never connects to production, deploys,
changes DigitalOcean, or runs production migrations. Deployment is an explicit
owner action; a successful publishing run does not update the server.

## Images and release selection

The Git remote is `sjkd23/Console` (default branch `main`). Image names derive from
the lowercase GitHub repository identifier:

- Bot: `ghcr.io/sjkd23/console-bot`
- Backend: `ghcr.io/sjkd23/console-backend`

Both receive a full 40-character commit SHA tag. Once published, the workflow reuses
that SHA image on reruns instead of replacing its digest. Keep known-good SHA images
in GHCR; manual package deletion would remove that rollback target. `latest` moves
forward after successful main-branch validation/publishing. An ancestry check keeps
delayed builds and old reruns from moving it backwards. Divergent main history or a
registry authorization failure stops publishing. Manual dispatch on another branch
publishes SHA tags only. SHA tags are immutable by this workflow's policy; GHCR
administrators can still alter/delete packages outside the workflow.

Bot and backend are released together from this repository, so a shared SHA is the
intended compatible pair. Independent versions would require separately validated
compatibility and an explicit configuration change. Prefer an exact SHA on production.
`latest` is convenient but mutable, and its two tags cannot be changed atomically;
the deployment script refuses to start mismatched revision labels. Retry after
publishing completes or select a full SHA if that check fails.

## First-time GitHub setup and publishing

1. Commit/push this workflow when ready. In repository **Settings → Actions →
   General**, allow the official GitHub and Docker actions used by the workflow.
   The publishing job requests `contents: read` and `packages: write`; ensure
   account/organization policy permits those requests. Validation has only
   `contents: read`. No custom registry token, SSH secret, or production secret is
   required in Actions.
2. Push to `main`, or run **Validate and publish Console containers** in the Actions
   tab. Confirm the entire run succeeds and both packages expose the intended SHA.
3. The OCI source label links images to this repository. If either package name
   already exists, grant this repository Actions write access in that package's
   settings before the first run. Do not change repository visibility for this workflow.
4. Choose package visibility deliberately. The repository is public, but that does
   not make new GHCR packages public automatically. Existing package visibility could
   not be inspected with the available token. Keep them private and authenticate on
   production, or explicitly make **both** packages public for anonymous pulls.

The workflow runs clean `npm ci` installs, all existing bot tests and the backend
suite (including PostgreSQL integration tests against an isolated PG14 service), both
TypeScript builds, the bot ESM check, compiled bot/registration imports, Compose
safety checks, shell syntax checks, and mocked deployment/publishing tests. It builds
both Linux AMD64 images from service contexts, loads the final production images,
checks the bot without Discord login, starts the backend with its real startup
migrations on the isolated CI database, checks `/v1/health`, and runs the existing
compiled ticket runtime check. Only after all validation succeeds does a separate
job obtain package-write permission and publish the exact tested images from a
one-day Actions artifact. It does not rebuild during publishing.

## First-time production setup and GHCR authentication

Install Docker Engine and a current Compose v2+ plugin. Production needs no host
Node.js, npm, compiler, build cache, or build-time memory/CPU headroom. Images retain
the current Node 20 Alpine runtime; CI uses Node 22 for existing module-mock tests.
No new container memory limits are imposed. The published platform is `linux/amd64`;
use an AMD64 VPS. ARM hosts require an explicitly tested additional build platform.

Keep the same deployment directory and Compose project name as the existing server.
Changing the project name would select a different named PostgreSQL volume. If the
directory changes, record the existing project label with:

```bash
docker inspect rotmg_db --format '{{ index .Config.Labels "com.docker.compose.project" }}'
```

Set that exact `COMPOSE_PROJECT_NAME` in `.env.production` before proceeding.
Existing container names, PostgreSQL 14 configuration, ports, service dependencies,
network topology, Gateway configuration, and application environment overrides are
preserved. Do not combine the first GHCR switch with a storage cutover.

For **private packages**, create a GitHub **personal access token (classic)** with
only `read:packages`; the account must have read access to both packages. Authorize
SSO if your organization requires it. Log in once as the same OS user that runs
Docker deployments (using `sudo docker` uses a different Docker credential store):

```bash
read -rsp 'GHCR read token: ' GHCR_READ_TOKEN; printf '\n'
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username sjkd23 --password-stdin
unset GHCR_READ_TOKEN
```

Never store the token in the repository or service environment files. Use a Docker
credential helper where available. For explicitly **public packages**, no registry
login is needed for pulls. See GitHub's [Container registry authentication and
visibility documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Keep production secrets only in `bot/.env` and `backend/.env` as before, with matching
`BACKEND_API_KEY` values. Copy the deployment settings file:

```bash
cp .env.production.example .env.production
```

Select a published full SHA in that file (or explicitly choose `latest`). Optional
`CONSOLE_IMAGE_NAMESPACE` defaults to `sjkd23/console`; forks/renamed repositories
can change this one value. The shell overrides the settings file. Application
`env_file` paths remain relative to the repository, regardless of the caller's
working directory. `.env.production` is Compose interpolation settings, not a
replacement for the two application secret files. It is ignored by Git.

## Normal owner deployment

If scripts/configs are kept in the checkout, update them with `git pull --ff-only`.
Select the intended SHA and run from the repository root:

```bash
CONSOLE_IMAGE_TAG=<published-full-commit-sha> bash scripts/deploy-production.sh
```

Or select `CONSOLE_IMAGE_TAG` in `.env.production`, then:

```bash
bash scripts/deploy-production.sh
```

The script validates required files, Docker availability and Compose configuration
without displaying secrets, then pulls both application images. A pull/authentication
failure stops before updating services. It verifies matching image revision labels,
uses each image's existing Zod configuration schema in a disposable container before
startup, and runs `up -d --no-build --pull never` followed by `ps`. It pulls PostgreSQL
only if its image is absent locally, preserving the existing PostgreSQL image on
ordinary application releases. It never deletes images/volumes, builds, or uses SSH.
If the existing PostgreSQL container uses a bind mount, omitting `--pg-volume` is
rejected before pulling images.
No slash-command registration or manual Discord test runs automatically.

The equivalent basic Compose flow is:

```bash
export CONSOLE_IMAGE_TAG=<published-full-commit-sha>
docker compose --env-file .env.production -f docker-compose.yml config --quiet
docker compose --env-file .env.production -f docker-compose.yml pull backend bot
# First install only, if postgres:14 is not present locally:
docker compose --env-file .env.production -f docker-compose.yml pull db
docker compose --env-file .env.production -f docker-compose.yml up -d --no-build --pull never
docker compose --env-file .env.production -f docker-compose.yml ps
```

Use the script for its extra release/environment checks. The resolved production
configuration contains **no `build` for bot or backend**. Never include
`docker-compose.dev.yml` on production. If command names/options changed, manually
register the compiled commands against the selected release:

```bash
docker compose --env-file .env.production -f docker-compose.yml run --rm --no-deps --pull never bot npm run register
```

Persist the selected SHA in `.env.production` after a one-command shell override so
later owner commands use the same version. Review backend/bot logs after deployment;
`ps` alone does not prove Discord readiness. Backend health is `/v1/health`.

## Image rollback and database migrations

```bash
CONSOLE_IMAGE_TAG=<previous-good-full-commit-sha> bash scripts/deploy-production.sh
```

Both exact old images are pulled and services are recreated when their images differ;
no old commit is rebuilt on the server. Persist the rollback SHA in `.env.production`.

Backend startup is unchanged: `node dist/scripts/migrate.js && exec node dist/server.js`.
Pending SQL migrations apply before the API starts, using the existing runner and
migration-history table. No new migration is introduced by this deployment change.
**Image rollback does not reverse database schema or data migrations.** Migration
079 clears acknowledged ticket transcript content irreversibly; an older image
cannot recover it. Later migrations may also make older code incompatible. Check
schema compatibility and recovery backups before deploying or rolling back.

## Encrypted DigitalOcean PostgreSQL Volume

Perform the [separate storage cutover](postgresql-encrypted-volume-cutover.md) first
in its own maintenance window. After it is stable, every deployment/rollback must
include the storage override and recorded filesystem UUID:

```bash
export CONSOLE_PGDATA_HOST_PATH=/mnt/<existing-volume-mount>/pgdata
export CONSOLE_EXPECTED_VOLUME_UUID=<recorded-filesystem-uuid>
CONSOLE_IMAGE_TAG=<published-full-commit-sha> bash scripts/deploy-production.sh --pg-volume
```

This uses `docker-compose.yml` plus `docker-compose.pg-volume.yml`. The merged DB
configuration has exactly one bind mount at `/var/lib/postgresql/data`, with
`create_host_path: false`; all application services remain image-only. The script
requires an already initialized PG14 directory directly below the expected mounted
Volume and checks its filesystem UUID before any pull or start. Mount paths/UUIDs
must be exported in the operator shell. Preserve the existing project identity.
For direct Compose commands use both `-f` arguments consistently. Never omit the
override after the cutover: the old named volume may contain stale data. Host boot
ordering, backups, cold copying, and storage rollback remain covered by the runbook.

## Local development and build contexts

Development still builds and watches source locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The development overlay supplies both build contexts, development image names,
dependency volumes and watch entrypoints. For manual development use the existing
`npm ci`/migration/watch commands. `npm test` in `bot` runs source tests under Node
22+ with module mocks; backend tests use Vitest and `TEST_DATABASE_URL` for isolated
integration tests. No live RealmEye or Discord test is required for publishing.

Production Dockerfiles use explicit copies: package manifests/lockfiles, TypeScript
sources and the bot's build scripts in build stages; runtime images receive compiled
code, production dependencies and backend SQL migrations. `.dockerignore` excludes
host `node_modules`, `dist`, `.build`, all `.env` variants, logs, test sources,
coverage/results, Git metadata, and PEM/key files. No production environment values
or GitHub tokens are build arguments or copied files. TypeScript source maps are
not enabled. Existing operational/check scripts compile into the images; they
contain code, not credentials. The backend retains SQL migration source deliberately.
Tests are exercised from the checkout before Docker builds and are omitted from
production images. This is not a broader security rewrite.

Run the local configuration/script checks with:

```bash
node scripts/check-compose-separation.mjs
bash -n scripts/deploy-production.sh scripts/publish-images.sh scripts/pg-volume-preflight.sh
node --test scripts/check-compose-separation.test.mjs scripts/deploy-production.test.mjs scripts/publish-images.test.mjs
```

The Compose check needs installed backend dependencies and the Compose CLI, but no
Docker daemon or application secrets. It explicitly applies the test-only
`scripts/compose-check.override.yml` to clear service `env_file` references, so
ignored runtime environment files need not exist. Never include that override in
deployment commands. A regression test runs the checker in an isolated checkout
without runtime env files and confirms production build definitions are still
rejected. Actual image construction and image smoke
tests need a running daemon; a locally passing check does not prove a GitHub run
has succeeded.

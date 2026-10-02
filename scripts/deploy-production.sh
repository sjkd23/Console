#!/usr/bin/env bash
# Manual owner action only. Never build, delete volumes, or clean up images here.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$root"
env_file=${CONSOLE_DEPLOY_ENV_FILE:-$root/.env.production}
test -f "$env_file" || { echo "Missing deployment settings: $env_file (copy .env.production.example)" >&2; exit 1; }
for service in bot backend; do
  test -s "$root/$service/.env" || { echo "Missing or empty $service/.env" >&2; exit 1; }
done
command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null

compose=(docker compose --project-directory "$root" --env-file "$env_file" -f "$root/docker-compose.yml")
case "${1:-}" in
  '') test "$#" -eq 0 ;;
  --pg-volume)
    test "$#" -eq 1
    pgdata=${CONSOLE_PGDATA_HOST_PATH:?Export the existing Volume-backed PGDATA path}
    expected_uuid=${CONSOLE_EXPECTED_VOLUME_UUID:?Export the recorded Volume filesystem UUID}
    [[ "$pgdata" = /* && "$pgdata" != *$'\n'* ]] || { echo 'PGDATA must be an absolute path' >&2; exit 1; }
    test -d "$pgdata" && test ! -L "$pgdata"
    volume_mount=$(dirname -- "$pgdata")
    test "$volume_mount" != /
    mountpoint -q -- "$volume_mount"
    test "$(findmnt -n -o UUID --target "$volume_mount")" = "$expected_uuid"
    test "$(cat -- "$pgdata/PG_VERSION")" = 14
    compose+=(-f "$root/docker-compose.pg-volume.yml")
    ;;
  *) echo 'Usage: bash scripts/deploy-production.sh [--pg-volume]' >&2; exit 1 ;;
esac
# Avoid silently reverting an existing encrypted-storage deployment to the old volume.
if test -n "${CONSOLE_PGDATA_HOST_PATH:-}" && test "${1:-}" != --pg-volume; then
  echo 'CONSOLE_PGDATA_HOST_PATH is set; select --pg-volume explicitly' >&2
  exit 1
fi

# Validate without printing resolved secrets. The fixed file list excludes dev overlays.
"${compose[@]}" config --quiet
if current_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}' rotmg_db 2>/dev/null); then
  if test "$current_mount" = bind && test "${1:-}" != --pg-volume; then
    echo 'The existing PostgreSQL container uses a bind mount; refusing to omit --pg-volume' >&2
    exit 1
  fi
fi
# Service selection can include dependencies. Read only the named services'
# image fields from Compose's canonical YAML (not an unordered --images list).
# Bash is already required; no host JSON/YAML parser or Node runtime is needed.
images=$("${compose[@]}" config --no-env-resolution --format yaml backend bot | (
  in_services=false
  service=''
  while IFS= read -r line; do
    line=${line%$'\r'}
    if test "$line" = services:; then
      in_services=true
    elif [[ "$line" =~ ^[^[:space:]] ]]; then
      in_services=false
    elif test "$in_services" = true; then
      if [[ "$line" =~ ^\ \ [^[:space:]] ]]; then
        service=''
        case "$line" in
          '  backend:') service=backend ;;
          '  bot:') service=bot ;;
        esac
      elif test -n "$service" && [[ "$line" =~ ^\ \ \ \ image:\ (.+)$ ]]; then
        image=${BASH_REMATCH[1]}
        # Valid image references need no YAML escapes; allow quoted scalars too.
        case "$image" in
          \"*\") image=${image:1:${#image}-2} ;;
          \'*\') image=${image:1:${#image}-2} ;;
        esac
        printf '%s %s\n' "$service" "$image"
      fi
    fi
  done
))
namespace=''
tag=''
bot_count=0
backend_count=0
while IFS=' ' read -r service image; do
  [[ "$image" =~ ^ghcr\.io/([a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)-(bot|backend):(latest|[0-9a-f]{40})$ ]] || {
    echo "Invalid production image (use latest or a full commit SHA): $image" >&2; exit 1;
  }
  test "$service" = "${BASH_REMATCH[2]}" || { echo "Wrong application image for $service" >&2; exit 1; }
  if test -n "$namespace"; then
    test "$namespace" = "${BASH_REMATCH[1]}" && test "$tag" = "${BASH_REMATCH[3]}" || {
      echo 'Bot/backend namespaces or tags differ' >&2; exit 1;
    }
  fi
  namespace=${BASH_REMATCH[1]}
  tag=${BASH_REMATCH[3]}
  case "$service" in
    bot) bot_count=$((bot_count + 1)) ;;
    backend) backend_count=$((backend_count + 1)) ;;
  esac
done <<< "$images"
test "$bot_count" -eq 1 && test "$backend_count" -eq 1 || {
  echo 'Expected exactly one bot image and one backend image' >&2; exit 1;
}
printf 'Deploying %s at %s\n' "$namespace" "$tag"

# Pull failure (including missing GHCR authentication) stops before changing services.
# Keep PostgreSQL at its existing image during application updates; pull it on first install.
"${compose[@]}" pull backend bot
release_sha=''
while IFS=' ' read -r service image; do
  image_sha=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  [[ "$image_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Missing release revision on $image" >&2; exit 1; }
  if test -n "$release_sha"; then
    test "$release_sha" = "$image_sha" || { echo 'Bot/backend revisions differ; retry after publishing finishes or select an exact SHA' >&2; exit 1; }
  fi
  if test "$tag" != latest; then
    test "$tag" = "$image_sha" || { echo 'Image revision differs from requested SHA' >&2; exit 1; }
  fi
  release_sha=$image_sha
done <<< "$images"
if ! docker image inspect postgres:14 >/dev/null 2>&1; then
  "${compose[@]}" pull db
fi
# Use each published image's existing Zod schema before starting migrations/API/Discord.
for service in backend bot; do
  "${compose[@]}" run --rm --no-deps --pull never "$service" node --input-type=module -e "await import('./dist/config.js')"
done
"${compose[@]}" up -d --no-build --pull never
"${compose[@]}" ps

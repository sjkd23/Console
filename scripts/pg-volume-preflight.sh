#!/usr/bin/env bash
# Read-only host-side checks. Run on the production Droplet before selecting the override.
set -euo pipefail

pgdata=${CONSOLE_PGDATA_HOST_PATH:?Set CONSOLE_PGDATA_HOST_PATH to the Volume-backed PGDATA directory}
expected_uuid=${CONSOLE_EXPECTED_VOLUME_UUID:?Set CONSOLE_EXPECTED_VOLUME_UUID to the recorded Volume filesystem UUID}
container=${CONSOLE_DB_CONTAINER:-rotmg_db}

case "$pgdata" in
  /*) ;;
  *) echo 'PGDATA source must be an absolute path' >&2; exit 1 ;;
esac

test -d "$pgdata" || { echo "Missing PGDATA directory: $pgdata" >&2; exit 1; }
test ! -L "$pgdata" || { echo 'PGDATA source must not be a symlink' >&2; exit 1; }
volume_mount=$(dirname -- "$pgdata")
test "$volume_mount" != / || { echo 'PGDATA must be directly beneath a dedicated Volume mount' >&2; exit 1; }
mountpoint -q -- "$volume_mount" || { echo "Not a mountpoint: $volume_mount" >&2; exit 1; }
actual_uuid=$(findmnt -n -o UUID --target "$volume_mount")
test "$actual_uuid" = "$expected_uuid" || {
  echo "Wrong filesystem UUID at $volume_mount: $actual_uuid (expected $expected_uuid)" >&2
  exit 1
}

printf 'Destination mount: '
findmnt -n -o TARGET,SOURCE,FSTYPE --target "$volume_mount"
printf 'Destination PGDATA: %s\n' "$pgdata"
if test -f "$pgdata/PG_VERSION"; then
  printf 'Destination PG_VERSION: '
  cat -- "$pgdata/PG_VERSION"
  test "$(cat -- "$pgdata/PG_VERSION")" = 14 || { echo 'Destination is not PostgreSQL 14' >&2; exit 1; }
else
  test -z "$(find "$pgdata" -mindepth 1 -maxdepth 1 -print -quit)" || {
    echo 'Destination is nonempty but has no PG_VERSION; investigate before copying or starting PostgreSQL' >&2
    exit 1
  }
  echo 'Destination PGDATA is empty (expected before cold copy).'
fi

docker inspect "$container" --format 'Container image ID: {{.Image}}'
docker inspect "$container" --format 'Container mounts: {{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Type}}); {{end}}'
docker exec "$container" postgres --version
docker exec "$container" id postgres
docker exec "$container" du -sh /var/lib/postgresql/data
docker exec "$container" sh -c 'for path in /var/lib/postgresql/data/pg_wal /var/lib/postgresql/data/pg_tblspc/*; do if test -L "$path"; then printf "%s -> %s\n" "$path" "$(readlink "$path")"; fi; done'
echo 'Verify the reported mount source is the attached DigitalOcean Volume before proceeding.'

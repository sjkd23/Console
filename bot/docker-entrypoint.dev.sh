#!/bin/sh
set -eu

manifest_hash="$({ sha256sum package.json package-lock.json; } | sha256sum | cut -d ' ' -f 1)"
installed_hash=""

if [ -f node_modules/.package-manifests.sha256 ]; then
  installed_hash="$(cat node_modules/.package-manifests.sha256)"
fi

if [ "$manifest_hash" != "$installed_hash" ]; then
  echo "Dependency manifests changed; refreshing bot dependencies..."
  npm ci --no-audit --no-fund
  printf '%s\n' "$manifest_hash" > node_modules/.package-manifests.sha256
fi

exec "$@"

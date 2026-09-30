#!/usr/bin/env bash
# CI only: publish the exact images that passed validation, never deploy anything.
set -euo pipefail
repository=${CONSOLE_REPOSITORY:?Set CONSOLE_REPOSITORY}
sha=${CONSOLE_COMMIT_SHA:?Set CONSOLE_COMMIT_SHA}
ref=${CONSOLE_REF:?Set CONSOLE_REF}
[[ "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
namespace=${repository,,}
owner_type=$(gh api "repos/$repository" --jq .owner.type)
case "$owner_type" in
  User) package_owner="users/${repository%%/*}" ;;
  Organization) package_owner="orgs/${repository%%/*}" ;;
  *) echo 'Unknown repository owner type' >&2; exit 1 ;;
esac

for service in bot backend; do
  image="ghcr.io/$namespace-$service"
  error_file=$(mktemp)
  # Re-runs reuse a published SHA; never replace its digest with a fresh rebuild.
  # A new private package may reject registry lookups before its first push;
  # use the authenticated package API's explicit 404 for first publication.
  if versions=$(gh api "$package_owner/packages/container/${namespace#*/}-$service/versions?per_page=100" --paginate \
    --jq ".[] | select(.metadata.container.tags | index(\"$sha\")) | .id" 2>"$error_file"); then
    exists=true
  elif grep -q 'HTTP 404' "$error_file"; then
    exists=false
    versions=''
  else
    cat "$error_file" >&2
    rm -f -- "$error_file"
    echo 'Package lookup failed; refusing to overwrite a SHA tag' >&2
    exit 1
  fi
  if test "$exists" = true && test -n "$versions"; then
    docker buildx imagetools inspect "$image:$sha" >/dev/null
    printf 'Keeping existing immutable image %s:%s\n' "$image" "$sha"
  else
    docker tag "console-$service:validated" "$image:$sha"
    docker push "$image:$sha"
  fi
  rm -f -- "$error_file"
done

# Manual dispatch on another branch publishes SHA only. Use ancestry to keep a
# delayed successful main build/re-run from moving latest backwards.
if test "$ref" = refs/heads/main; then
  for service in bot backend; do
    image="ghcr.io/$namespace-$service"
    error_file=$(mktemp)
    promote=true
    if docker pull "$image:latest" >/dev/null 2>"$error_file"; then
      previous_sha=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image:latest")
      [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Existing latest has no valid revision label; investigate before replacing it' >&2; exit 1; }
      status=$(gh api "repos/$repository/compare/$previous_sha...$sha" --jq .status)
      case "$status" in
        ahead|identical) ;;
        behind) promote=false ;;
        *) echo 'Main history diverged; investigate before replacing latest' >&2; exit 1 ;;
      esac
    elif ! grep -Eq 'not found|manifest unknown|NAME_UNKNOWN|MANIFEST_UNKNOWN' "$error_file"; then
      cat "$error_file" >&2
      rm -f -- "$error_file"
      exit 1
    fi
    rm -f -- "$error_file"
    if test "$promote" = true; then
      docker buildx imagetools create --tag "$image:latest" "$image:$sha"
    else
      echo "Keeping newer latest image for $service."
    fi
  done
fi

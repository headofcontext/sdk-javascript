#!/usr/bin/env bash
# Copy the OpenAPI contract from the core repository (sibling checkout by default) and record
# the core commit it comes from in contract/core-ref. CI runs the contract tests against that
# exact commit, so the commit must be reachable from github.com/headofcontext/headofcontext.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${1:-$HERE/../headofcontext}"

if [ -n "$(git -C "$CORE" status --porcelain -- docs/openapi.json)" ]; then
  echo "refusing: $CORE/docs/openapi.json has uncommitted changes" >&2
  exit 1
fi
ref="$(git -C "$CORE" rev-parse HEAD)"
if ! git -C "$CORE" branch -r --contains "$ref" | grep -q .; then
  echo "refusing: core commit $ref is not on any remote branch yet, push it first" >&2
  exit 1
fi

if ! git -C "$CORE" merge-base --is-ancestor "$ref" origin/main 2>/dev/null; then
  echo "warning: $ref is not on the core's main yet; re-run once it is merged" >&2
fi

cp "$CORE/docs/openapi.json" "$HERE/contract/openapi.json"
echo "$ref" > "$HERE/contract/core-ref"
echo "contract synced from $CORE at $ref"

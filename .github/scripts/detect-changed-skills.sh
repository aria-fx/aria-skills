#!/usr/bin/env bash
set -euo pipefail

BASE_SHA="${BASE_SHA:-HEAD~1}"
HEAD_SHA="${HEAD_SHA:-HEAD}"
OUTPUT_KEY="${OUTPUT_KEY:-skills}"

if [[ "$BASE_SHA" =~ ^0+$ ]]; then
  BASE_SHA="$(git hash-object -t tree /dev/null)"
fi

CHANGED_SKILLS="$(
  git diff --name-only "$BASE_SHA" "$HEAD_SHA" \
    | sed -n 's#^skills/\([^/]*\)\(/.*\)\?$#\1#p' \
    | sort -u \
    | jq -R -s -c 'split("\n") | map(select(. != ""))'
)"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${OUTPUT_KEY}=${CHANGED_SKILLS}" >> "$GITHUB_OUTPUT"
fi

echo "$CHANGED_SKILLS"

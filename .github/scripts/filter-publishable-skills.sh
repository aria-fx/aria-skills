#!/usr/bin/env bash
set -euo pipefail

CHANGED_SKILLS="${CHANGED_SKILLS:-[]}"
OUTPUT_KEY="${OUTPUT_KEY:-publishable_skills}"

publishable='[]'

while IFS= read -r skill_name; do
  [[ -z "$skill_name" ]] && continue

  manifest_path="skills/${skill_name}/mcp-manifest.json"
  if [[ -f "$manifest_path" ]]; then
    publishable="$(jq -c --arg skill "$skill_name" '. + [$skill]' <<< "$publishable")"
  else
    echo "::notice::[${skill_name}] Skipping publish: mcp-manifest.json not found." >&2
  fi
done < <(jq -r '.[]' <<< "$CHANGED_SKILLS")

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${OUTPUT_KEY}=${publishable}" >> "$GITHUB_OUTPUT"
fi

echo "$publishable"

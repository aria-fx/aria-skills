#!/usr/bin/env bash
set -euo pipefail

CHANGED_SKILLS="${CHANGED_SKILLS:-[]}"
OUTPUT_KEY="${OUTPUT_KEY:-versions}"
BUMPED_OUTPUT_KEY="${BUMPED_OUTPUT_KEY:-bumped_skills}"

versions='{}'
bumped_skills='[]'

while IFS= read -r skill_name; do
  [[ -z "$skill_name" ]] && continue

  skill_dir="skills/${skill_name}"
  [[ -d "$skill_dir" ]] || continue

  version_file="${skill_dir}/version.txt"
  current_version=""

  if [[ -f "$version_file" ]]; then
    current_version="$(tr -d '\r\n' < "$version_file")"
  elif [[ -f "${skill_dir}/oasf-record.json" ]]; then
    current_version="$(jq -r '.version // empty' "${skill_dir}/oasf-record.json")"
  fi

  [[ -z "$current_version" ]] && current_version="0.0.0"

  if [[ ! "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "::error::[${skill_name}] Invalid semver value '${current_version}' in version source" >&2
    exit 1
  fi

  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  next_version="${major}.${minor}.$((patch + 1))"

  printf '%s\n' "$next_version" > "$version_file"

  versions="$(jq -c --arg skill "$skill_name" --arg version "$next_version" '. + {($skill): $version}' <<< "$versions")"
  bumped_skills="$(jq -c --arg skill "$skill_name" '. + [$skill]' <<< "$bumped_skills")"
done < <(jq -r '.[]' <<< "$CHANGED_SKILLS")

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${OUTPUT_KEY}=${versions}" >> "$GITHUB_OUTPUT"
  echo "${BUMPED_OUTPUT_KEY}=${bumped_skills}" >> "$GITHUB_OUTPUT"
fi

echo "$versions"

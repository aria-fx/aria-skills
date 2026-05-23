#!/usr/bin/env bash
set -euo pipefail

CHANGED_SKILLS="${CHANGED_SKILLS:-[]}"
OUTPUT_KEY="${OUTPUT_KEY:-eval_skills}"

eval_skill_names=()

while IFS= read -r skill_name; do
  [[ -z "$skill_name" ]] && continue

  record_path="skills/${skill_name}/oasf-record.json"
  if [[ ! -f "$record_path" ]]; then
    continue
  fi

  if ! jq -e '.has_evals == true' "$record_path" >/dev/null 2>&1; then
    continue
  fi

  evals_dir="skills/${skill_name}/evals"
  if [[ ! -d "$evals_dir" ]] || ! find "$evals_dir" -maxdepth 1 -type f \( -name "*.yaml" -o -name "*.yml" \) | grep -q .; then
    echo "::notice::[${skill_name}] has_evals=true but no evals/*.yaml|*.yml files found; skipping eval job for this skill." >&2
    continue
  fi

  eval_skill_names+=("$skill_name")
done < <(jq -r '.[]' <<< "$CHANGED_SKILLS")

EVAL_SKILLS="$(
  printf '%s\n' "${eval_skill_names[@]}" \
    | jq -R -s -c 'split("\n") | map(select(. != ""))'
)"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${OUTPUT_KEY}=${EVAL_SKILLS}" >> "$GITHUB_OUTPUT"
fi

echo "$EVAL_SKILLS"

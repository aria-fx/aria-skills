#!/usr/bin/env bash
set -euo pipefail

CHANGED_SKILLS="${CHANGED_SKILLS:-[]}"

while IFS= read -r skill_name; do
  evals_dir="skills/${skill_name}/evals"

  if [[ ! -d "$evals_dir" ]] || ! find "$evals_dir" -maxdepth 1 -type f \( -name "*.yaml" -o -name "*.yml" \) | grep -q .; then
    echo "::warning::[${skill_name}] Missing evals/*.yaml (warning only)"
  fi
done < <(jq -r '.[]' <<< "$CHANGED_SKILLS")

echo "Eval presence warning check complete."

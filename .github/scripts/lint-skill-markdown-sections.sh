#!/usr/bin/env bash
set -euo pipefail

CHANGED_SKILLS="${CHANGED_SKILLS:-[]}"
REQUIRED_SECTIONS=("## Description" "## Triggers" "## Usage")
FAILURES=()

while IFS= read -r skill_name; do
  skill_md_path="skills/${skill_name}/SKILL.md"

  if [[ ! -f "$skill_md_path" ]]; then
    FAILURES+=("[${skill_name}] Missing SKILL.md")
    continue
  fi

  for section in "${REQUIRED_SECTIONS[@]}"; do
    if ! tr -d '\r' < "$skill_md_path" | grep -Fxq "$section"; then
      FAILURES+=("[${skill_name}] SKILL.md missing required section: ${section}")
    fi
  done
done < <(jq -r '.[]' <<< "$CHANGED_SKILLS")

if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  echo "Skill markdown lint failed:"
  printf -- '- %s\n' "${FAILURES[@]}"
  exit 1
fi

echo "SKILL.md required section checks passed."

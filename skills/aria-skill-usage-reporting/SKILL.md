# aria-skill-usage-reporting

## Description

Generates provider and cloud usage evaluation reports from the outputs of the other usage skills. `generate_usage_report` renders Markdown or JSON reports covering totals, group breakdowns, governance conformance, anomalies, and derived findings. `summarize_findings` produces a plain-language headline with severity counts (high/medium/info) suitable for chat responses or issue comments.

## Triggers

- "Generate a usage report for last month"
- "Give me a Markdown report of provider spend and anomalies"
- "Summarize the findings from this usage evaluation"
- "Export the usage evaluation as JSON"

## Usage

Call `generate_usage_report` with `metrics` (output of `compute_usage_metrics`), optional `conformance` (output of `check_governance_conformance`, may include `budget_results`), optional `anomalies` (output of `detect_anomalies`), `format` (`markdown` | `json`, default `markdown`), and optional `title`. Use `summarize_findings` with the same inputs for a headline plus severity-ranked findings list.

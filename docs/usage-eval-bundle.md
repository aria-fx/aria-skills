# Provider & Cloud Usage Evaluation Bundle

The `provider-usage-evaluator` agent bundles four governed MCP skills that
evaluate LLM provider and cloud usage end-to-end: ingest raw usage exports,
normalize them into a common record shape, compute evaluation metrics, check
governance conformance, and produce reports.

- **Providers:** OpenAI, Anthropic, Gemini
- **Clouds:** AWS (Bedrock), GCP (Vertex AI), Azure (Azure OpenAI / AI Foundry), plus direct provider APIs
- **Report formats:** Markdown, JSON

All four skills and the agent carry `sensitivity_tier: confidential`
governance (cost and tenant-attribution data), full audit level, and the
`ai-governance` approval chain.

## Pipeline

```
raw export rows
  → aria-usage-ingest-normalize   (adapter → NormalizedUsageRecord[])
  → aria-usage-eval-metrics       (aggregations, comparisons, anomalies)
  → aria-usage-conformance        (policy + budget checks)
  → aria-usage-reporting          (markdown/json report, findings summary)
```

## NormalizedUsageRecord contract

`aria.dev/skills/usage-ingest-normalize` emits records with
`schema_version: 1.0.0`:

| Field | Type | Notes |
|-------|------|-------|
| `record_id` | string | From source row `record_id`/`id`, else generated UUID |
| `schema_version` | string | `1.0.0` |
| `provider` | string | `openai` \| `anthropic` \| `gemini` \| `unknown` |
| `cloud_service` | string | `aws` \| `gcp` \| `azure` \| `openai_direct` \| `anthropic_direct` \| `google_direct` |
| `model_family` | string | `gpt` \| `claude` \| `gemini` \| `unknown` (derived from model name) |
| `model_name` | string | Source model identifier |
| `region` | string | Defaults to `global` |
| `request_type` | string | `chat` \| `embedding` \| `completion` \| `tool` \| `batch` |
| `tokens_input` / `tokens_output` / `tokens_cached` | number | Token counts |
| `call_count` | number | Defaults to 1 |
| `latency_ms` | object | `{ p50, p95 }` |
| `error_class` | string \| null | e.g. `rate_limit`, `server_error` |
| `retry_count` | number | |
| `cost_usd` | number | Estimated from price table when source lacks cost |
| `cost_confidence` | string | `exact` \| `estimated` \| `unknown` |
| `timestamp` | string | ISO 8601 |
| `tenant_id` | string | From row or ingest option; `unattributed` fallback |
| `attribution_confidence` | string | `high` when tenant identity present, else `low` |
| `source_adapter` | string | Adapter that produced the record |

## Adapters

| Adapter | Provider | `cloud_service` | Source |
|---------|----------|-----------------|--------|
| `openai_direct` | openai | `openai_direct` | OpenAI usage API / dashboard CSV |
| `anthropic_direct` | anthropic | `anthropic_direct` | Anthropic Console usage export |
| `google_direct` | gemini | `google_direct` | Google AI Studio / Gemini API export |
| `aws_bedrock` | derived from model | `aws` | Bedrock invocation logs / CUR export |
| `gcp_vertex` | derived from model | `gcp` | Vertex AI usage export (BigQuery billing / prediction logs) |
| `azure_openai` | openai | `azure` | Azure OpenAI / AI Foundry usage export |

## Tool reference

### `aria.dev/skills/usage-ingest-normalize` (confidential)

| Tool | Input | Output |
|------|-------|--------|
| `ingest_usage_export` | `adapter`, `rows[]`, optional `tenant_id` | `records[]` (NormalizedUsageRecord), per-row `errors[]`, counts |
| `list_supported_adapters` | — | Adapter names with provider/cloud mapping |
| `validate_normalized_records` | `records[]` | Per-record validity against the contract |

### `aria.dev/skills/usage-eval-metrics` (confidential)

| Tool | Input | Output |
|------|-------|--------|
| `compute_usage_metrics` | `records[]`, `group_by[]` | Totals + per-group cost/token/latency/error aggregations. Groupable: `provider`, `cloud_service`, `model_family`, `model_name`, `region`, `tenant_id`, `request_type` |
| `compare_periods` | `current_records[]`, `baseline_records[]`, `group_by[]` | Deltas and percent changes between periods |
| `detect_anomalies` | `records[]`, `group_by[]`, optional `thresholds` | Anomalies: cost spike vs peer-group mean (default 2.0×), error rate (>5%), latency p95 (>5000 ms), retry ratio (>0.2) |

### `aria.dev/skills/usage-conformance` (confidential)

| Tool | Input | Output |
|------|-------|--------|
| `check_governance_conformance` | `records[]`, `policy` | Violations against rules: `allowed_providers`, `allowed_models` (exact or `*`-prefix), `blocked_models`, `allowed_regions`, `require_tenant_attribution`, `max_cost_confidence` |
| `evaluate_budget_policy` | `records[]`, `budgets[]` (`{scope, id, limit_usd}`), optional `warning_ratio` (default 0.8) | Per-budget spend, utilization, status `ok` \| `warning` \| `over`. Scopes: `provider`, `tenant_id`, `model_family`, `cloud_service` |
| `list_policy_rules` | — | Supported rules and budget scopes |

### `aria.dev/skills/usage-reporting` (confidential)

| Tool | Input | Output |
|------|-------|--------|
| `generate_usage_report` | `metrics` (required), optional `conformance`, `anomalies`, `title`, `format` (`markdown` \| `json`) | Full report: totals, breakdown, conformance, anomalies, findings |
| `summarize_findings` | `metrics`, optional `conformance`, `anomalies` | Headline + severity counts (`high`/`medium`/`info`) + findings list |

## Agent composition

`agents/provider-usage-evaluator/` wires all four skills:

- `oasf-record.json` — `aria.dev/agents/provider-usage-evaluator@1.0.0`, four
  `mcp_server` modules, domains `platform/aria/finops` and
  `platform/aria/governance`, locator
  `ghcr.io/aria-fx/agents/provider-usage-evaluator:1.0.0`
- `oasf-governance.json` — confidential tier, full audit, ceiling
  `highly_confidential`, SOC2, `ai-governance` approval
- `mcp-config.json` — servers `aria-usage-ingest-normalize`,
  `aria-usage-eval-metrics`, `aria-usage-conformance`, `aria-usage-reporting`

The orchestrator (`orchestrator/mcp-config.json`) registers the same four
servers and an `agentCompositions.provider-usage-evaluator` entry listing them
as `required_servers`.

## CLI preset contract (aria#13)

The `aria` CLI scaffold preset for this bundle should use:

- **Preset name:** `provider-usage-evaluator`
- **Agent ref:** `aria.dev/agents/provider-usage-evaluator@1.0.0`
- **Required MCP servers** (keys must match orchestrator/agent configs):
  `aria-usage-ingest-normalize`, `aria-usage-eval-metrics`,
  `aria-usage-conformance`, `aria-usage-reporting`
- **Skill OCI artifacts:** `ghcr.io/aria-fx/aria-skills/usage-{ingest-normalize,eval-metrics,conformance,reporting}`
- **Expected inputs:** provider/cloud usage export rows (any supported
  adapter) plus optional governance policy and budget definitions
- **Expected outputs:** NormalizedUsageRecord arrays, metric aggregations,
  conformance/budget results, and Markdown or JSON usage reports
- **Governance defaults for scaffolded consumers:** `sensitivity_tier`
  `confidential`, `audit_level` `full`, approval chain must include
  `ai-governance`

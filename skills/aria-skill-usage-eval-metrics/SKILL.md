# aria-skill-usage-eval-metrics

## Description

Computes evaluation metrics over `NormalizedUsageRecord` data produced by the usage-ingest-normalize skill. Provides cost, token, cache-hit, latency, error-rate, and retry aggregations grouped by provider, cloud service, model, region, tenant, or request type; period-over-period comparison with deltas and percentage change; and anomaly detection for cost spikes, elevated error rates, latency breaches, and retry storms.

## Triggers

- "Compute usage metrics grouped by provider and model"
- "Compare this month's LLM usage to last month"
- "Detect anomalies in our Bedrock usage"
- "What is our cost per 1k tokens by tenant?"

## Usage

Call `compute_usage_metrics` with `records` and an optional `group_by` array (`provider`, `cloud_service`, `model_family`, `model_name`, `region`, `tenant_id`, `request_type`). Use `compare_periods` with `current` and `baseline` record arrays for trend deltas, and `detect_anomalies` with optional `thresholds` overrides (`cost_spike_ratio`, `error_rate`, `latency_p95_ms`, `retry_ratio`).

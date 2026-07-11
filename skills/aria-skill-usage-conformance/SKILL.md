# aria-skill-usage-conformance

## Description

Checks `NormalizedUsageRecord` data against governance policies and budget limits. Supports allowed-provider, allowed/blocked-model (exact or `*` prefix), and allowed-region rules, plus tenant-attribution and cost-confidence requirements. Budget evaluation reports spend, utilization, and ok/warning/over status for budgets scoped to provider, tenant, model family, or cloud service.

## Triggers

- "Check our LLM usage against the approved model list"
- "Are any records running in non-approved regions?"
- "Evaluate this month's spend against team budgets"
- "Which tenants are over budget?"

## Usage

Call `check_governance_conformance` with `records` and a `policy` object (`allowed_providers`, `allowed_models`, `blocked_models`, `allowed_regions`, `require_tenant_attribution`, `forbid_unknown_cost`). Use `evaluate_budget_policy` with `records`, `budgets` (`[{ scope, id, limit_usd }]`, scopes: `provider`, `tenant_id`, `model_family`, `cloud_service`), and optional `warning_ratio`. Call `list_policy_rules` to enumerate supported rules and scopes.

import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

const record = (overrides = {}) => ({
  record_id: "r1",
  provider: "openai",
  cloud_service: "azure",
  model_family: "gpt",
  model_name: "gpt-4o",
  region: "eastus",
  tenant_id: "team-a",
  attribution_confidence: "high",
  cost_confidence: "exact",
  cost_usd: 10,
  ...overrides
});

test("check_governance_conformance passes compliant records", async () => {
  const result = await handleToolCall("check_governance_conformance", {
    records: [record()],
    policy: {
      allowed_providers: ["openai", "anthropic"],
      allowed_models: ["gpt-4o", "claude-*"],
      blocked_models: ["gpt-3.5*"],
      allowed_regions: ["eastus", "us-east-1"],
      require_tenant_attribution: true,
      forbid_unknown_cost: true
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.compliant, true);
  assert.equal(result.violation_count, 0);
  assert.equal(result.records_checked, 1);
});

test("check_governance_conformance flags every rule violation", async () => {
  const result = await handleToolCall("check_governance_conformance", {
    records: [
      record({
        record_id: "bad",
        provider: "gemini",
        model_name: "gpt-3.5-turbo",
        region: "westeurope",
        attribution_confidence: "low",
        cost_confidence: "unknown"
      })
    ],
    policy: {
      allowed_providers: ["openai"],
      allowed_models: ["gpt-4o"],
      blocked_models: ["gpt-3.5*"],
      allowed_regions: ["eastus"],
      require_tenant_attribution: true,
      forbid_unknown_cost: true
    }
  });

  assert.equal(result.compliant, false);
  const rules = result.violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, [
    "allowed_models",
    "allowed_providers",
    "allowed_regions",
    "blocked_models",
    "max_cost_confidence",
    "require_tenant_attribution"
  ]);
  assert.ok(result.violations.every((v) => v.record_id === "bad" && v.detail.length > 0));
});

test("check_governance_conformance treats missing policy as compliant and validates input", async () => {
  const noPolicy = await handleToolCall("check_governance_conformance", { records: [record()] });
  assert.equal(noPolicy.compliant, true);

  const empty = await handleToolCall("check_governance_conformance", { records: [] });
  assert.equal(empty.valid, false);

  const badPolicy = await handleToolCall("check_governance_conformance", {
    records: [record()],
    policy: "nope"
  });
  assert.equal(badPolicy.valid, false);
});

test("check_governance_conformance supports wildcard allowed_models", async () => {
  const result = await handleToolCall("check_governance_conformance", {
    records: [record({ model_name: "claude-sonnet-4-6", provider: "anthropic" })],
    policy: { allowed_models: ["claude-*"] }
  });
  assert.equal(result.compliant, true);
});

test("evaluate_budget_policy reports ok, warning, and over statuses", async () => {
  const result = await handleToolCall("evaluate_budget_policy", {
    records: [
      record({ provider: "openai", cost_usd: 50 }),
      record({ provider: "anthropic", tenant_id: "team-b", cost_usd: 85 }),
      record({ provider: "gemini", model_family: "gemini", cost_usd: 120 })
    ],
    budgets: [
      { scope: "provider", id: "openai", limit_usd: 100 },
      { scope: "tenant_id", id: "team-b", limit_usd: 100 },
      { scope: "model_family", id: "gemini", limit_usd: 100 }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.budgets_evaluated, 3);
  assert.equal(result.over_budget_count, 1);
  assert.deepEqual(result.results.map((r) => r.status), ["ok", "warning", "over"]);
  assert.equal(result.results[0].utilization, 0.5);
  assert.equal(result.results[2].spend_usd, 120);
});

test("evaluate_budget_policy honors warning_ratio and validates input", async () => {
  const strict = await handleToolCall("evaluate_budget_policy", {
    records: [record({ cost_usd: 50 })],
    budgets: [{ scope: "provider", id: "openai", limit_usd: 100 }],
    warning_ratio: 0.4
  });
  assert.equal(strict.results[0].status, "warning");

  const noRecords = await handleToolCall("evaluate_budget_policy", { records: [], budgets: [] });
  assert.equal(noRecords.valid, false);

  const noBudgets = await handleToolCall("evaluate_budget_policy", { records: [record()], budgets: [] });
  assert.equal(noBudgets.valid, false);

  const badScope = await handleToolCall("evaluate_budget_policy", {
    records: [record()],
    budgets: [{ scope: "favorite_color", id: "blue", limit_usd: 10 }]
  });
  assert.equal(badScope.valid, false);
  assert.match(badScope.error, /Invalid budget scope/);

  const badLimit = await handleToolCall("evaluate_budget_policy", {
    records: [record()],
    budgets: [{ scope: "provider", id: "openai", limit_usd: 0 }]
  });
  assert.equal(badLimit.valid, false);
});

test("list_policy_rules enumerates rules and budget scopes", async () => {
  const result = await handleToolCall("list_policy_rules", {});
  assert.equal(result.valid, true);
  assert.ok(result.rules.length >= 6);
  assert.ok(result.rules.every((r) => r.rule && r.description));
  assert.deepEqual(result.budget_scopes, ["provider", "tenant_id", "model_family", "cloud_service"]);
});

test("unknown tool raises an error", async () => {
  await assert.rejects(() => handleToolCall("nope", {}), /Unknown tool/);
});

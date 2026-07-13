import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

const metrics = () => ({
  totals: {
    cost_usd: 6.0,
    call_count: 20,
    total_tokens: 3000,
    cost_per_1k_tokens: 2,
    error_rate: 0.5,
    cache_hit_rate: 0.2
  },
  groups: [
    {
      dimensions: { provider: "anthropic" },
      metrics: { cost_usd: 5, call_count: 10, total_tokens: 1500, error_rate: 1 }
    },
    {
      dimensions: { provider: "openai" },
      metrics: { cost_usd: 1, call_count: 10, total_tokens: 1500, error_rate: 0 }
    }
  ]
});

const conformance = () => ({
  compliant: false,
  records_checked: 2,
  violation_count: 1,
  violations: [{ rule: "allowed_regions", record_id: "r1", detail: "Region 'westeurope' is not allowed" }],
  budget_results: [
    { scope: "provider", id: "openai", limit_usd: 100, spend_usd: 120, utilization: 1.2, status: "over" },
    { scope: "provider", id: "anthropic", limit_usd: 100, spend_usd: 10, utilization: 0.1, status: "ok" }
  ]
});

const anomalies = () => ({
  anomaly_count: 1,
  anomalies: [
    { type: "cost_spike", severity: "high", scope: { provider: "gemini", model_name: "gemini-2.0-pro" }, detail: "Cost spike detected" }
  ]
});

test("generate_usage_report renders markdown with all sections", async () => {
  const result = await handleToolCall("generate_usage_report", {
    metrics: metrics(),
    conformance: conformance(),
    anomalies: anomalies(),
    title: "July Usage"
  });

  assert.equal(result.valid, true);
  assert.equal(result.format, "markdown");
  assert.match(result.report, /# July Usage/);
  assert.match(result.report, /## Totals/);
  assert.match(result.report, /\| Cost \| \$6\.00 \|/);
  assert.match(result.report, /## Breakdown/);
  assert.match(result.report, /anthropic/);
  assert.match(result.report, /## Governance Conformance/);
  assert.match(result.report, /allowed_regions/);
  assert.match(result.report, /## Anomalies/);
  assert.match(result.report, /cost_spike/);
  assert.match(result.report, /## Findings/);
});

test("generate_usage_report emits structured JSON", async () => {
  const result = await handleToolCall("generate_usage_report", {
    metrics: metrics(),
    conformance: conformance(),
    anomalies: anomalies(),
    format: "json"
  });

  assert.equal(result.valid, true);
  assert.equal(result.format, "json");
  assert.equal(result.report.title, "Provider & Cloud Usage Evaluation Report");
  assert.equal(result.report.totals.cost_usd, 6.0);
  assert.equal(result.report.groups.length, 2);
  assert.ok(result.report.findings.length > 0);
  assert.ok(result.report.generated_at);
});

test("generate_usage_report handles metrics-only input and no-anomaly sections", async () => {
  const result = await handleToolCall("generate_usage_report", {
    metrics: { totals: { cost_usd: 1, call_count: 1, total_tokens: 100, cost_per_1k_tokens: 10, error_rate: 0, cache_hit_rate: 0 }, groups: [] },
    anomalies: { anomaly_count: 0, anomalies: [] }
  });

  assert.equal(result.valid, true);
  assert.match(result.report, /No anomalies detected/);
  assert.doesNotMatch(result.report, /## Breakdown/);
  assert.doesNotMatch(result.report, /## Governance Conformance/);
});

test("generate_usage_report validates format and metrics", async () => {
  const badFormat = await handleToolCall("generate_usage_report", { metrics: metrics(), format: "pdf" });
  assert.equal(badFormat.valid, false);
  assert.match(badFormat.error, /Invalid format/);

  const badMetrics = await handleToolCall("generate_usage_report", { metrics: "nope" });
  assert.equal(badMetrics.valid, false);
});

test("summarize_findings flags high severity issues in headline", async () => {
  const result = await handleToolCall("summarize_findings", {
    metrics: metrics(),
    conformance: conformance(),
    anomalies: anomalies()
  });

  assert.equal(result.valid, true);
  assert.match(result.headline, /high-severity/);
  assert.ok(result.severity_counts.high >= 3);
  assert.equal(result.finding_count, result.findings.length);
});

test("summarize_findings reports healthy usage and medium-only cases", async () => {
  const healthy = await handleToolCall("summarize_findings", {
    metrics: { totals: { cost_usd: 1, call_count: 1, total_tokens: 100, cost_per_1k_tokens: 10, error_rate: 0, cache_hit_rate: 0 }, groups: [] }
  });
  assert.match(healthy.headline, /healthy/);

  const medium = await handleToolCall("summarize_findings", {
    metrics: { totals: { cost_usd: 1, call_count: 1, total_tokens: 100, cost_per_1k_tokens: 10, error_rate: 0.01, cache_hit_rate: 0 }, groups: [] }
  });
  assert.match(medium.headline, /medium-severity/);

  const invalid = await handleToolCall("summarize_findings", { metrics: [] });
  assert.equal(invalid.valid, false);
});

test("unknown tool raises an error", async () => {
  await assert.rejects(() => handleToolCall("nope", {}), /Unknown tool/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall, aggregate } from "../server.mjs";

const record = (overrides = {}) => ({
  record_id: "r",
  provider: "openai",
  cloud_service: "openai_direct",
  model_family: "gpt",
  model_name: "gpt-4o",
  region: "us-east-1",
  tenant_id: "team-a",
  request_type: "chat",
  tokens_input: 1000,
  tokens_output: 500,
  tokens_cached: 200,
  call_count: 10,
  latency_ms: { p50: 100, p95: 400 },
  error_class: null,
  retry_count: 0,
  cost_usd: 1.0,
  ...overrides
});

test("compute_usage_metrics aggregates totals and groups sorted by cost", async () => {
  const result = await handleToolCall("compute_usage_metrics", {
    records: [
      record({ cost_usd: 1.0 }),
      record({ provider: "anthropic", model_name: "claude-sonnet-4-6", cost_usd: 5.0, error_class: "rate_limit" })
    ],
    group_by: ["provider"]
  });

  assert.equal(result.valid, true);
  assert.equal(result.record_count, 2);
  assert.equal(result.totals.cost_usd, 6.0);
  assert.equal(result.totals.call_count, 20);
  assert.equal(result.totals.total_tokens, 3000);
  assert.equal(result.totals.cache_hit_rate, 0.2);
  assert.equal(result.totals.error_rate, 0.5);
  assert.equal(result.totals.cost_per_1k_tokens, 2);

  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].dimensions.provider, "anthropic");
  assert.equal(result.groups[1].dimensions.provider, "openai");
});

test("compute_usage_metrics rejects empty records and bad group_by", async () => {
  const empty = await handleToolCall("compute_usage_metrics", { records: [] });
  assert.equal(empty.valid, false);

  const badGroup = await handleToolCall("compute_usage_metrics", {
    records: [record()],
    group_by: ["favorite_color"]
  });
  assert.equal(badGroup.valid, false);
  assert.match(badGroup.error, /Invalid group_by/);
});

test("compare_periods reports deltas and pct change", async () => {
  const result = await handleToolCall("compare_periods", {
    current: [record({ cost_usd: 2.0 })],
    baseline: [record({ cost_usd: 1.0 })]
  });

  assert.equal(result.valid, true);
  assert.equal(result.deltas.cost_usd.delta, 1.0);
  assert.equal(result.deltas.cost_usd.pct_change, 100);
  assert.equal(result.deltas.call_count.pct_change, 0);

  const zeroBaseline = await handleToolCall("compare_periods", {
    current: [record()],
    baseline: [record({ cost_usd: 0, tokens_input: 0, tokens_output: 0, tokens_cached: 0, call_count: 0 })]
  });
  assert.equal(zeroBaseline.deltas.cost_usd.pct_change, null);

  const invalid = await handleToolCall("compare_periods", { current: [], baseline: "nope" });
  assert.equal(invalid.valid, false);
});

test("detect_anomalies flags cost spikes, error rates, latency, and retries", async () => {
  const result = await handleToolCall("detect_anomalies", {
    records: [
      record({ model_name: "gpt-4o-mini", cost_usd: 0.5 }),
      record({ model_name: "gpt-4o-mini", cost_usd: 0.5 }),
      record({
        provider: "gemini",
        model_name: "gemini-2.0-pro",
        cost_usd: 50,
        error_class: "server_error",
        retry_count: 8,
        latency_ms: { p50: 2000, p95: 9000 }
      })
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.groups_analyzed, 2);
  const types = result.anomalies.map((a) => a.type).sort();
  assert.deepEqual(types, ["cost_spike", "error_rate", "latency", "retry_ratio"]);
  assert.ok(result.anomalies.every((a) => a.scope.provider && a.scope.model_name));
});

test("detect_anomalies honors threshold overrides and validates input", async () => {
  const quiet = await handleToolCall("detect_anomalies", {
    records: [record({ latency_ms: { p50: 100, p95: 6000 } })],
    thresholds: { latency_p95_ms: 10000 }
  });
  assert.equal(quiet.anomaly_count, 0);
  assert.equal(quiet.thresholds.latency_p95_ms, 10000);

  const invalid = await handleToolCall("detect_anomalies", { records: [] });
  assert.equal(invalid.valid, false);
});

test("aggregate handles empty input and missing optional fields", () => {
  const empty = aggregate([]);
  assert.equal(empty.cost_usd, 0);
  assert.equal(empty.error_rate, 0);
  assert.equal(empty.cost_per_1k_tokens, 0);

  const sparse = aggregate([{ cost_usd: 1 }]);
  assert.equal(sparse.call_count, 1);
  assert.equal(sparse.total_tokens, 0);
});

test("unknown tool raises an error", async () => {
  await assert.rejects(() => handleToolCall("nope", {}), /Unknown tool/);
});

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// aria-skill-usage-eval-metrics — MCP Server
// Computes evaluation metrics over NormalizedUsageRecord data:
// cost/token/latency/error aggregations, period comparisons,
// and anomaly detection.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

const GROUPABLE_FIELDS = [
  "provider", "cloud_service", "model_family", "model_name",
  "region", "tenant_id", "request_type"
];

const DEFAULT_THRESHOLDS = {
  cost_spike_ratio: 2.0,
  error_rate: 0.05,
  latency_p95_ms: 5000,
  retry_ratio: 0.2
};

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function aggregate(records) {
  const totals = {
    cost_usd: 0,
    call_count: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_cached: 0,
    error_calls: 0,
    retry_count: 0,
    latency_p50_weighted: 0,
    latency_p95_max: 0
  };

  for (const record of records) {
    const calls = Number(record.call_count ?? 1);
    totals.cost_usd += Number(record.cost_usd ?? 0);
    totals.call_count += calls;
    totals.tokens_input += Number(record.tokens_input ?? 0);
    totals.tokens_output += Number(record.tokens_output ?? 0);
    totals.tokens_cached += Number(record.tokens_cached ?? 0);
    totals.retry_count += Number(record.retry_count ?? 0);
    if (record.error_class) totals.error_calls += calls;
    totals.latency_p50_weighted += Number(record.latency_ms?.p50 ?? 0) * calls;
    totals.latency_p95_max = Math.max(totals.latency_p95_max, Number(record.latency_ms?.p95 ?? 0));
  }

  const totalTokens = totals.tokens_input + totals.tokens_output;
  return {
    cost_usd: round(totals.cost_usd),
    call_count: totals.call_count,
    tokens_input: totals.tokens_input,
    tokens_output: totals.tokens_output,
    tokens_cached: totals.tokens_cached,
    total_tokens: totalTokens,
    cache_hit_rate: totals.tokens_input > 0
      ? round(totals.tokens_cached / totals.tokens_input, 4)
      : 0,
    error_rate: totals.call_count > 0
      ? round(totals.error_calls / totals.call_count, 4)
      : 0,
    retry_ratio: totals.call_count > 0
      ? round(totals.retry_count / totals.call_count, 4)
      : 0,
    avg_latency_p50_ms: totals.call_count > 0
      ? round(totals.latency_p50_weighted / totals.call_count, 2)
      : 0,
    max_latency_p95_ms: totals.latency_p95_max,
    cost_per_1k_tokens: totalTokens > 0
      ? round((totals.cost_usd / totalTokens) * 1000)
      : 0
  };
}

function groupRecords(records, groupBy) {
  const groups = new Map();
  for (const record of records) {
    const key = groupBy.map((field) => record[field] ?? "unknown").join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function computeUsageMetrics(args) {
  const { records, group_by } = args;
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: "'records' must be a non-empty array of NormalizedUsageRecord objects" };
  }

  const groupBy = Array.isArray(group_by) && group_by.length > 0 ? group_by : ["provider"];
  const invalidFields = groupBy.filter((field) => !GROUPABLE_FIELDS.includes(field));
  if (invalidFields.length > 0) {
    return {
      valid: false,
      error: `Invalid group_by field(s): ${invalidFields.join(", ")}. Allowed: ${GROUPABLE_FIELDS.join(", ")}`
    };
  }

  const groups = [];
  for (const [key, groupRecordsList] of groupRecords(records, groupBy)) {
    const dimensions = {};
    key.split("|").forEach((value, index) => {
      dimensions[groupBy[index]] = value;
    });
    groups.push({ dimensions, metrics: aggregate(groupRecordsList) });
  }
  groups.sort((a, b) => b.metrics.cost_usd - a.metrics.cost_usd);

  return {
    valid: true,
    record_count: records.length,
    group_by: groupBy,
    totals: aggregate(records),
    groups
  };
}

function comparePeriods(args) {
  const { current, baseline } = args;
  if (!Array.isArray(current) || !Array.isArray(baseline)) {
    return { valid: false, error: "'current' and 'baseline' must be arrays of NormalizedUsageRecord objects" };
  }

  const currentTotals = aggregate(current);
  const baselineTotals = aggregate(baseline);
  const deltas = {};

  for (const key of ["cost_usd", "call_count", "total_tokens", "error_rate", "avg_latency_p50_ms", "cost_per_1k_tokens"]) {
    const before = baselineTotals[key];
    const after = currentTotals[key];
    deltas[key] = {
      baseline: before,
      current: after,
      delta: round(after - before),
      pct_change: before !== 0 ? round(((after - before) / before) * 100, 2) : null
    };
  }

  return { valid: true, current: currentTotals, baseline: baselineTotals, deltas };
}

function detectAnomalies(args) {
  const { records, thresholds } = args;
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: "'records' must be a non-empty array of NormalizedUsageRecord objects" };
  }

  const limits = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const anomalies = [];

  const groups = groupRecords(records, ["provider", "model_name"]);
  const groupMetrics = [...groups.entries()].map(([key, list]) => ({
    key,
    metrics: aggregate(list)
  }));

  const totalCost = groupMetrics.reduce((sum, g) => sum + g.metrics.cost_usd, 0);

  for (const { key, metrics } of groupMetrics) {
    const [provider, model] = key.split("|");
    const scope = { provider, model_name: model };

    // Baseline for a spike is the mean cost of the *other* groups; including
    // the group itself dilutes the baseline and hides large single-group spikes.
    const peerMeanCost = groupMetrics.length > 1
      ? (totalCost - metrics.cost_usd) / (groupMetrics.length - 1)
      : 0;
    if (peerMeanCost > 0 && metrics.cost_usd > peerMeanCost * limits.cost_spike_ratio) {
      anomalies.push({
        type: "cost_spike",
        severity: "high",
        scope,
        detail: `Cost ${metrics.cost_usd} exceeds ${limits.cost_spike_ratio}x the mean peer group cost (${round(peerMeanCost)})`
      });
    }
    if (metrics.error_rate > limits.error_rate) {
      anomalies.push({
        type: "error_rate",
        severity: "high",
        scope,
        detail: `Error rate ${metrics.error_rate} exceeds threshold ${limits.error_rate}`
      });
    }
    if (metrics.max_latency_p95_ms > limits.latency_p95_ms) {
      anomalies.push({
        type: "latency",
        severity: "medium",
        scope,
        detail: `p95 latency ${metrics.max_latency_p95_ms}ms exceeds threshold ${limits.latency_p95_ms}ms`
      });
    }
    if (metrics.retry_ratio > limits.retry_ratio) {
      anomalies.push({
        type: "retry_ratio",
        severity: "medium",
        scope,
        detail: `Retry ratio ${metrics.retry_ratio} exceeds threshold ${limits.retry_ratio}`
      });
    }
  }

  return {
    valid: true,
    thresholds: limits,
    groups_analyzed: groupMetrics.length,
    anomaly_count: anomalies.length,
    anomalies
  };
}

// ── MCP Server ────────────────────────────────────────────

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "compute_usage_metrics":
      return computeUsageMetrics(args);
    case "compare_periods":
      return comparePeriods(args);
    case "detect_anomalies":
      return detectAnomalies(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-usage-eval-metrics", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "compute_usage_metrics",
        description: "Compute cost, token, latency, and error metrics over NormalizedUsageRecord data, with optional grouping by provider, model, region, tenant, or request type.",
        inputSchema: {
          type: "object",
          properties: {
            records: { type: "array", description: "NormalizedUsageRecord objects" },
            group_by: { type: "array", items: { type: "string" }, description: "Dimensions to group by (default: provider)" }
          },
          required: ["records"]
        }
      },
      {
        name: "compare_periods",
        description: "Compare aggregate usage metrics between a current and baseline period of NormalizedUsageRecord data.",
        inputSchema: {
          type: "object",
          properties: {
            current: { type: "array", description: "Current period records" },
            baseline: { type: "array", description: "Baseline period records" }
          },
          required: ["current", "baseline"]
        }
      },
      {
        name: "detect_anomalies",
        description: "Detect cost spikes, elevated error rates, latency breaches, and retry storms across provider/model groups.",
        inputSchema: {
          type: "object",
          properties: {
            records: { type: "array", description: "NormalizedUsageRecord objects" },
            thresholds: { type: "object", description: "Optional overrides: cost_spike_ratio, error_rate, latency_p95_ms, retry_ratio" }
          },
          required: ["records"]
        }
      }
    ]
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: error?.message || String(error) }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// aria-skill-usage-reporting — MCP Server
// Generates usage evaluation reports (Markdown or JSON) and
// plain-language summaries from metrics, conformance, and
// anomaly results produced by the other usage skills.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

const FORMATS = ["markdown", "json"];

function formatUsd(value) {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

function formatPct(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function buildFindings({ metrics, conformance, anomalies }) {
  const findings = [];

  if (metrics?.totals) {
    const t = metrics.totals;
    findings.push({
      category: "usage",
      severity: "info",
      message: `Total spend ${formatUsd(t.cost_usd)} across ${t.call_count ?? 0} calls and ${t.total_tokens ?? 0} tokens (${formatUsd(t.cost_per_1k_tokens)} per 1k tokens).`
    });
    if (Number(t.error_rate ?? 0) > 0) {
      findings.push({
        category: "reliability",
        severity: Number(t.error_rate) > 0.05 ? "high" : "medium",
        message: `Overall error rate is ${formatPct(t.error_rate)}.`
      });
    }
    if (Number(t.cache_hit_rate ?? 0) > 0) {
      findings.push({
        category: "efficiency",
        severity: "info",
        message: `Cache hit rate is ${formatPct(t.cache_hit_rate)} of input tokens.`
      });
    }
  }

  if (Array.isArray(metrics?.groups) && metrics.groups.length > 0) {
    const top = metrics.groups[0];
    const dims = Object.entries(top.dimensions ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    findings.push({
      category: "usage",
      severity: "info",
      message: `Top cost group (${dims}) accounts for ${formatUsd(top.metrics?.cost_usd)}.`
    });
  }

  if (conformance) {
    if (conformance.compliant === false) {
      findings.push({
        category: "governance",
        severity: "high",
        message: `${conformance.violation_count} governance violation(s) found across ${conformance.records_checked} records.`
      });
    } else if (conformance.compliant === true) {
      findings.push({
        category: "governance",
        severity: "info",
        message: `All ${conformance.records_checked} records passed governance conformance checks.`
      });
    }
    for (const result of conformance.budget_results ?? []) {
      if (result.status !== "ok") {
        findings.push({
          category: "budget",
          severity: result.status === "over" ? "high" : "medium",
          message: `Budget ${result.scope}='${result.id}' is at ${formatPct(result.utilization)} of ${formatUsd(result.limit_usd)} (${result.status}).`
        });
      }
    }
  }

  for (const anomaly of anomalies?.anomalies ?? []) {
    const scope = Object.entries(anomaly.scope ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    findings.push({
      category: "anomaly",
      severity: anomaly.severity ?? "medium",
      message: `[${anomaly.type}] ${anomaly.detail}${scope ? ` (${scope})` : ""}`
    });
  }

  return findings;
}

function renderMarkdown({ title, generatedAt, metrics, conformance, anomalies, findings }) {
  const lines = [`# ${title}`, "", `_Generated: ${generatedAt}_`, ""];

  if (metrics?.totals) {
    const t = metrics.totals;
    lines.push("## Totals", "");
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Cost | ${formatUsd(t.cost_usd)} |`);
    lines.push(`| Calls | ${t.call_count ?? 0} |`);
    lines.push(`| Total tokens | ${t.total_tokens ?? 0} |`);
    lines.push(`| Cost per 1k tokens | ${formatUsd(t.cost_per_1k_tokens)} |`);
    lines.push(`| Error rate | ${formatPct(t.error_rate)} |`);
    lines.push(`| Cache hit rate | ${formatPct(t.cache_hit_rate)} |`);
    lines.push("");
  }

  if (Array.isArray(metrics?.groups) && metrics.groups.length > 0) {
    const dimensionKeys = Object.keys(metrics.groups[0].dimensions ?? {});
    lines.push("## Breakdown", "");
    lines.push(`| ${[...dimensionKeys, "Cost", "Calls", "Tokens", "Error rate"].join(" | ")} |`);
    lines.push(`| ${[...dimensionKeys, "Cost", "Calls", "Tokens", "Error rate"].map(() => "---").join(" | ")} |`);
    for (const group of metrics.groups) {
      const cells = dimensionKeys.map((key) => String(group.dimensions?.[key] ?? ""));
      const m = group.metrics ?? {};
      cells.push(formatUsd(m.cost_usd), String(m.call_count ?? 0), String(m.total_tokens ?? 0), formatPct(m.error_rate));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (conformance) {
    lines.push("## Governance Conformance", "");
    lines.push(conformance.compliant
      ? `All ${conformance.records_checked} records compliant.`
      : `${conformance.violation_count} violation(s) across ${conformance.records_checked} records:`);
    for (const violation of conformance.violations ?? []) {
      lines.push(`- **${violation.rule}** (${violation.record_id}): ${violation.detail}`);
    }
    lines.push("");
  }

  if (anomalies) {
    lines.push("## Anomalies", "");
    if ((anomalies.anomaly_count ?? 0) === 0) {
      lines.push("No anomalies detected.");
    } else {
      for (const anomaly of anomalies.anomalies ?? []) {
        lines.push(`- **${anomaly.type}** (${anomaly.severity}): ${anomaly.detail}`);
      }
    }
    lines.push("");
  }

  lines.push("## Findings", "");
  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function generateUsageReport(args) {
  const { metrics, conformance, anomalies, format, title } = args;
  const reportFormat = format ?? "markdown";
  if (!FORMATS.includes(reportFormat)) {
    return { valid: false, error: `Invalid format '${reportFormat}'. Allowed formats: ${FORMATS.join(", ")}` };
  }
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return { valid: false, error: "metrics must be an object produced by compute_usage_metrics" };
  }

  const reportTitle = title ?? "Provider & Cloud Usage Evaluation Report";
  const generatedAt = new Date().toISOString();
  const findings = buildFindings({ metrics, conformance, anomalies });

  if (reportFormat === "json") {
    return {
      valid: true,
      format: "json",
      report: {
        title: reportTitle,
        generated_at: generatedAt,
        totals: metrics.totals ?? null,
        groups: metrics.groups ?? [],
        conformance: conformance ?? null,
        anomalies: anomalies ?? null,
        findings
      }
    };
  }

  return {
    valid: true,
    format: "markdown",
    report: renderMarkdown({ title: reportTitle, generatedAt, metrics, conformance, anomalies, findings })
  };
}

function summarizeFindings(args) {
  const { metrics, conformance, anomalies } = args;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return { valid: false, error: "metrics must be an object produced by compute_usage_metrics" };
  }

  const findings = buildFindings({ metrics, conformance, anomalies });
  const highCount = findings.filter((f) => f.severity === "high").length;
  const mediumCount = findings.filter((f) => f.severity === "medium").length;

  const headline = highCount > 0
    ? `${highCount} high-severity issue(s) require attention.`
    : mediumCount > 0
      ? `${mediumCount} medium-severity issue(s) worth reviewing; nothing critical.`
      : "Usage looks healthy: no governance, budget, or anomaly issues detected.";

  return {
    valid: true,
    headline,
    finding_count: findings.length,
    severity_counts: {
      high: highCount,
      medium: mediumCount,
      info: findings.filter((f) => f.severity === "info").length
    },
    findings
  };
}

// ── MCP Server ────────────────────────────────────────────

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "generate_usage_report":
      return generateUsageReport(args);
    case "summarize_findings":
      return summarizeFindings(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-usage-reporting", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "generate_usage_report",
        description: "Generate a usage evaluation report in Markdown or JSON from compute_usage_metrics output, optionally including conformance and anomaly results.",
        inputSchema: {
          type: "object",
          properties: {
            metrics: { type: "object", description: "Output of compute_usage_metrics" },
            conformance: { type: "object", description: "Optional output of check_governance_conformance (may include budget_results)" },
            anomalies: { type: "object", description: "Optional output of detect_anomalies" },
            format: { type: "string", enum: ["markdown", "json"], description: "Report format (default: markdown)" },
            title: { type: "string", description: "Optional report title" }
          },
          required: ["metrics"]
        }
      },
      {
        name: "summarize_findings",
        description: "Produce a plain-language summary with severity counts from metrics, conformance, and anomaly results.",
        inputSchema: {
          type: "object",
          properties: {
            metrics: { type: "object", description: "Output of compute_usage_metrics" },
            conformance: { type: "object", description: "Optional output of check_governance_conformance" },
            anomalies: { type: "object", description: "Optional output of detect_anomalies" }
          },
          required: ["metrics"]
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

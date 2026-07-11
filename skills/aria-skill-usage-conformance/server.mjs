#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// aria-skill-usage-conformance — MCP Server
// Checks NormalizedUsageRecord data against governance policies:
// allowed providers/models/regions, tenant attribution, and
// budget limits by provider, tenant, or model family.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

const POLICY_RULES = [
  {
    rule: "allowed_providers",
    description: "Record provider must be in the allowed_providers list when the list is provided."
  },
  {
    rule: "allowed_models",
    description: "Record model_name must match an entry in allowed_models (exact match or prefix ending with '*') when the list is provided."
  },
  {
    rule: "blocked_models",
    description: "Record model_name must not match any entry in blocked_models (exact match or prefix ending with '*')."
  },
  {
    rule: "allowed_regions",
    description: "Record region must be in the allowed_regions list when the list is provided."
  },
  {
    rule: "require_tenant_attribution",
    description: "Records must have attribution_confidence 'high' when require_tenant_attribution is true."
  },
  {
    rule: "max_cost_confidence",
    description: "Records with cost_confidence 'unknown' are flagged when forbid_unknown_cost is true."
  }
];

const BUDGET_SCOPES = ["provider", "tenant_id", "model_family", "cloud_service"];
const DEFAULT_WARNING_RATIO = 0.8;

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function matchesPattern(value, pattern) {
  if (typeof pattern !== "string") return false;
  if (pattern.endsWith("*")) return String(value).startsWith(pattern.slice(0, -1));
  return String(value) === pattern;
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function checkGovernanceConformance(args) {
  const { records, policy } = args;
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: "records must be a non-empty array of NormalizedUsageRecord objects" };
  }
  if (policy !== undefined && (typeof policy !== "object" || policy === null || Array.isArray(policy))) {
    return { valid: false, error: "policy must be an object" };
  }

  const rules = policy ?? {};
  const violations = [];

  for (const record of records) {
    const id = record.record_id ?? "unknown";

    if (Array.isArray(rules.allowed_providers) && rules.allowed_providers.length > 0
      && !rules.allowed_providers.includes(record.provider)) {
      violations.push({
        rule: "allowed_providers",
        record_id: id,
        detail: `Provider '${record.provider}' is not in allowed_providers [${rules.allowed_providers.join(", ")}]`
      });
    }

    if (Array.isArray(rules.allowed_models) && rules.allowed_models.length > 0
      && !matchesAny(record.model_name, rules.allowed_models)) {
      violations.push({
        rule: "allowed_models",
        record_id: id,
        detail: `Model '${record.model_name}' does not match allowed_models [${rules.allowed_models.join(", ")}]`
      });
    }

    if (Array.isArray(rules.blocked_models) && matchesAny(record.model_name, rules.blocked_models)) {
      violations.push({
        rule: "blocked_models",
        record_id: id,
        detail: `Model '${record.model_name}' matches blocked_models [${rules.blocked_models.join(", ")}]`
      });
    }

    if (Array.isArray(rules.allowed_regions) && rules.allowed_regions.length > 0
      && !rules.allowed_regions.includes(record.region)) {
      violations.push({
        rule: "allowed_regions",
        record_id: id,
        detail: `Region '${record.region}' is not in allowed_regions [${rules.allowed_regions.join(", ")}]`
      });
    }

    if (rules.require_tenant_attribution === true && record.attribution_confidence !== "high") {
      violations.push({
        rule: "require_tenant_attribution",
        record_id: id,
        detail: `Record has attribution_confidence '${record.attribution_confidence}' but high-confidence tenant attribution is required`
      });
    }

    if (rules.forbid_unknown_cost === true && record.cost_confidence === "unknown") {
      violations.push({
        rule: "max_cost_confidence",
        record_id: id,
        detail: "Record has cost_confidence 'unknown' but unknown-cost records are forbidden"
      });
    }
  }

  return {
    valid: true,
    compliant: violations.length === 0,
    records_checked: records.length,
    violation_count: violations.length,
    violations
  };
}

function evaluateBudgetPolicy(args) {
  const { records, budgets, warning_ratio } = args;
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: false, error: "records must be a non-empty array of NormalizedUsageRecord objects" };
  }
  if (!Array.isArray(budgets) || budgets.length === 0) {
    return { valid: false, error: "budgets must be a non-empty array of { scope, id, limit_usd } objects" };
  }

  const warnAt = Number(warning_ratio ?? DEFAULT_WARNING_RATIO);
  const results = [];

  for (const budget of budgets) {
    if (!BUDGET_SCOPES.includes(budget.scope)) {
      return {
        valid: false,
        error: `Invalid budget scope '${budget.scope}'. Allowed scopes: ${BUDGET_SCOPES.join(", ")}`
      };
    }
    if (typeof budget.limit_usd !== "number" || budget.limit_usd <= 0) {
      return { valid: false, error: `Budget for ${budget.scope}='${budget.id}' must have a positive numeric limit_usd` };
    }

    const spend = records
      .filter((record) => record[budget.scope] === budget.id)
      .reduce((sum, record) => sum + Number(record.cost_usd ?? 0), 0);

    const utilization = round(spend / budget.limit_usd, 4);
    const status = utilization > 1 ? "over" : utilization >= warnAt ? "warning" : "ok";

    results.push({
      scope: budget.scope,
      id: budget.id,
      limit_usd: budget.limit_usd,
      spend_usd: round(spend),
      utilization,
      status
    });
  }

  return {
    valid: true,
    warning_ratio: warnAt,
    budgets_evaluated: results.length,
    over_budget_count: results.filter((r) => r.status === "over").length,
    results
  };
}

function listPolicyRules() {
  return {
    valid: true,
    rules: POLICY_RULES,
    budget_scopes: BUDGET_SCOPES
  };
}

// ── MCP Server ────────────────────────────────────────────

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "check_governance_conformance":
      return checkGovernanceConformance(args);
    case "evaluate_budget_policy":
      return evaluateBudgetPolicy(args);
    case "list_policy_rules":
      return listPolicyRules();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-usage-conformance", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "check_governance_conformance",
        description: "Check NormalizedUsageRecord data against a governance policy: allowed providers, models (with '*' prefixes), regions, tenant attribution, and cost confidence requirements.",
        inputSchema: {
          type: "object",
          properties: {
            records: { type: "array", description: "NormalizedUsageRecord objects" },
            policy: {
              type: "object",
              description: "Policy: allowed_providers[], allowed_models[], blocked_models[], allowed_regions[], require_tenant_attribution, forbid_unknown_cost"
            }
          },
          required: ["records"]
        }
      },
      {
        name: "evaluate_budget_policy",
        description: "Evaluate spend against budgets scoped to provider, tenant_id, model_family, or cloud_service, reporting utilization and ok/warning/over status.",
        inputSchema: {
          type: "object",
          properties: {
            records: { type: "array", description: "NormalizedUsageRecord objects" },
            budgets: { type: "array", description: "Budgets: [{ scope, id, limit_usd }]" },
            warning_ratio: { type: "number", description: "Utilization ratio that triggers warning status (default 0.8)" }
          },
          required: ["records", "budgets"]
        }
      },
      {
        name: "list_policy_rules",
        description: "List the governance policy rules and budget scopes supported by this skill.",
        inputSchema: { type: "object", properties: {} }
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

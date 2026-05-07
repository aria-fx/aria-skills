#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// aria-skill-validate — MCP Server
// Validates OASF records and governance overlays against the
// ARIA schema. This skill is itself an ARIA-governed asset.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SENSITIVITY_TIERS = [
  "public", "internal", "confidential",
  "highly_confidential", "restricted"
];

const REQUIRED_RECORD_FIELDS = [
  "name", "version", "schema_version",
  "skills", "locators", "authors"
];

const REQUIRED_GOVERNANCE_FIELDS = [
  "sensitivity_tier", "approval_chain", "audit_level"
];

// ── Validation functions ──────────────────────────────────

function validateOasfRecord(record) {
  const errors = [];

  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!record[field]) {
      errors.push(`Missing required field: '${field}'`);
    }
  }

  if (record.skills && record.skills.length === 0) {
    errors.push("Warning: no skills declared — asset capabilities are undocumented");
  }

  if (record.authors && record.authors.length === 0) {
    errors.push("At least one author is required");
  }

  if (record.version && !/^\d+\.\d+\.\d+/.test(record.version)) {
    errors.push(`Version '${record.version}' is not valid semver`);
  }

  return {
    valid: errors.filter(e => !e.startsWith("Warning")).length === 0,
    errors,
    record_name: record.name || "unknown",
    record_version: record.version || "unknown"
  };
}

function validateGovernanceOverlay(governance) {
  const errors = [];
  const g = governance.governance || governance;

  for (const field of REQUIRED_GOVERNANCE_FIELDS) {
    if (!g[field]) {
      errors.push(`Missing required governance field: '${field}'`);
    }
  }

  if (g.sensitivity_tier && !SENSITIVITY_TIERS.includes(g.sensitivity_tier)) {
    errors.push(`Invalid sensitivity_tier: '${g.sensitivity_tier}'. Must be one of: ${SENSITIVITY_TIERS.join(", ")}`);
  }

  if (g.dependency_sensitivity_ceiling && !SENSITIVITY_TIERS.includes(g.dependency_sensitivity_ceiling)) {
    errors.push(`Invalid dependency_sensitivity_ceiling: '${g.dependency_sensitivity_ceiling}'`);
  }

  return {
    valid: errors.length === 0,
    errors,
    sensitivity_tier: g.sensitivity_tier || "unknown"
  };
}

function checkSensitivityCeiling(governance) {
  const g = governance.governance || governance;
  const tier = g.sensitivity_tier;
  const ceiling = g.dependency_sensitivity_ceiling || "restricted";

  const tierIndex = SENSITIVITY_TIERS.indexOf(tier);
  const ceilingIndex = SENSITIVITY_TIERS.indexOf(ceiling);

  if (tierIndex < 0 || ceilingIndex < 0) {
    return { valid: false, error: "Unknown sensitivity tier or ceiling" };
  }

  if (tierIndex > ceilingIndex) {
    return {
      valid: false,
      error: `Asset tier '${tier}' (${tierIndex}) exceeds ceiling '${ceiling}' (${ceilingIndex})`,
      tier,
      ceiling,
      approval_chain: g.approval_chain || []
    };
  }

  return {
    valid: true,
    tier,
    ceiling,
    message: `${tier} (${tierIndex}) ≤ ${ceiling} (${ceilingIndex})`
  };
}

function validateFull(record, governance) {
  const recordResult = validateOasfRecord(record);
  const govResult = validateGovernanceOverlay(governance);
  const ceilingResult = checkSensitivityCeiling(governance);

  const allValid = recordResult.valid && govResult.valid && ceilingResult.valid;
  const allErrors = [
    ...recordResult.errors,
    ...govResult.errors,
    ...(ceilingResult.valid ? [] : [ceilingResult.error])
  ];

  return {
    valid: allValid,
    record: recordResult,
    governance: govResult,
    ceiling: ceilingResult,
    errors: allErrors,
    summary: allValid
      ? `✓ ${record.name} v${record.version} — all checks passed (${governance.governance?.sensitivity_tier || "unknown"})`
      : `✗ ${record.name || "unknown"} — ${allErrors.length} error(s)`
  };
}

// ── MCP Server ────────────────────────────────────────────

const server = new Server(
  { name: "aria-skill-validate", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "validate_oasf_record",
      description: "Validate an OASF record against the schema. Checks required fields, version format, and skill/author presence.",
      inputSchema: {
        type: "object",
        properties: {
          record: { type: "object", description: "The OASF record JSON object" }
        },
        required: ["record"]
      }
    },
    {
      name: "validate_governance_overlay",
      description: "Validate a governance overlay. Checks required fields and sensitivity tier validity.",
      inputSchema: {
        type: "object",
        properties: {
          governance: { type: "object", description: "The governance overlay JSON object" }
        },
        required: ["governance"]
      }
    },
    {
      name: "check_sensitivity_ceiling",
      description: "Check that an asset's sensitivity tier does not exceed its declared dependency ceiling.",
      inputSchema: {
        type: "object",
        properties: {
          governance: { type: "object", description: "The governance overlay JSON object" }
        },
        required: ["governance"]
      }
    },
    {
      name: "validate_full",
      description: "Run all validation checks (record schema, governance overlay, sensitivity ceiling) in one call.",
      inputSchema: {
        type: "object",
        properties: {
          record: { type: "object", description: "The OASF record JSON object" },
          governance: { type: "object", description: "The governance overlay JSON object" }
        },
        required: ["record", "governance"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  let result;
  switch (name) {
    case "validate_oasf_record":
      result = validateOasfRecord(args.record);
      break;
    case "validate_governance_overlay":
      result = validateGovernanceOverlay(args.governance);
      break;
    case "check_sensitivity_ceiling":
      result = checkSensitivityCeiling(args.governance);
      break;
    case "validate_full":
      result = validateFull(args.record, args.governance);
      break;
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

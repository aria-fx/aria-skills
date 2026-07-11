#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// aria-skill-usage-ingest-normalize — MCP Server
// Ingests raw LLM usage exports from provider/cloud sources and
// normalizes them into the shared NormalizedUsageRecord contract.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = "1.0.0";

const PROVIDERS = ["openai", "anthropic", "gemini"];
const CLOUD_SERVICES = [
  "aws", "gcp", "azure",
  "openai_direct", "anthropic_direct", "google_direct"
];
const REQUEST_TYPES = ["chat", "embedding", "completion", "tool", "batch"];
const COST_CONFIDENCE = ["exact", "estimated", "unknown"];

// USD per 1K tokens (input/output) used when the export lacks cost data.
const PRICE_TABLE = {
  gpt: { input: 0.0025, output: 0.01 },
  claude: { input: 0.003, output: 0.015 },
  gemini: { input: 0.00125, output: 0.005 }
};

const ADAPTERS = {
  openai_direct: {
    provider: "openai",
    cloud_service: "openai_direct",
    description: "OpenAI platform usage export (usage API / dashboard CSV)"
  },
  anthropic_direct: {
    provider: "anthropic",
    cloud_service: "anthropic_direct",
    description: "Anthropic Console usage export"
  },
  google_direct: {
    provider: "gemini",
    cloud_service: "google_direct",
    description: "Google AI Studio / Gemini API usage export"
  },
  aws_bedrock: {
    provider: null,
    cloud_service: "aws",
    description: "AWS Bedrock model invocation logs / CUR usage export"
  },
  gcp_vertex: {
    provider: null,
    cloud_service: "gcp",
    description: "GCP Vertex AI usage export (BigQuery billing / prediction logs)"
  },
  azure_openai: {
    provider: "openai",
    cloud_service: "azure",
    description: "Azure OpenAI / AI Foundry usage export (Cost Management + diagnostics)"
  }
};

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return undefined;
}

export function deriveModelFamily(modelName) {
  const name = String(modelName || "").toLowerCase();
  if (name.startsWith("gpt") || name.includes("o4") || name.includes("text-embedding")) return "gpt";
  if (name.includes("claude")) return "claude";
  if (name.includes("gemini")) return "gemini";
  return "unknown";
}

export function deriveProvider(modelName, adapterProvider) {
  if (adapterProvider) return adapterProvider;
  const family = deriveModelFamily(modelName);
  if (family === "gpt") return "openai";
  if (family === "claude") return "anthropic";
  if (family === "gemini") return "gemini";
  return "unknown";
}

export function deriveRequestType(row) {
  const hint = String(
    firstDefined(row, ["request_type", "operation", "endpoint", "api"]) || ""
  ).toLowerCase();
  if (hint.includes("embed")) return "embedding";
  if (hint.includes("batch")) return "batch";
  if (hint.includes("tool")) return "tool";
  if (hint.includes("chat") || hint.includes("message")) return "chat";
  return "completion";
}

function estimateCost(family, tokensInput, tokensOutput) {
  const price = PRICE_TABLE[family];
  if (!price) return null;
  return (
    (tokensInput / 1000) * price.input +
    (tokensOutput / 1000) * price.output
  );
}

export function normalizeRow(row, adapterName, options = {}) {
  const adapter = ADAPTERS[adapterName];
  const modelName = firstDefined(row, ["model", "model_name", "model_id", "modelId"]);

  if (!modelName) {
    return { error: "Row is missing a model identifier" };
  }

  const family = deriveModelFamily(modelName);
  const provider = deriveProvider(modelName, adapter.provider);
  const tokensInput = Number(firstDefined(row, ["tokens_input", "input_tokens", "prompt_tokens", "inputTokenCount"]) ?? 0);
  const tokensOutput = Number(firstDefined(row, ["tokens_output", "output_tokens", "completion_tokens", "outputTokenCount"]) ?? 0);
  const tokensCached = Number(firstDefined(row, ["tokens_cached", "cached_tokens", "cache_read_input_tokens"]) ?? 0);

  let costUsd = firstDefined(row, ["cost_usd", "cost", "unblended_cost", "amount"]);
  let costConfidence = "exact";
  if (costUsd === undefined) {
    const estimated = estimateCost(family, tokensInput, tokensOutput);
    if (estimated === null) {
      costUsd = 0;
      costConfidence = "unknown";
    } else {
      costUsd = estimated;
      costConfidence = "estimated";
    }
  } else {
    costUsd = Number(costUsd);
  }

  return {
    record: {
      record_id: String(firstDefined(row, ["record_id", "id"]) ?? randomUUID()),
      schema_version: SCHEMA_VERSION,
      provider,
      cloud_service: adapter.cloud_service,
      model_family: family,
      model_name: String(modelName),
      region: String(firstDefined(row, ["region", "location"]) ?? "global"),
      request_type: deriveRequestType(row),
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      tokens_cached: tokensCached,
      call_count: Number(firstDefined(row, ["call_count", "requests", "num_requests", "invocations"]) ?? 1),
      latency_ms: {
        p50: Number(firstDefined(row, ["latency_p50", "latency_ms_p50"]) ?? 0),
        p95: Number(firstDefined(row, ["latency_p95", "latency_ms_p95"]) ?? 0)
      },
      error_class: firstDefined(row, ["error_class", "error_type"]) ?? null,
      retry_count: Number(firstDefined(row, ["retry_count", "retries"]) ?? 0),
      cost_usd: Number(costUsd.toFixed ? costUsd.toFixed(6) : costUsd),
      cost_confidence: costConfidence,
      timestamp: String(firstDefined(row, ["timestamp", "date", "usage_date", "start_time"]) ?? new Date().toISOString()),
      tenant_id: String(firstDefined(row, ["tenant_id", "project_id", "account_id", "subscription_id"]) ?? options.tenant_id ?? "unattributed"),
      attribution_confidence: firstDefined(row, ["tenant_id", "project_id", "account_id", "subscription_id"]) !== undefined || options.tenant_id
        ? "high"
        : "low",
      source_adapter: adapterName
    }
  };
}

function ingestUsageExport(args) {
  const { adapter, rows, tenant_id } = args;

  if (!adapter || !ADAPTERS[adapter]) {
    return {
      valid: false,
      error: `Unknown adapter: '${adapter}'. Supported: ${Object.keys(ADAPTERS).join(", ")}`
    };
  }
  if (!Array.isArray(rows)) {
    return { valid: false, error: "'rows' must be an array of raw usage rows" };
  }

  const records = [];
  const skipped = [];
  rows.forEach((row, index) => {
    const result = normalizeRow(row, adapter, { tenant_id });
    if (result.error) {
      skipped.push({ index, reason: result.error });
    } else {
      records.push(result.record);
    }
  });

  return {
    valid: true,
    adapter,
    schema_version: SCHEMA_VERSION,
    ingested: records.length,
    skipped,
    records
  };
}

function listSupportedAdapters() {
  return {
    schema_version: SCHEMA_VERSION,
    adapters: Object.entries(ADAPTERS).map(([name, meta]) => ({
      name,
      provider: meta.provider ?? "multi",
      cloud_service: meta.cloud_service,
      description: meta.description
    })),
    providers: PROVIDERS,
    cloud_services: CLOUD_SERVICES
  };
}

const REQUIRED_RECORD_FIELDS = [
  "record_id", "schema_version", "provider", "cloud_service",
  "model_family", "model_name", "region", "request_type",
  "tokens_input", "tokens_output", "call_count",
  "cost_usd", "cost_confidence", "timestamp", "tenant_id", "source_adapter"
];

function validateNormalizedRecords(args) {
  const { records } = args;
  if (!Array.isArray(records)) {
    return { valid: false, errors: ["'records' must be an array"], checked: 0 };
  }

  const errors = [];
  records.forEach((record, index) => {
    for (const field of REQUIRED_RECORD_FIELDS) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        errors.push(`[${index}] Missing required field: '${field}'`);
      }
    }
    if (record.provider && !PROVIDERS.includes(record.provider) && record.provider !== "unknown") {
      errors.push(`[${index}] Invalid provider: '${record.provider}'`);
    }
    if (record.cloud_service && !CLOUD_SERVICES.includes(record.cloud_service)) {
      errors.push(`[${index}] Invalid cloud_service: '${record.cloud_service}'`);
    }
    if (record.request_type && !REQUEST_TYPES.includes(record.request_type)) {
      errors.push(`[${index}] Invalid request_type: '${record.request_type}'`);
    }
    if (record.cost_confidence && !COST_CONFIDENCE.includes(record.cost_confidence)) {
      errors.push(`[${index}] Invalid cost_confidence: '${record.cost_confidence}'`);
    }
  });

  return { valid: errors.length === 0, errors, checked: records.length };
}

// ── MCP Server ────────────────────────────────────────────

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "ingest_usage_export":
      return ingestUsageExport(args);
    case "list_supported_adapters":
      return listSupportedAdapters();
    case "validate_normalized_records":
      return validateNormalizedRecords(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-usage-ingest-normalize", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "ingest_usage_export",
        description: "Ingest a raw usage export from a provider or cloud source and normalize rows into NormalizedUsageRecord objects.",
        inputSchema: {
          type: "object",
          properties: {
            adapter: { type: "string", description: "Source adapter: openai_direct | anthropic_direct | google_direct | aws_bedrock | gcp_vertex | azure_openai" },
            rows: { type: "array", description: "Raw usage rows from the source export" },
            tenant_id: { type: "string", description: "Fallback tenant attribution when rows lack one" }
          },
          required: ["adapter", "rows"]
        }
      },
      {
        name: "list_supported_adapters",
        description: "List supported ingestion adapters with their provider and cloud service mapping.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "validate_normalized_records",
        description: "Validate an array of NormalizedUsageRecord objects against the shared contract.",
        inputSchema: {
          type: "object",
          properties: {
            records: { type: "array", description: "NormalizedUsageRecord objects to validate" }
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

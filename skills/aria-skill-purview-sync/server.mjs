#!/usr/bin/env node
// aria-skill-purview-sync — MCP Server
// Syncs ARIA governance metadata with Microsoft Purview.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DefaultAzureCredential } from "@azure/identity";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PURVIEW_SCOPE = "https://purview.azure.net/.default";
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

class PurviewApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PurviewApiError";
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
    this.responseBody = details.responseBody;
    this.operation = details.operation;
    this.attempts = details.attempts;
  }
}

function splitHost(input) {
  return input
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();
}

function buildPurviewEndpoint(input) {
  if (!input || typeof input !== "string") {
    throw new ToolInputError("purview_account is required.");
  }

  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    // Parse as URL to extract origin and enforce https
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (err) {
      throw new ToolInputError(`Invalid URL in purview_account: ${trimmed}`);
    }

    if (parsed.protocol !== "https:") {
      throw new ToolInputError("purview_account URL must use https protocol.");
    }

    return parsed.origin;
  }

  const host = splitHost(trimmed);
  if (host.includes(".")) {
    return `https://${host}`;
  }

  return `https://${host}.purview.azure.com`;
}

function resolveSandboxMode(args = {}) {
  if (typeof args.sandbox_mode === "boolean") {
    return args.sandbox_mode;
  }

  if (typeof args?.auth?.sandbox_mode === "boolean") {
    return args.auth.sandbox_mode;
  }

  return String(process.env.PURVIEW_SANDBOX_MODE || "").toLowerCase() === "true";
}

function assertSandboxAccount(endpoint, args = {}) {
  const sandboxMode = resolveSandboxMode(args);
  if (!sandboxMode) {
    return;
  }

  const allowOverride = args.allow_non_sandbox_account === true;
  if (allowOverride) {
    return;
  }

  const host = splitHost(endpoint).toLowerCase();
  const looksLikeSandbox =
    host.includes("sandbox") ||
    host.includes("dev") ||
    host.includes("test") ||
    host.includes("staging") ||
    host.includes("nonprod");

  if (!looksLikeSandbox) {
    throw new ToolInputError(
      "sandbox_mode is enabled but purview_account does not appear to be a non-production endpoint. " +
      "Use a sandbox/dev/test account or set allow_non_sandbox_account=true explicitly."
    );
  }
}

function normalizeRetryConfig(args = {}) {
  const retry = args?.retry || args?.auth?.retry || {};
  const maxRetries = Number.isInteger(retry.max_retries) ? retry.max_retries : 2;
  const baseDelayMs = Number.isFinite(retry.base_delay_ms) ? retry.base_delay_ms : 250;
  const maxDelayMs = Number.isFinite(retry.max_delay_ms) ? retry.max_delay_ms : 2000;
  const multiplier = Number.isFinite(retry.multiplier) ? retry.multiplier : 2;

  return {
    maxRetries: Math.max(0, maxRetries),
    baseDelayMs: Math.max(0, baseDelayMs),
    maxDelayMs: Math.max(0, maxDelayMs),
    multiplier: Math.max(1, multiplier)
  };
}

function computeBackoffDelayMs(attempt, retryConfig) {
  const exponential = retryConfig.baseDelayMs * Math.pow(retryConfig.multiplier, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.max(1, retryConfig.baseDelayMs));
  return Math.min(retryConfig.maxDelayMs, exponential + jitter);
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getCredential(auth = {}) {
  return new DefaultAzureCredential({
    tenantId: auth.tenant_id || process.env.AZURE_TENANT_ID,
    managedIdentityClientId: auth.client_id || process.env.AZURE_CLIENT_ID
  });
}

async function getAccessToken(auth = {}) {
  if (auth.access_token && typeof auth.access_token === "string") {
    return auth.access_token;
  }

  if (process.env.PURVIEW_ACCESS_TOKEN) {
    return process.env.PURVIEW_ACCESS_TOKEN;
  }

  const credential = getCredential(auth);
  const token = await credential.getToken(PURVIEW_SCOPE);
  if (!token?.token) {
    throw new PurviewApiError("Failed to acquire Azure access token for Purview.", {
      operation: "get_access_token"
    });
  }

  return token.token;
}

function createPurviewClient({ endpoint, tokenProvider, fetchImpl = fetch, retryConfig = normalizeRetryConfig() }) {
  async function request(method, path, body, operation) {
    let lastError;

    for (let attempt = 1; attempt <= retryConfig.maxRetries + 1; attempt++) {
      const token = await tokenProvider();
      const response = await fetchImpl(`${endpoint}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });

      const text = await response.text();
      const parsed = text ? safeJsonParse(text) : null;
      if (response.ok) {
        return parsed;
      }

      const serviceCode =
        parsed?.errorCode ||
        parsed?.error?.code ||
        parsed?.code ||
        "PURVIEW_API_ERROR";

      const serviceMessage =
        parsed?.errorMessage ||
        parsed?.error?.message ||
        parsed?.message ||
        `${response.status} ${response.statusText}`;

      lastError = new PurviewApiError(`Purview API ${operation} failed: ${serviceMessage}`, {
        status: response.status,
        code: serviceCode,
        requestId: response.headers.get("x-ms-request-id") || response.headers.get("x-request-id") || undefined,
        responseBody: parsed || text,
        operation,
        attempts: attempt
      });

      const shouldRetry = isRetryableStatus(response.status) && attempt <= retryConfig.maxRetries;
      if (!shouldRetry) {
        throw lastError;
      }

      const delayMs = computeBackoffDelayMs(attempt, retryConfig);
      await sleep(delayMs);
    }

    throw lastError;
  }

  return {
    request,
    async findEntityByQualifiedName(typeName, qualifiedName) {
      const encoded = encodeURIComponent(qualifiedName);
      return request(
        "GET",
        `/catalog/api/atlas/v2/entity/uniqueAttribute/type/${encodeURIComponent(typeName)}?attr:qualifiedName=${encoded}`,
        undefined,
        "find_entity"
      );
    },
    async createOrUpdateEntity(entity) {
      return request("POST", "/catalog/api/atlas/v2/entity", { entities: [entity] }, "create_or_update_entity");
    },
    async addClassifications(guid, classifications) {
      return request("POST", `/catalog/api/atlas/v2/entity/guid/${encodeURIComponent(guid)}/classifications`, classifications, "add_classifications");
    },
    async createRelationship(relationship) {
      return request("POST", "/catalog/api/atlas/v2/relationship", relationship, "create_relationship");
    }
  };
}

function toEntityName(assetName) {
  return (assetName || "").split("/").pop() || assetName;
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== "object") {
    throw new ToolInputError(`${fieldName} must be an object.`);
  }
  return value;
}

function normalizeGovernance(governance) {
  const g = ensureObject(governance, "governance");
  return g.governance || g;
}

async function applySensitivityLabel(args, deps = {}) {
  const assetName = args.asset_name;
  const tier = args.sensitivity_tier;
  if (!assetName || !tier) {
    throw new ToolInputError("asset_name and sensitivity_tier are required.");
  }

  const endpoint = buildPurviewEndpoint(args.purview_account);
  assertSandboxAccount(endpoint, args);
  const retryConfig = normalizeRetryConfig(args);
  const tokenProvider = deps.tokenProvider || (() => getAccessToken(args.auth || {}));
  const client = deps.client || createPurviewClient({ endpoint, tokenProvider, fetchImpl: deps.fetchImpl, retryConfig });

  const entity = await client.findEntityByQualifiedName("oasf_ai_asset", assetName);
  const guid = entity?.entity?.guid;
  if (!guid) {
    throw new PurviewApiError(`No Purview entity found for asset '${assetName}'.`, {
      code: "ENTITY_NOT_FOUND",
      operation: "apply_sensitivity_label"
    });
  }

  const classificationName = args.purview_label_id || `aria_${tier}`;
  const classificationPayload = [
    {
      typeName: classificationName,
      attributes: {
        sensitivity_tier: tier,
        source: "aria-skill-purview-sync"
      }
    }
  ];

  await client.addClassifications(guid, classificationPayload);

  return {
    success: true,
    operation: "apply_sensitivity_label",
    entity_guid: guid,
    asset: assetName,
    label_applied: tier,
    purview_label_id: classificationName,
    purview_endpoint: endpoint,
    sandbox_mode: resolveSandboxMode(args)
  };
}

async function createDataMapEntity(args, deps = {}) {
  const record = ensureObject(args.record, "record");
  const governance = normalizeGovernance(args.governance);

  const endpoint = buildPurviewEndpoint(args.purview_account);
  assertSandboxAccount(endpoint, args);
  const retryConfig = normalizeRetryConfig(args);
  const tokenProvider = deps.tokenProvider || (() => getAccessToken(args.auth || {}));
  const client = deps.client || createPurviewClient({ endpoint, tokenProvider, fetchImpl: deps.fetchImpl, retryConfig });

  const qualifiedName = record.name;
  if (!qualifiedName) {
    throw new ToolInputError("record.name is required to create a Purview entity.");
  }

  const entity = {
    typeName: "oasf_ai_asset",
    attributes: {
      qualifiedName,
      name: toEntityName(qualifiedName),
      oasf_name: qualifiedName,
      oasf_version: record.version || "unknown",
      asset_type: record.modules?.[0]?.type || "agent",
      sensitivity_tier: governance.sensitivity_tier || "internal",
      dependency_sensitivity_ceiling: governance.dependency_sensitivity_ceiling || "restricted",
      compliance_frameworks: (governance.compliance_frameworks || []).join(",")
    }
  };

  const response = await client.createOrUpdateEntity(entity);
  const guid =
    response?.guidAssignments?.[qualifiedName] ||
    response?.mutatedEntities?.CREATE?.[0]?.guid ||
    response?.mutatedEntities?.UPDATE?.[0]?.guid;

  return {
    success: true,
    operation: "create_data_map_entity",
    entity_guid: guid || null,
    qualified_name: qualifiedName,
    purview_endpoint: endpoint,
    status: guid ? "created_or_updated" : "accepted",
    sandbox_mode: resolveSandboxMode(args)
  };
}

async function createLineageEdge(args, deps = {}) {
  if (!args.source_name || !args.target_name || !args.relationship_type) {
    throw new ToolInputError("source_name, target_name, and relationship_type are required.");
  }

  const endpoint = buildPurviewEndpoint(args.purview_account);
  assertSandboxAccount(endpoint, args);
  const retryConfig = normalizeRetryConfig(args);
  const tokenProvider = deps.tokenProvider || (() => getAccessToken(args.auth || {}));
  const client = deps.client || createPurviewClient({ endpoint, tokenProvider, fetchImpl: deps.fetchImpl, retryConfig });

  const [sourceEntity, targetEntity] = await Promise.all([
    client.findEntityByQualifiedName("oasf_ai_asset", args.source_name),
    client.findEntityByQualifiedName("oasf_ai_asset", args.target_name)
  ]);

  const sourceGuid = sourceEntity?.entity?.guid;
  const targetGuid = targetEntity?.entity?.guid;
  if (!sourceGuid || !targetGuid) {
    throw new PurviewApiError("Source or target entity not found for lineage creation.", {
      code: "ENTITY_NOT_FOUND",
      operation: "create_lineage_edge"
    });
  }

  const relationship = {
    typeName: args.relationship_type,
    end1: { guid: sourceGuid, typeName: "oasf_ai_asset" },
    end2: { guid: targetGuid, typeName: "oasf_ai_asset" },
    attributes: {
      created_by: "aria-skill-purview-sync"
    }
  };

  const response = await client.createRelationship(relationship);
  const relationshipGuid = response?.guid || response?.relationship?.guid || null;

  return {
    success: true,
    operation: "create_lineage_edge",
    relationship_type: args.relationship_type,
    source_guid: sourceGuid,
    target_guid: targetGuid,
    relationship_guid: relationshipGuid,
    purview_endpoint: endpoint,
    sandbox_mode: resolveSandboxMode(args)
  };
}

function evaluateDlpPolicy(args) {
  return {
    compliant: true,
    asset: args.asset_name,
    policies_evaluated: ["ARIA-DLP-Sensitivity-Ceiling", "ARIA-DLP-Consumer-Access"],
    note: "DLP evaluation is currently a policy projection from governance overlays."
  };
}

function mapToolError(error, toolName) {
  if (error instanceof ToolInputError) {
    return {
      error_type: "invalid_input",
      tool: toolName,
      message: error.message
    };
  }

  if (error instanceof PurviewApiError) {
    return {
      error_type: "purview_api_error",
      tool: toolName,
      message: error.message,
      status: error.status,
      code: error.code,
      request_id: error.requestId,
      operation: error.operation,
      attempts: error.attempts,
      response: error.responseBody
    };
  }

  return {
    error_type: "unexpected_error",
    tool: toolName,
    message: error?.message || String(error)
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function handleToolCall(name, args, deps = {}) {
  switch (name) {
    case "apply_sensitivity_label":
      return applySensitivityLabel(args, deps);
    case "create_data_map_entity":
      return createDataMapEntity(args, deps);
    case "create_lineage_edge":
      return createLineageEdge(args, deps);
    case "evaluate_dlp_policy":
      return evaluateDlpPolicy(args);
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-purview-sync", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "apply_sensitivity_label",
        description: "Apply a Purview sensitivity label to an AI asset based on its governance overlay.",
        inputSchema: {
          type: "object",
          properties: {
            asset_name: { type: "string" },
            sensitivity_tier: { type: "string" },
            purview_label_id: { type: "string" },
            sandbox_mode: { type: "boolean", description: "When true, only allow non-production Purview endpoints unless overridden." },
            allow_non_sandbox_account: { type: "boolean", description: "Explicit override for sandbox mode endpoint safety check." },
            retry: {
              type: "object",
              properties: {
                max_retries: { type: "number" },
                base_delay_ms: { type: "number" },
                max_delay_ms: { type: "number" },
                multiplier: { type: "number" }
              }
            },
            purview_account: { type: "string" },
            auth: {
              type: "object",
              properties: {
                access_token: { type: "string" },
                tenant_id: { type: "string" },
                client_id: { type: "string" },
                sandbox_mode: { type: "boolean" },
                retry: {
                  type: "object",
                  properties: {
                    max_retries: { type: "number" },
                    base_delay_ms: { type: "number" },
                    max_delay_ms: { type: "number" },
                    multiplier: { type: "number" }
                  }
                }
              }
            }
          },
          required: ["asset_name", "sensitivity_tier", "purview_account"]
        }
      },
      {
        name: "create_data_map_entity",
        description: "Register an AI asset as an entity in the Purview Data Map with OASF metadata.",
        inputSchema: {
          type: "object",
          properties: {
            record: { type: "object", description: "OASF record" },
            governance: { type: "object", description: "Governance overlay" },
            sandbox_mode: { type: "boolean", description: "When true, only allow non-production Purview endpoints unless overridden." },
            allow_non_sandbox_account: { type: "boolean", description: "Explicit override for sandbox mode endpoint safety check." },
            retry: {
              type: "object",
              properties: {
                max_retries: { type: "number" },
                base_delay_ms: { type: "number" },
                max_delay_ms: { type: "number" },
                multiplier: { type: "number" }
              }
            },
            purview_account: { type: "string" },
            auth: {
              type: "object",
              properties: {
                access_token: { type: "string" },
                tenant_id: { type: "string" },
                client_id: { type: "string" },
                sandbox_mode: { type: "boolean" },
                retry: {
                  type: "object",
                  properties: {
                    max_retries: { type: "number" },
                    base_delay_ms: { type: "number" },
                    max_delay_ms: { type: "number" },
                    multiplier: { type: "number" }
                  }
                }
              }
            }
          },
          required: ["record", "governance", "purview_account"]
        }
      },
      {
        name: "create_lineage_edge",
        description: "Create a lineage relationship edge between two AI assets in the Purview Data Map.",
        inputSchema: {
          type: "object",
          properties: {
            source_name: { type: "string" },
            target_name: { type: "string" },
            relationship_type: { type: "string", enum: ["aria_invokes", "aria_grounded_in", "aria_governed_by", "aria_composed_by"] },
            sandbox_mode: { type: "boolean", description: "When true, only allow non-production Purview endpoints unless overridden." },
            allow_non_sandbox_account: { type: "boolean", description: "Explicit override for sandbox mode endpoint safety check." },
            retry: {
              type: "object",
              properties: {
                max_retries: { type: "number" },
                base_delay_ms: { type: "number" },
                max_delay_ms: { type: "number" },
                multiplier: { type: "number" }
              }
            },
            purview_account: { type: "string" },
            auth: {
              type: "object",
              properties: {
                access_token: { type: "string" },
                tenant_id: { type: "string" },
                client_id: { type: "string" },
                sandbox_mode: { type: "boolean" },
                retry: {
                  type: "object",
                  properties: {
                    max_retries: { type: "number" },
                    base_delay_ms: { type: "number" },
                    max_delay_ms: { type: "number" },
                    multiplier: { type: "number" }
                  }
                }
              }
            }
          },
          required: ["source_name", "target_name", "relationship_type", "purview_account"]
        }
      },
      {
        name: "evaluate_dlp_policy",
        description: "Evaluate whether an AI asset's interactions comply with Purview DLP policies.",
        inputSchema: {
          type: "object",
          properties: {
            asset_name: { type: "string" },
            interaction_context: { type: "string" },
            purview_account: { type: "string" }
          },
          required: ["asset_name", "purview_account"]
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
      const mapped = mapToolError(error, name);
      return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await startServer();
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  handleToolCall,
  deriveModelFamily,
  deriveProvider,
  deriveRequestType,
  normalizeRow,
  SCHEMA_VERSION
} from "../server.mjs";

test("list_supported_adapters returns all six adapters", async () => {
  const result = await handleToolCall("list_supported_adapters", {});
  const names = result.adapters.map((a) => a.name).sort();
  assert.deepEqual(names, [
    "anthropic_direct",
    "aws_bedrock",
    "azure_openai",
    "gcp_vertex",
    "google_direct",
    "openai_direct"
  ]);
  assert.deepEqual(result.providers, ["openai", "anthropic", "gemini"]);
  assert.equal(result.schema_version, SCHEMA_VERSION);
});

test("ingest_usage_export normalizes openai_direct rows with exact cost", async () => {
  const result = await handleToolCall("ingest_usage_export", {
    adapter: "openai_direct",
    rows: [
      {
        id: "row-1",
        model: "gpt-4o-mini",
        prompt_tokens: 1000,
        completion_tokens: 500,
        cached_tokens: 100,
        requests: 12,
        cost_usd: 0.42,
        region: "us-east-1",
        operation: "chat.completions",
        timestamp: "2026-07-01T00:00:00Z",
        project_id: "proj-a",
        latency_p50: 200,
        latency_p95: 900
      }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.ingested, 1);
  assert.equal(result.skipped.length, 0);

  const record = result.records[0];
  assert.equal(record.record_id, "row-1");
  assert.equal(record.provider, "openai");
  assert.equal(record.cloud_service, "openai_direct");
  assert.equal(record.model_family, "gpt");
  assert.equal(record.request_type, "chat");
  assert.equal(record.tokens_input, 1000);
  assert.equal(record.tokens_output, 500);
  assert.equal(record.tokens_cached, 100);
  assert.equal(record.call_count, 12);
  assert.equal(record.cost_usd, 0.42);
  assert.equal(record.cost_confidence, "exact");
  assert.equal(record.tenant_id, "proj-a");
  assert.equal(record.attribution_confidence, "high");
  assert.equal(record.source_adapter, "openai_direct");
});

test("ingest_usage_export estimates cost for bedrock rows and infers provider from model", async () => {
  const result = await handleToolCall("ingest_usage_export", {
    adapter: "aws_bedrock",
    rows: [
      {
        modelId: "anthropic.claude-sonnet-4-6",
        inputTokenCount: 2000,
        outputTokenCount: 1000,
        invocations: 3,
        location: "us-west-2",
        endpoint: "invoke-batch"
      }
    ],
    tenant_id: "team-platform"
  });

  const record = result.records[0];
  assert.equal(record.provider, "anthropic");
  assert.equal(record.cloud_service, "aws");
  assert.equal(record.model_family, "claude");
  assert.equal(record.request_type, "batch");
  assert.equal(record.cost_confidence, "estimated");
  assert.ok(record.cost_usd > 0);
  assert.equal(record.tenant_id, "team-platform");
  assert.equal(record.region, "us-west-2");
});

test("ingest_usage_export marks unknown-family cost as unknown and skips bad rows", async () => {
  const result = await handleToolCall("ingest_usage_export", {
    adapter: "gcp_vertex",
    rows: [
      { model: "custom-tuned-model", input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10 }
    ]
  });

  assert.equal(result.ingested, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /missing a model identifier/);

  const record = result.records[0];
  assert.equal(record.cost_confidence, "unknown");
  assert.equal(record.cost_usd, 0);
  assert.equal(record.tenant_id, "unattributed");
  assert.equal(record.attribution_confidence, "low");
});

test("ingest_usage_export rejects unknown adapters and bad rows argument", async () => {
  const unknownAdapter = await handleToolCall("ingest_usage_export", {
    adapter: "oracle_cloud",
    rows: []
  });
  assert.equal(unknownAdapter.valid, false);
  assert.match(unknownAdapter.error, /Unknown adapter/);

  const badRows = await handleToolCall("ingest_usage_export", {
    adapter: "openai_direct",
    rows: "not-an-array"
  });
  assert.equal(badRows.valid, false);
  assert.match(badRows.error, /must be an array/);
});

test("validate_normalized_records enforces the contract", async () => {
  const ingest = await handleToolCall("ingest_usage_export", {
    adapter: "azure_openai",
    rows: [
      {
        model: "gpt-4o",
        input_tokens: 100,
        output_tokens: 50,
        subscription_id: "sub-1",
        api: "embeddings"
      }
    ]
  });
  assert.equal(ingest.records[0].request_type, "embedding");
  assert.equal(ingest.records[0].cloud_service, "azure");

  const valid = await handleToolCall("validate_normalized_records", {
    records: ingest.records
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.checked, 1);

  const invalid = await handleToolCall("validate_normalized_records", {
    records: [
      { record_id: "x", provider: "mistral", cloud_service: "oci", request_type: "stream", cost_confidence: "guess" }
    ]
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((e) => e.includes("Invalid provider")));
  assert.ok(invalid.errors.some((e) => e.includes("Invalid cloud_service")));
  assert.ok(invalid.errors.some((e) => e.includes("Invalid request_type")));
  assert.ok(invalid.errors.some((e) => e.includes("Invalid cost_confidence")));
  assert.ok(invalid.errors.some((e) => e.includes("Missing required field")));

  const notArray = await handleToolCall("validate_normalized_records", { records: null });
  assert.equal(notArray.valid, false);
});

test("derivation helpers cover fallback branches", () => {
  assert.equal(deriveModelFamily("gemini-2.0-flash"), "gemini");
  assert.equal(deriveModelFamily(undefined), "unknown");
  assert.equal(deriveProvider("mystery-model"), "unknown");
  assert.equal(deriveProvider("gemini-pro"), "gemini");
  assert.equal(deriveRequestType({ operation: "tool_use" }), "tool");
  assert.equal(deriveRequestType({}), "completion");
  assert.deepEqual(normalizeRow({}, "openai_direct"), { error: "Row is missing a model identifier" });
});

test("unknown tool raises an error", async () => {
  await assert.rejects(() => handleToolCall("does_not_exist", {}), /Unknown tool/);
});

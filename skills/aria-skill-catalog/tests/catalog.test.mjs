import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall, resetCatalog } from "../server.mjs";

test("catalog indexes assets and returns latest manifest/version history", async () => {
  resetCatalog();

  await handleToolCall("index_asset", {
    record: {
      name: "aria.dev/skills/catalog",
      version: "1.0.0",
      description: "Initial catalog",
      skills: [{ name: "knowledge_retrieval/semantic_search" }],
      domains: [{ name: "governance" }]
    },
    governance: { governance: { sensitivity_tier: "internal" } },
    oci_reference: "ghcr.io/aria/catalog:1.0.0"
  });

  await handleToolCall("index_asset", {
    record: {
      name: "aria.dev/skills/catalog",
      version: "1.1.0",
      description: "Catalog with policy search",
      skills: [{ name: "knowledge_retrieval/semantic_search" }],
      domains: [{ name: "governance" }]
    },
    governance: { governance: { sensitivity_tier: "internal" } },
    oci_reference: "ghcr.io/aria/catalog:1.1.0"
  });

  const search = await handleToolCall("search_assets", {
    keyword: "policy",
    skill: "semantic_search",
    domain: "governance"
  });
  assert.equal(search.count, 1);
  assert.equal(search.assets[0].version, "1.1.0");

  const manifest = await handleToolCall("get_asset_manifest", {
    name: "aria.dev/skills/catalog"
  });
  assert.equal(manifest.record.version, "1.1.0");
  assert.equal(manifest.oci, "ghcr.io/aria/catalog:1.1.0");

  const versions = await handleToolCall("list_versions", {
    name: "aria.dev/skills/catalog"
  });
  assert.deepEqual(versions.versions.sort(), ["1.0.0", "1.1.0"]);
});

test("catalog governance filtering removes unauthorized and over-ceiling assets", async () => {
  resetCatalog();

  const result = await handleToolCall("filter_by_governance", {
    consumer_id: "team-a",
    sensitivity_ceiling: "internal",
    results: [
      {
        record: { name: "aria.dev/skills/catalog" },
        governance: {
          governance: {
            sensitivity_tier: "internal",
            allowed_consumers: ["team-a"]
          }
        }
      },
      {
        record: { name: "aria.dev/skills/purview-sync" },
        governance: {
          governance: {
            sensitivity_tier: "confidential",
            allowed_consumers: ["team-a"]
          }
        }
      },
      {
        record: { name: "aria.dev/skills/publish" },
        governance: {
          governance: {
            sensitivity_tier: "internal",
            allowed_consumers: ["team-b"]
          }
        }
      }
    ]
  });

  assert.equal(result.filtered_count, 1);
  assert.equal(result.removed, 2);
  assert.equal(result.assets[0].record.name, "aria.dev/skills/catalog");
});

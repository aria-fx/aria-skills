import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

function createFetchMock(sequence) {
  let index = 0;
  const fetchMock = async (url, options) => {
    const current = sequence[index++];
    assert.ok(current, `Unexpected fetch call for URL: ${url}`);
    if (current.assert) {
      current.assert(url, options);
    }

    return {
      ok: current.ok ?? true,
      status: current.status ?? 200,
      statusText: current.statusText ?? "OK",
      headers: {
        get(name) {
          return current.headers?.[name.toLowerCase()] || current.headers?.[name] || null;
        }
      },
      async text() {
        if (current.body === undefined || current.body === null) {
          return "";
        }
        return typeof current.body === "string" ? current.body : JSON.stringify(current.body);
      }
    };
  };

  fetchMock.assertDone = () => {
    assert.equal(index, sequence.length, `Expected ${sequence.length} fetch call(s), got ${index}`);
  };

  return fetchMock;
}

test("create_data_map_entity performs real Atlas entity write and returns guid", async () => {
  const fetchMock = createFetchMock([
    {
      assert: (url, options) => {
        assert.equal(url, "https://acct.purview.azure.com/catalog/api/atlas/v2/entity");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body.entities[0].typeName, "oasf_ai_asset");
        assert.equal(body.entities[0].attributes.qualifiedName, "aria.dev/skills/purview-sync");
      },
      body: {
        guidAssignments: {
          "aria.dev/skills/purview-sync": "guid-entity-001"
        }
      }
    }
  ]);

  const result = await handleToolCall(
    "create_data_map_entity",
    {
      purview_account: "acct",
      auth: { access_token: "token" },
      record: {
        name: "aria.dev/skills/purview-sync",
        version: "1.0.0",
        modules: [{ type: "mcp_server" }]
      },
      governance: {
        governance: {
          sensitivity_tier: "confidential",
          dependency_sensitivity_ceiling: "restricted",
          compliance_frameworks: ["SOC2"]
        }
      }
    },
    { fetchImpl: fetchMock }
  );

  assert.equal(result.success, true);
  assert.equal(result.entity_guid, "guid-entity-001");
  assert.equal(result.status, "created_or_updated");
  fetchMock.assertDone();
});

test("apply_sensitivity_label resolves entity and applies classification", async () => {
  const fetchMock = createFetchMock([
    {
      assert: (url, options) => {
        assert.equal(options.method, "GET");
        assert.match(url, /entity\/uniqueAttribute\/type\/oasf_ai_asset/);
      },
      body: {
        entity: {
          guid: "guid-entity-002"
        }
      }
    },
    {
      assert: (url, options) => {
        assert.equal(url, "https://acct.purview.azure.com/catalog/api/atlas/v2/entity/guid/guid-entity-002/classifications");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body[0].typeName, "aria_confidential");
        assert.equal(body[0].attributes.sensitivity_tier, "confidential");
      },
      body: {}
    }
  ]);

  const result = await handleToolCall(
    "apply_sensitivity_label",
    {
      purview_account: "acct",
      auth: { access_token: "token" },
      asset_name: "aria.dev/skills/purview-sync",
      sensitivity_tier: "confidential"
    },
    { fetchImpl: fetchMock }
  );

  assert.equal(result.success, true);
  assert.equal(result.entity_guid, "guid-entity-002");
  assert.equal(result.purview_label_id, "aria_confidential");
  fetchMock.assertDone();
});

test("create_lineage_edge resolves source+target and creates relationship", async () => {
  const fetchMock = createFetchMock([
    {
      body: { entity: { guid: "guid-source" } }
    },
    {
      body: { entity: { guid: "guid-target" } }
    },
    {
      assert: (url, options) => {
        assert.equal(url, "https://acct.purview.azure.com/catalog/api/atlas/v2/relationship");
        assert.equal(options.method, "POST");
        const body = JSON.parse(options.body);
        assert.equal(body.typeName, "aria_invokes");
        assert.equal(body.end1.guid, "guid-source");
        assert.equal(body.end2.guid, "guid-target");
      },
      body: { guid: "rel-001" }
    }
  ]);

  const result = await handleToolCall(
    "create_lineage_edge",
    {
      purview_account: "acct",
      auth: { access_token: "token" },
      source_name: "aria.dev/skills/source",
      target_name: "aria.dev/skills/target",
      relationship_type: "aria_invokes"
    },
    { fetchImpl: fetchMock }
  );

  assert.equal(result.success, true);
  assert.equal(result.relationship_guid, "rel-001");
  assert.equal(result.source_guid, "guid-source");
  assert.equal(result.target_guid, "guid-target");
  fetchMock.assertDone();
});

test("create_lineage_edge maps API failure with status and code", async () => {
  const fetchMock = createFetchMock([
    { body: { entity: { guid: "guid-source" } } },
    {
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: { errorCode: "ENTITY_NOT_FOUND", errorMessage: "Target not found" },
      headers: { "x-ms-request-id": "req-404" }
    }
  ]);

  await assert.rejects(
    () =>
      handleToolCall(
        "create_lineage_edge",
        {
          purview_account: "acct",
          auth: { access_token: "token" },
          source_name: "aria.dev/skills/source",
          target_name: "aria.dev/skills/missing",
          relationship_type: "aria_invokes"
        },
        { fetchImpl: fetchMock }
      ),
    /Purview API find_entity failed: Target not found/
  );
  fetchMock.assertDone();
});

test("create_data_map_entity retries retryable Purview errors and succeeds", async () => {
  const fetchMock = createFetchMock([
    {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      body: { errorCode: "SERVICE_BUSY", errorMessage: "Please retry" }
    },
    {
      body: {
        guidAssignments: {
          "aria.dev/skills/purview-sync": "guid-entity-retry"
        }
      }
    }
  ]);

  const result = await handleToolCall(
    "create_data_map_entity",
    {
      purview_account: "acct",
      auth: { access_token: "token" },
      retry: {
        max_retries: 2,
        base_delay_ms: 0,
        max_delay_ms: 0,
        multiplier: 1
      },
      record: {
        name: "aria.dev/skills/purview-sync",
        version: "1.0.0",
        modules: [{ type: "mcp_server" }]
      },
      governance: {
        governance: {
          sensitivity_tier: "confidential",
          dependency_sensitivity_ceiling: "restricted",
          compliance_frameworks: ["SOC2"]
        }
      }
    },
    { fetchImpl: fetchMock }
  );

  assert.equal(result.success, true);
  assert.equal(result.entity_guid, "guid-entity-retry");
  fetchMock.assertDone();
});

test("sandbox_mode rejects non-sandbox accounts unless explicit override is set", async () => {
  await assert.rejects(
    () =>
      handleToolCall(
        "create_data_map_entity",
        {
          purview_account: "prodacct",
          sandbox_mode: true,
          auth: { access_token: "token" },
          record: {
            name: "aria.dev/skills/purview-sync",
            version: "1.0.0",
            modules: [{ type: "mcp_server" }]
          },
          governance: {
            governance: {
              sensitivity_tier: "confidential",
              dependency_sensitivity_ceiling: "restricted"
            }
          }
        },
        { fetchImpl: createFetchMock([]) }
      ),
    /sandbox_mode is enabled/
  );
});

test("buildPurviewEndpoint strips path/query from full URL and enforces https", async () => {
  const fetchMock = createFetchMock([
    {
      assert: (url, options) => {
        // Verify the endpoint is the origin only, not including /foo/bar
        assert.equal(url, "https://acct.purview.azure.com/catalog/api/atlas/v2/entity");
        assert.equal(options.method, "POST");
      },
      body: {
        guidAssignments: {
          "aria.dev/skills/test": "guid-test-001"
        }
      }
    }
  ]);

  const result = await handleToolCall(
    "create_data_map_entity",
    {
      purview_account: "https://acct.purview.azure.com/foo/bar?query=param",
      auth: { access_token: "token" },
      record: {
        name: "aria.dev/skills/test",
        version: "1.0.0",
        modules: [{ type: "mcp_server" }]
      },
      governance: {
        governance: {
          sensitivity_tier: "public"
        }
      }
    },
    { fetchImpl: fetchMock }
  );

  assert.equal(result.success, true);
  fetchMock.assertDone();
});

test("buildPurviewEndpoint rejects http URLs", async () => {
  await assert.rejects(
    () =>
      handleToolCall(
        "create_data_map_entity",
        {
          purview_account: "http://acct.purview.azure.com",
          auth: { access_token: "token" },
          record: {
            name: "aria.dev/skills/test",
            version: "1.0.0",
            modules: [{ type: "mcp_server" }]
          },
          governance: {
            governance: {
              sensitivity_tier: "public"
            }
          }
        },
        { fetchImpl: createFetchMock([]) }
      ),
    /must use https protocol/
  );
});


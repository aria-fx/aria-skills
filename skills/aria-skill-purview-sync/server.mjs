#!/usr/bin/env node
// aria-skill-purview-sync — MCP Server
// Syncs ARIA governance metadata with Microsoft Purview.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
          purview_account: { type: "string" }
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
          purview_account: { type: "string" }
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
          purview_account: { type: "string" }
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
  let result;

  switch (name) {
    case "apply_sensitivity_label":
      result = {
        success: true,
        asset: args.asset_name,
        label_applied: args.sensitivity_tier,
        purview_label_id: args.purview_label_id || "auto-mapped",
        purview_endpoint: `https://${args.purview_account}.purview.azure.com`,
        api_call: {
          method: "POST",
          uri: `https://${args.purview_account}.purview.azure.com/catalog/api/atlas/v2/entity`,
          note: "Would apply sensitivity label via Atlas API in production"
        }
      };
      break;

    case "create_data_map_entity": {
      const r = args.record;
      const g = args.governance.governance || args.governance;
      result = {
        success: true,
        entity: {
          typeName: "oasf_ai_asset",
          qualifiedName: r.name,
          name: r.name.split("/").pop(),
          sensitivity_tier: g.sensitivity_tier,
          oasf_version: r.version,
          asset_type: r.modules?.[0]?.type || "agent",
          compliance_frameworks: (g.compliance_frameworks || []).join(",")
        },
        purview_endpoint: `https://${args.purview_account}.purview.azure.com`
      };
      break;
    }

    case "create_lineage_edge":
      result = {
        success: true,
        relationship: {
          typeName: args.relationship_type,
          source: args.source_name,
          target: args.target_name
        },
        purview_endpoint: `https://${args.purview_account}.purview.azure.com`,
        note: "Would create Atlas relationship via REST API in production"
      };
      break;

    case "evaluate_dlp_policy":
      result = {
        compliant: true,
        asset: args.asset_name,
        policies_evaluated: ["ARIA-DLP-Sensitivity-Ceiling", "ARIA-DLP-Consumer-Access"],
        note: "Would call Purview DLP evaluation endpoint in production"
      };
      break;

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

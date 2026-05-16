#!/usr/bin/env node
// aria-skill-catalog — MCP Server
// Indexes published ARIA assets and serves the discovery API.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

// In-memory catalog (production would use the OCI registry + Agent Directory)
const catalog = new Map();

const TIERS = ["public", "internal", "confidential", "highly_confidential", "restricted"];

export function resetCatalog() {
  catalog.clear();
}

export async function handleToolCall(name, args = {}) {
  let result;

  switch (name) {
    case "index_asset": {
      const key = `${args.record.name}@${args.record.version}`;
      catalog.set(key, { record: args.record, governance: args.governance, oci: args.oci_reference });
      result = { indexed: true, key, total_assets: catalog.size };
      break;
    }

    case "search_assets": {
      let results = [...catalog.values()].map(e => e.record);

      if (args.skill) {
        results = results.filter(r =>
          r.skills?.some(s => s.name.toLowerCase().includes(args.skill.toLowerCase())));
      }
      if (args.domain) {
        results = results.filter(r =>
          r.domains?.some(d => d.name.toLowerCase().includes(args.domain.toLowerCase())));
      }
      if (args.keyword) {
        const kw = args.keyword.toLowerCase();
        results = results.filter(r =>
          r.name.toLowerCase().includes(kw) || (r.description || "").toLowerCase().includes(kw));
      }

      result = { count: results.length, assets: results.map(r => ({
        name: r.name, version: r.version, description: r.description,
        skills: r.skills?.map(s => s.name), domains: r.domains?.map(d => d.name)
      }))};
      break;
    }

    case "get_asset_manifest": {
      const entries = [...catalog.entries()]
        .filter(([k]) => k.startsWith(args.name))
        .sort(([a], [b]) => b.localeCompare(a));

      const match = args.version
        ? entries.find(([k]) => k === `${args.name}@${args.version}`)
        : entries[0];

      result = match ? match[1] : { error: `Asset '${args.name}' not found in catalog` };
      break;
    }

    case "list_versions": {
      const versions = [...catalog.keys()]
        .filter(k => k.startsWith(args.name))
        .map(k => k.split("@")[1]);
      result = { name: args.name, versions };
      break;
    }

    case "filter_by_governance": {
      const ceilingIdx = TIERS.indexOf(args.sensitivity_ceiling);
      const filtered = (args.results || []).filter(r => {
        const tier = r.governance?.governance?.sensitivity_tier || "public";
        const tierIdx = TIERS.indexOf(tier);
        if (tierIdx > ceilingIdx) return false;
        const allowed = r.governance?.governance?.allowed_consumers || [];
        if (allowed.length > 0 && !allowed.includes(args.consumer_id)) return false;
        return true;
      });

      result = {
        consumer: args.consumer_id,
        ceiling: args.sensitivity_ceiling,
        input_count: (args.results || []).length,
        filtered_count: filtered.length,
        removed: (args.results || []).length - filtered.length,
        assets: filtered
      };
      break;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return result;
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-catalog", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "index_asset",
        description: "Add or update an ARIA asset in the catalog index.",
        inputSchema: {
          type: "object",
          properties: {
            record: { type: "object" },
            governance: { type: "object" },
            oci_reference: { type: "string" }
          },
          required: ["record"]
        }
      },
      {
        name: "search_assets",
        description: "Search the catalog by OASF skill taxonomy, domain, keyword, or sensitivity tier.",
        inputSchema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "OASF skill name filter" },
            domain: { type: "string", description: "OASF domain filter" },
            keyword: { type: "string", description: "Free-text keyword" },
            max_sensitivity: { type: "string", description: "Filter assets at or below this tier" }
          }
        }
      },
      {
        name: "get_asset_manifest",
        description: "Retrieve the full OASF record and governance overlay for a specific asset.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" }
          },
          required: ["name"]
        }
      },
      {
        name: "list_versions",
        description: "List all published versions of an asset.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"]
        }
      },
      {
        name: "filter_by_governance",
        description: "Filter catalog results by consumer identity and sensitivity ceiling. Returns only assets the consumer is authorized to install.",
        inputSchema: {
          type: "object",
          properties: {
            consumer_id: { type: "string" },
            sensitivity_ceiling: { type: "string" },
            results: { type: "array", items: { type: "object" } }
          },
          required: ["consumer_id", "sensitivity_ceiling", "results"]
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

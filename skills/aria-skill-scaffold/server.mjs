#!/usr/bin/env node
// aria-skill-scaffold — MCP Server
// Generates new ARIA assets from templates with OASF records pre-filled.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SKILL_TAXONOMY = {
  "nlp": { "nlu": { "intent_classification": 10101, "entity_extraction": 10102 },
            "nlg": { "text_completion": 10201, "summarization": 10202 } },
  "knowledge_retrieval": { "rag": 30101, "semantic_search": 30102, "document_qa": 30103 },
  "code": { "generation": 20101, "review": 20102, "refactoring": 20103 },
  "data": { "analysis": 50101, "visualization": 50102, "transformation": 50103 },
  "governance": { "validation": { "schema": 40101, "policy": 40102 },
                  "purview": { "labels": 40301, "lineage": 40302 },
                  "compliance": { "dependency_audit": 40401, "ceiling_check": 40402 } }
};

const server = new Server(
  { name: "aria-skill-scaffold", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "scaffold_from_template",
      description: "Generate a complete ARIA asset directory structure from the template, including oasf-record.json, oasf-governance.json, src/, tests/, docs/, Dockerfile, and .github/ workflows.",
      inputSchema: {
        type: "object",
        properties: {
          asset_name: { type: "string", description: "Full OASF name (e.g., myorg.com/skills/policy-lookup)" },
          asset_type: { type: "string", enum: ["agent", "skill", "instruction", "knowledge", "orchestration"] },
          description: { type: "string" },
          author: { type: "string" }
        },
        required: ["asset_name", "asset_type"]
      }
    },
    {
      name: "generate_oasf_record",
      description: "Generate an OASF record with pre-filled fields based on asset type and description.",
      inputSchema: {
        type: "object",
        properties: {
          asset_name: { type: "string" },
          asset_type: { type: "string" },
          description: { type: "string" },
          skills: { type: "array", items: { type: "string" }, description: "Skill taxonomy paths (e.g., 'knowledge_retrieval/rag')" },
          domains: { type: "array", items: { type: "string" } },
          author: { type: "string" }
        },
        required: ["asset_name", "asset_type"]
      }
    },
    {
      name: "suggest_skill_taxonomy",
      description: "Suggest OASF skill taxonomy entries based on a natural-language description of the asset's capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Natural language description of what the asset does" }
        },
        required: ["description"]
      }
    },
    {
      name: "propose_governance_overlay",
      description: "Propose a governance overlay with sensible defaults based on asset type, data classifications, and domain.",
      inputSchema: {
        type: "object",
        properties: {
          asset_type: { type: "string" },
          handles_pii: { type: "boolean", default: false },
          handles_phi: { type: "boolean", default: false },
          domain: { type: "string" },
          compliance_frameworks: { type: "array", items: { type: "string" } }
        },
        required: ["asset_type"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  let result;

  switch (name) {
    case "scaffold_from_template": {
      const moduleType = args.asset_type === "skill" ? "mcp_server"
        : args.asset_type === "instruction" ? "prompt_bundle"
        : args.asset_type === "knowledge" ? "knowledge_base"
        : args.asset_type === "orchestration" ? "orchestration_config"
        : "agent";

      result = {
        directory_structure: {
          "oasf-record.json": "OASF Record (generated — customize skills and modules)",
          "oasf-governance.json": "Governance overlay (generated — set sensitivity and consumers)",
          "src/": args.asset_type === "skill" ? "MCP server implementation" : "Asset implementation",
          "src/server.mjs": args.asset_type === "skill" ? "MCP server entry point" : undefined,
          "tests/": "Validation and evaluation tests",
          "docs/README.md": "Usage documentation",
          "Dockerfile": "OCI packaging",
          ".github/CODEOWNERS": "Governance-aware ownership routing",
          ".github/workflows/oasf-validate.yml": "PR validation workflow",
          ".github/workflows/publish.yml": "OCI publish workflow",
          ".github/workflows/purview-sync.yml": "Purview sync workflow"
        },
        module_type: moduleType,
        next_steps: [
          "1. Customize oasf-record.json with your specific skills and modules",
          "2. Set sensitivity_tier and allowed_consumers in oasf-governance.json",
          "3. Implement your asset in src/",
          "4. Run 'apm audit' to validate governance before pushing",
          "5. Submit a PR — the oasf-validate workflow will check everything"
        ]
      };
      break;
    }

    case "generate_oasf_record": {
      const moduleType = args.asset_type === "skill" ? "mcp_server"
        : args.asset_type === "instruction" ? "prompt_bundle"
        : args.asset_type === "knowledge" ? "knowledge_base"
        : args.asset_type === "orchestration" ? "orchestration_config"
        : null;

      const record = {
        name: args.asset_name,
        version: "0.1.0",
        schema_version: "1.0.0",
        description: args.description || `TODO: Describe this ${args.asset_type}`,
        skills: (args.skills || []).map(s => {
          const parts = s.split("/");
          let id = 99999;
          let node = SKILL_TAXONOMY;
          for (const p of parts) { if (node[p]) { node = node[p]; if (typeof node === "number") { id = node; break; } } }
          return { id, name: s };
        }),
        domains: (args.domains || []).map(d => ({ name: d })),
        modules: moduleType ? [{ type: moduleType, transport: moduleType === "mcp_server" ? "stdio" : undefined }] : [],
        locators: [{ type: "source_code", urls: [`https://github.com/TODO/${args.asset_name.replace(/\//g, "-")}`] }],
        authors: [args.author || "TODO: Your Name <you@example.com>"],
        created_at: new Date().toISOString()
      };

      result = { record, note: "Customize skills, modules, and locators before publishing" };
      break;
    }

    case "suggest_skill_taxonomy": {
      const desc = (args.description || "").toLowerCase();
      const suggestions = [];

      if (desc.includes("rag") || desc.includes("retrieval") || desc.includes("knowledge") || desc.includes("search"))
        suggestions.push({ id: 30101, name: "knowledge_retrieval/rag", reason: "Document retrieval / RAG pattern" });
      if (desc.includes("intent") || desc.includes("classify") || desc.includes("nlu"))
        suggestions.push({ id: 10101, name: "nlp/nlu/intent_classification", reason: "Intent understanding" });
      if (desc.includes("generat") || desc.includes("complet") || desc.includes("write") || desc.includes("draft"))
        suggestions.push({ id: 10201, name: "nlp/nlg/text_completion", reason: "Text generation" });
      if (desc.includes("summar"))
        suggestions.push({ id: 10202, name: "nlp/nlg/summarization", reason: "Summarization" });
      if (desc.includes("code") || desc.includes("program"))
        suggestions.push({ id: 20101, name: "code/generation", reason: "Code generation" });
      if (desc.includes("data") || desc.includes("analy"))
        suggestions.push({ id: 50101, name: "data/analysis", reason: "Data analysis" });
      if (desc.includes("valid") || desc.includes("schema") || desc.includes("governance"))
        suggestions.push({ id: 40101, name: "governance/validation/schema", reason: "Schema validation" });

      if (suggestions.length === 0)
        suggestions.push({ id: 99999, name: "TODO/unclassified", reason: "Could not auto-classify — please select from the OASF taxonomy" });

      result = { description: args.description, suggestions };
      break;
    }

    case "propose_governance_overlay": {
      const classifications = [];
      if (args.handles_pii) classifications.push("PII");
      if (args.handles_phi) classifications.push("PHI");

      const tier = classifications.length > 0 ? "confidential"
        : args.asset_type === "knowledge" ? "confidential"
        : "internal";

      const ceiling = classifications.includes("PHI") ? "highly_confidential" : "confidential";

      const approvalChain = tier === "confidential"
        ? ["ai-platform-engineering", "ai-governance"]
        : ["ai-platform-engineering"];

      result = {
        governance: {
          sensitivity_tier: tier,
          data_classifications: classifications,
          purview_label_id: "",
          approval_chain: approvalChain,
          allowed_consumers: [],
          max_data_retention_days: classifications.length > 0 ? 90 : 365,
          audit_level: classifications.length > 0 ? "full" : "standard",
          dependency_sensitivity_ceiling: ceiling,
          compliance_frameworks: args.compliance_frameworks || ["SOC2"]
        },
        reasoning: {
          tier_reason: classifications.length > 0
            ? `Set to 'confidential' because asset handles ${classifications.join(", ")}`
            : `Set to '${tier}' — no sensitive data classifications declared`,
          ceiling_reason: `Set to '${ceiling}' — allows dependencies up to this level`,
          audit_reason: classifications.length > 0
            ? "Full audit due to sensitive data handling"
            : "Standard audit — no sensitive data"
        }
      };
      break;
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);

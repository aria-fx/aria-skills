import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

test("scaffold_from_template returns skill-oriented structure", async () => {
  const result = await handleToolCall("scaffold_from_template", {
    asset_name: "aria.dev/skills/example",
    asset_type: "skill"
  });

  assert.equal(result.module_type, "mcp_server");
  assert.equal(result.directory_structure["tests/"], "Validation and evaluation tests");
  assert.equal(result.directory_structure["src/server.mjs"], "MCP server entry point");
  assert.match(result.next_steps[4], /Submit a PR/);
});

test("generate_oasf_record maps taxonomy IDs and preserves metadata", async () => {
  const result = await handleToolCall("generate_oasf_record", {
    asset_name: "aria.dev/skills/policy-lookup",
    asset_type: "skill",
    description: "Governance policy lookup",
    skills: ["governance/validation/schema", "knowledge_retrieval/rag"],
    domains: ["governance"],
    author: "ARIA Dev <aria@example.com>"
  });

  assert.equal(result.record.modules[0].type, "mcp_server");
  assert.deepEqual(
    result.record.skills.map((skill) => skill.id),
    [40101, 30101]
  );
  assert.deepEqual(result.record.domains, [{ name: "governance" }]);
  assert.deepEqual(result.record.authors, ["ARIA Dev <aria@example.com>"]);
});

test("taxonomy suggestion and governance overlay reflect asset characteristics", async () => {
  const suggestions = await handleToolCall("suggest_skill_taxonomy", {
    description: "Retrieval-augmented governance validation with summarization"
  });

  assert.ok(suggestions.suggestions.some((item) => item.name === "knowledge_retrieval/rag"));
  assert.ok(suggestions.suggestions.some((item) => item.name === "governance/validation/schema"));

  const governance = await handleToolCall("propose_governance_overlay", {
    asset_type: "skill",
    handles_pii: true,
    compliance_frameworks: ["SOC2", "ISO27001"]
  });

  assert.equal(governance.governance.sensitivity_tier, "confidential");
  assert.equal(governance.governance.dependency_sensitivity_ceiling, "confidential");
  assert.equal(governance.governance.audit_level, "full");
  assert.deepEqual(governance.governance.compliance_frameworks, ["SOC2", "ISO27001"]);
});

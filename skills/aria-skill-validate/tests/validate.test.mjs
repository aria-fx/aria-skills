import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

test("validate_oasf_record reports schema and semver issues", async () => {
  const result = await handleToolCall("validate_oasf_record", {
    record: {
      name: "aria.dev/skills/example",
      version: "1.0",
      schema_version: "1.0.0",
      skills: [],
      locators: [],
      authors: []
    }
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("not valid semver")));
  assert.ok(result.errors.some((error) => error.includes("At least one author is required")));
  assert.ok(result.errors.some((error) => error.startsWith("Warning: no skills declared")));
});

test("governance validation and ceiling checks reject invalid configurations", async () => {
  const governanceResult = await handleToolCall("validate_governance_overlay", {
    governance: {
      governance: {
        sensitivity_tier: "top_secret",
        dependency_sensitivity_ceiling: "internal"
      }
    }
  });
  assert.equal(governanceResult.valid, false);
  assert.ok(governanceResult.errors.some((error) => error.includes("Missing required governance field")));
  assert.ok(governanceResult.errors.some((error) => error.includes("Invalid sensitivity_tier")));

  const ceilingResult = await handleToolCall("check_sensitivity_ceiling", {
    governance: {
      governance: {
        sensitivity_tier: "restricted",
        dependency_sensitivity_ceiling: "internal",
        approval_chain: ["ai-governance"]
      }
    }
  });
  assert.equal(ceilingResult.valid, false);
  assert.match(ceilingResult.error, /exceeds ceiling/);
});

test("validate_full summarizes successful validation", async () => {
  const result = await handleToolCall("validate_full", {
    record: {
      name: "aria.dev/skills/validate",
      version: "1.0.0",
      schema_version: "1.0.0",
      skills: [{ id: 40101, name: "governance/validation/schema" }],
      locators: [{ type: "source_code", urls: ["https://example.com"] }],
      authors: ["ARIA Dev <aria@example.com>"]
    },
    governance: {
      governance: {
        sensitivity_tier: "internal",
        dependency_sensitivity_ceiling: "internal",
        approval_chain: ["ai-platform-engineering"],
        audit_level: "standard"
      }
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.match(result.summary, /all checks passed/);
});

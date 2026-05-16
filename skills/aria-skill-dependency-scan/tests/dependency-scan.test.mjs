import test from "node:test";
import assert from "node:assert/strict";

import { handleToolCall } from "../server.mjs";

const rootRecord = {
  name: "aria.dev/agents/root-agent",
  version: "1.0.0",
  modules: [
    { type: "mcp_server", ref: "dep/validate" },
    { type: "mcp_server", ref: "dep/purview" }
  ]
};

const rootGovernance = {
  governance: {
    sensitivity_tier: "internal",
    dependency_sensitivity_ceiling: "internal",
    compliance_frameworks: ["SOC2"]
  }
};

const manifestMap = {
  "dep/validate": {
    record: {
      name: "aria.dev/skills/validate",
      version: "1.0.0",
      modules: [
        { type: "mcp_server", ref: "dep/catalog" }
      ]
    },
    governance: {
      governance: {
        sensitivity_tier: "internal",
        dependency_sensitivity_ceiling: "internal"
      }
    },
    lifecycle_status: "active"
  },
  "dep/purview": {
    record: {
      name: "aria.dev/skills/purview-sync",
      version: "1.0.0",
      modules: []
    },
    governance: {
      governance: {
        sensitivity_tier: "confidential",
        dependency_sensitivity_ceiling: "restricted"
      }
    },
    lifecycle_status: "deprecated"
  },
  "dep/catalog": {
    record: {
      name: "aria.dev/skills/catalog",
      version: "1.0.0",
      modules: []
    },
    governance: {
      governance: {
        sensitivity_tier: "restricted",
        dependency_sensitivity_ceiling: "restricted"
      }
    },
    lifecycle_status: "archived"
  }
};

test("scan_transitive_deps resolves transitive refs with provenance and violations", async () => {
  const result = await handleToolCall("scan_transitive_deps", {
    record: rootRecord,
    governance: rootGovernance,
    manifest_map: manifestMap
  });

  assert.equal(result.asset, "aria.dev/agents/root-agent");
  assert.equal(result.total_dependencies, 3);
  assert.equal(result.max_dependency_tier, "restricted");
  assert.equal(result.compliant, false);

  assert.equal(result.violations.length, 2);
  const violationRefs = result.violations.map((v) => v.to_ref).sort();
  assert.deepEqual(violationRefs, ["aria.dev/skills/catalog", "aria.dev/skills/purview-sync"]);

  const dep = result.dependencies.find((d) => d.ref === "aria.dev/skills/purview-sync");
  assert.ok(dep);
  assert.equal(dep.lifecycle_status, "deprecated");
  assert.equal(dep.provenance.resolver, "manifest_map");

  const edge = result.dependency_edges.find((e) => e.to_ref === "aria.dev/skills/catalog");
  assert.ok(edge);
  assert.equal(edge.depth, 2);
  assert.deepEqual(edge.path, ["aria.dev/agents/root-agent", "dep/validate", "dep/catalog"]);
});

test("detect_deprecated_deps identifies deprecated and archived dependencies", async () => {
  const scanResults = await handleToolCall("scan_transitive_deps", {
    record: rootRecord,
    governance: rootGovernance,
    manifest_map: manifestMap
  });

  const lifecycle = await handleToolCall("detect_deprecated_deps", {
    dependencies: scanResults.dependencies
  });

  assert.equal(lifecycle.total_checked, 3);
  assert.equal(lifecycle.all_active, false);
  assert.equal(lifecycle.deprecated.length, 1);
  assert.equal(lifecycle.archived.length, 1);
  assert.equal(lifecycle.deprecated[0].ref, "aria.dev/skills/purview-sync");
  assert.equal(lifecycle.archived[0].ref, "aria.dev/skills/catalog");
});

test("generate_compliance_report is deterministic for same input", async () => {
  const scanResults = await handleToolCall("scan_transitive_deps", {
    record: rootRecord,
    governance: rootGovernance,
    manifest_map: manifestMap
  });

  const args = {
    record: rootRecord,
    governance: rootGovernance,
    scan_results: scanResults,
    report_timestamp: "2026-05-16T00:00:00Z"
  };

  const reportA = await handleToolCall("generate_compliance_report", args);
  const reportB = await handleToolCall("generate_compliance_report", args);

  assert.deepEqual(reportA, reportB);
  assert.equal(reportA.report.overall, "NON_COMPLIANT");
  assert.equal(reportA.report.dependency_health.violation_count, 2);
  assert.ok(reportA.report.recommendations.length > 0);
});

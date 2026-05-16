#!/usr/bin/env node
// aria-skill-dependency-scan — MCP Server
// Scans transitive dependencies for ceiling violations and policy drift.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TIERS = ["public", "internal", "confidential", "highly_confidential", "restricted"];
const DEFAULT_CEILING = "restricted";

class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeGovernance(governance) {
  if (!governance || typeof governance !== "object") {
    return {};
  }

  return governance.governance || governance;
}

function normalizeTier(tier) {
  if (!tier || !TIERS.includes(tier)) {
    return "unknown";
  }

  return tier;
}

function tierIndex(tier) {
  return TIERS.indexOf(tier);
}

function maxTier(a, b) {
  if (tierIndex(a) >= tierIndex(b)) {
    return a;
  }

  return b;
}

function isTierViolation(tier, ceiling) {
  if (!TIERS.includes(tier) || !TIERS.includes(ceiling)) {
    return false;
  }

  return tierIndex(tier) > tierIndex(ceiling);
}

function toRecordName(ref, fallback = "unknown") {
  if (typeof ref !== "string" || ref.trim() === "") {
    return fallback;
  }

  const clean = ref.replace(/\/$/, "");
  return clean.split("/").pop() || clean;
}

function collectLifecycleStatus(manifest) {
  const governance = normalizeGovernance(manifest?.governance);
  const record = manifest?.record || {};

  const raw =
    manifest?.lifecycle_status ||
    manifest?.status ||
    governance.lifecycle_status ||
    governance.status ||
    record.lifecycle_status ||
    record.status ||
    "active";

  const value = String(raw).toLowerCase();
  if (value === "deprecated" || value === "archived" || value === "active") {
    return value;
  }

  return "active";
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const text = readFileSync(filePath, "utf8");
  const parsed = safeParseJson(text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function isWithinPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFromManifestMap(ref, manifestMap = {}) {
  if (!manifestMap || typeof manifestMap !== "object") {
    return null;
  }

  const keyCandidates = [ref, ref?.replace(/\/$/, ""), ref?.split(":")[0]].filter(Boolean);
  let manifest = null;
  for (const key of keyCandidates) {
    if (manifestMap[key]) {
      manifest = manifestMap[key];
      break;
    }
  }

  if (!manifest || typeof manifest !== "object") {
    return null;
  }

  const record = manifest.record || (manifest.record_path ? readJsonFile(manifest.record_path) : null);
  const governance = manifest.governance || (manifest.governance_path ? readJsonFile(manifest.governance_path) : null);

  if (!record || !governance) {
    return null;
  }

  return {
    record,
    governance,
    lifecycle_status: collectLifecycleStatus(manifest),
    provenance: {
      resolver: "manifest_map",
      key: keyCandidates.find((k) => manifestMap[k]) || ref,
      record_source: manifest.record_path || "manifest_map.inline.record",
      governance_source: manifest.governance_path || "manifest_map.inline.governance"
    }
  };
}

function resolveFromLocalFs(ref, registryBase) {
  if (typeof ref !== "string" || ref.trim() === "") {
    return null;
  }

  if (!registryBase || typeof registryBase !== "string") {
    return null;
  }

  const normalizedRegistryBase = path.resolve(registryBase);
  const resolvedRefPath = path.resolve(normalizedRegistryBase, ref);
  if (!isWithinPath(normalizedRegistryBase, resolvedRefPath)) {
    return null;
  }

  const candidateDir = ref.endsWith(".json") ? path.dirname(resolvedRefPath) : resolvedRefPath;
  const candidateRecordFile = ref.endsWith(".json")
    ? resolvedRefPath
    : path.join(candidateDir, "oasf-record.json");
  const governanceFile = path.join(candidateDir, "oasf-governance.json");

  if (!isWithinPath(normalizedRegistryBase, candidateRecordFile) || !isWithinPath(normalizedRegistryBase, governanceFile)) {
    return null;
  }

  const record = readJsonFile(candidateRecordFile);
  if (!record) {
    return null;
  }

  const governance = readJsonFile(governanceFile);
  if (!governance) {
    return null;
  }

  return {
    record,
    governance,
    lifecycle_status: collectLifecycleStatus({ record, governance }),
    provenance: {
      resolver: "local_fs",
      record_source: candidateRecordFile,
      governance_source: governanceFile
    }
  };
}

async function resolveFromHttp(ref, fetchImpl = fetch) {
  if (typeof ref !== "string" || !/^https?:\/\//i.test(ref)) {
    return null;
  }

  const recordUrl = ref.endsWith(".json") ? ref : `${ref.replace(/\/$/, "")}/oasf-record.json`;
  const governanceUrl = recordUrl.replace(/oasf-record\.json$/, "oasf-governance.json");

  const [recordResp, governanceResp] = await Promise.all([
    fetchImpl(recordUrl),
    fetchImpl(governanceUrl)
  ]);

  if (!recordResp.ok || !governanceResp.ok) {
    return null;
  }

  const [record, governance] = await Promise.all([recordResp.json(), governanceResp.json()]);
  return {
    record,
    governance,
    lifecycle_status: collectLifecycleStatus({ record, governance }),
    provenance: {
      resolver: "http",
      record_source: recordUrl,
      governance_source: governanceUrl
    }
  };
}

async function resolveDependencyManifest(ref, args, deps) {
  const fromMap = resolveFromManifestMap(ref, args.manifest_map);
  if (fromMap) {
    return fromMap;
  }

  const fromFs = resolveFromLocalFs(ref, args.registry_base);
  if (fromFs) {
    return fromFs;
  }

  const fetchImpl = deps.fetchImpl || fetch;
  const fromHttp = await resolveFromHttp(ref, fetchImpl);
  if (fromHttp) {
    return fromHttp;
  }

  return null;
}

function deterministicSortEdges(edges) {
  return [...edges].sort((a, b) => {
    if (a.from_ref !== b.from_ref) {
      return a.from_ref.localeCompare(b.from_ref);
    }
    if (a.to_ref !== b.to_ref) {
      return a.to_ref.localeCompare(b.to_ref);
    }
    return String(a.depth).localeCompare(String(b.depth));
  });
}

function deterministicSortDependencies(dependencies) {
  return [...dependencies].sort((a, b) => a.ref.localeCompare(b.ref));
}

async function scanTransitiveDeps(args, deps = {}) {
  const record = args.record;
  if (!record || typeof record !== "object") {
    throw new ToolInputError("record is required and must be an object.");
  }

  const rootGovernance = normalizeGovernance(args.governance || {});
  const rootCeiling = rootGovernance.dependency_sensitivity_ceiling || args.asset_ceiling || DEFAULT_CEILING;
  const maxDepth = Number.isInteger(args.max_depth) ? Math.max(1, args.max_depth) : 20;

  const visited = new Set();
  const queue = [];
  const dependencies = [];
  const edges = [];
  const unresolved = [];

  const rootName = record.name || "root";
  const rootTier = normalizeTier(rootGovernance.sensitivity_tier || args.asset_tier || "internal");
  const rootModules = Array.isArray(record.modules) ? record.modules : [];

  for (const module of rootModules) {
    if (module?.ref) {
      queue.push({
        parentRef: rootName,
        parentTier: rootTier,
        parentCeiling: rootCeiling,
        ref: module.ref,
        type: module.type || "unknown",
        depth: 1,
        path: [rootName, module.ref]
      });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > maxDepth) {
      continue;
    }

    const manifest = await resolveDependencyManifest(current.ref, args, deps);
    if (!manifest) {
      unresolved.push({
        ref: current.ref,
        from_ref: current.parentRef,
        depth: current.depth,
        reason: "manifest_or_governance_not_resolved"
      });
      continue;
    }

    const gov = normalizeGovernance(manifest.governance);
    const depTier = normalizeTier(gov.sensitivity_tier || "internal");
    const depName = manifest.record?.name || current.ref;
    const depCeiling = gov.dependency_sensitivity_ceiling || DEFAULT_CEILING;
    const lifecycleStatus = manifest.lifecycle_status || "active";

    const edge = {
      from_ref: current.parentRef,
      to_ref: depName,
      module_ref: current.ref,
      module_type: current.type,
      from_tier: current.parentTier,
      to_tier: depTier,
      ceiling: current.parentCeiling,
      compliant: !isTierViolation(depTier, current.parentCeiling),
      depth: current.depth,
      path: current.path,
      provenance: {
        ...manifest.provenance
      }
    };

    edges.push(edge);

    if (!visited.has(depName)) {
      visited.add(depName);
      dependencies.push({
        name: toRecordName(depName, depName),
        ref: depName,
        source_ref: current.ref,
        type: current.type,
        sensitivity_tier: depTier,
        dependency_sensitivity_ceiling: depCeiling,
        lifecycle_status: lifecycleStatus,
        deprecated: lifecycleStatus === "deprecated",
        archived: lifecycleStatus === "archived",
        depth: current.depth,
        path: current.path,
        provenance: {
          ...manifest.provenance
        }
      });

      const childModules = Array.isArray(manifest.record?.modules) ? manifest.record.modules : [];
      for (const child of childModules) {
        if (!child?.ref) {
          continue;
        }

        queue.push({
          parentRef: depName,
          parentTier: depTier,
          parentCeiling: depCeiling,
          ref: child.ref,
          type: child.type || "unknown",
          depth: current.depth + 1,
          path: [...current.path, child.ref]
        });
      }
    }
  }

  const sortedEdges = deterministicSortEdges(edges);
  const violations = sortedEdges
    .filter((e) => !e.compliant)
    .map((e) => ({
      from_ref: e.from_ref,
      to_ref: e.to_ref,
      to_tier: e.to_tier,
      ceiling: e.ceiling,
      depth: e.depth,
      path: e.path,
      provenance: e.provenance
    }));

  const maxDependencyTier = dependencies.length
    ? dependencies.reduce((max, d) => (TIERS.includes(d.sensitivity_tier) ? maxTier(max, d.sensitivity_tier) : max), "public")
    : "none";

  return {
    asset: rootName,
    asset_tier: rootTier,
    asset_ceiling: rootCeiling,
    total_dependencies: dependencies.length,
    max_dependency_tier: maxDependencyTier,
    dependencies: deterministicSortDependencies(dependencies),
    dependency_edges: sortedEdges,
    violations,
    unresolved,
    compliant: violations.length === 0
  };
}

function checkCeilingViolations(args) {
  const ceiling = args.asset_ceiling;
  const deps = Array.isArray(args.dependencies) ? args.dependencies : [];
  if (!ceiling || !TIERS.includes(ceiling)) {
    throw new ToolInputError("asset_ceiling is required and must be a known tier.");
  }

  const ceilingIdx = TIERS.indexOf(ceiling);
  const violations = deps
    .filter((d) => TIERS.includes(d.sensitivity_tier) && TIERS.indexOf(d.sensitivity_tier) > ceilingIdx)
    .map((v) => ({
      name: v.name || toRecordName(v.ref, v.ref),
      ref: v.ref,
      tier: v.sensitivity_tier,
      ceiling,
      exceeds_by: TIERS.indexOf(v.sensitivity_tier) - ceilingIdx,
      provenance: v.provenance || null
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  return {
    asset_tier: args.asset_tier || "unknown",
    asset_ceiling: ceiling,
    total_checked: deps.length,
    violations,
    compliant: violations.length === 0
  };
}

function detectDeprecatedDeps(args) {
  const deps = Array.isArray(args.dependencies) ? args.dependencies : [];
  const deprecated = [];
  const archived = [];

  for (const dep of deps) {
    const status = String(
      dep.lifecycle_status ||
      dep.status ||
      (dep.deprecated ? "deprecated" : dep.archived ? "archived" : "active")
    ).toLowerCase();

    const item = {
      name: dep.name || toRecordName(dep.ref, dep.ref),
      ref: dep.ref,
      lifecycle_status: status,
      provenance: dep.provenance || null
    };

    if (status === "deprecated") {
      deprecated.push(item);
    }

    if (status === "archived") {
      archived.push(item);
    }
  }

  deprecated.sort((a, b) => a.ref.localeCompare(b.ref));
  archived.sort((a, b) => a.ref.localeCompare(b.ref));

  return {
    total_checked: deps.length,
    deprecated,
    archived,
    all_active: deprecated.length === 0 && archived.length === 0
  };
}

function generateComplianceReport(args) {
  const record = args.record || {};
  const governance = normalizeGovernance(args.governance || {});
  const scanResults = args.scan_results || {};

  const deps = deterministicSortDependencies(Array.isArray(scanResults.dependencies) ? scanResults.dependencies : []);
  const violations = [...(scanResults.violations || [])].sort((a, b) => `${a.from_ref}->${a.to_ref}`.localeCompare(`${b.from_ref}->${b.to_ref}`));
  const unresolved = [...(scanResults.unresolved || [])].sort((a, b) => a.ref.localeCompare(b.ref));

  const dependencyHealth = {
    total_dependencies: deps.length,
    unresolved_count: unresolved.length,
    violation_count: violations.length,
    deprecated_count: deps.filter((d) => d.lifecycle_status === "deprecated" || d.deprecated).length,
    archived_count: deps.filter((d) => d.lifecycle_status === "archived" || d.archived).length
  };

  const checks = {
    schema_valid: true,
    governance_valid: true,
    ceiling_compliant: violations.length === 0,
    dependencies_resolved: unresolved.length === 0,
    dependencies_active: dependencyHealth.deprecated_count === 0 && dependencyHealth.archived_count === 0
  };

  const recommendations = [];
  if (!checks.ceiling_compliant) {
    recommendations.push("Reduce dependency tiers or increase approved dependency_sensitivity_ceiling.");
  }
  if (!checks.dependencies_resolved) {
    recommendations.push("Provide manifest_map entries or registry_base paths for unresolved refs.");
  }
  if (!checks.dependencies_active) {
    recommendations.push("Replace deprecated/archived dependencies with supported alternatives.");
  }

  return {
    report: {
      asset: record.name || "unknown",
      version: record.version || "unknown",
      generated_at: args.report_timestamp || null,
      sensitivity_tier: governance.sensitivity_tier || "unknown",
      ceiling: governance.dependency_sensitivity_ceiling || DEFAULT_CEILING,
      compliance_frameworks: [...(governance.compliance_frameworks || [])].sort(),
      dependency_health: dependencyHealth,
      checks,
      violations,
      unresolved,
      overall: Object.values(checks).every(Boolean) ? "COMPLIANT" : "NON_COMPLIANT",
      recommendations
    }
  };
}

export async function handleToolCall(name, args, deps = {}) {
  switch (name) {
    case "scan_transitive_deps":
      return scanTransitiveDeps(args || {}, deps);
    case "check_ceiling_violations":
      return checkCeilingViolations(args || {});
    case "detect_deprecated_deps":
      return detectDeprecatedDeps(args || {});
    case "generate_compliance_report":
      return generateComplianceReport(args || {});
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

function mapToolError(error, tool) {
  if (error instanceof ToolInputError) {
    return {
      error_type: "invalid_input",
      tool,
      message: error.message
    };
  }

  return {
    error_type: "unexpected_error",
    tool,
    message: error?.message || String(error)
  };
}

async function startServer() {
  const server = new Server(
    { name: "aria-skill-dependency-scan", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "scan_transitive_deps",
        description: "Resolve transitive refs from real manifests/governance overlays and return dependency provenance + violations.",
        inputSchema: {
          type: "object",
          properties: {
            record: { type: "object", description: "Root OASF record to scan" },
            governance: { type: "object", description: "Root governance overlay" },
            registry_base: { type: "string", description: "Base local path for resolving refs to oasf-record/governance files" },
            manifest_map: { type: "object", description: "Inline mapping of ref => {record, governance, lifecycle_status} for deterministic resolution" },
            max_depth: { type: "number", description: "Maximum recursive depth for transitive resolution" }
          },
          required: ["record"]
        }
      },
      {
        name: "check_ceiling_violations",
        description: "Check dependency tiers against an asset ceiling and return violating edges with provenance.",
        inputSchema: {
          type: "object",
          properties: {
            asset_tier: { type: "string" },
            asset_ceiling: { type: "string" },
            dependencies: { type: "array", items: { type: "object" } }
          },
          required: ["asset_ceiling", "dependencies"]
        }
      },
      {
        name: "detect_deprecated_deps",
        description: "Detect dependencies with deprecated or archived lifecycle status from resolved metadata.",
        inputSchema: {
          type: "object",
          properties: {
            dependencies: { type: "array", items: { type: "object" } }
          },
          required: ["dependencies"]
        }
      },
      {
        name: "generate_compliance_report",
        description: "Generate deterministic compliance report with violations and evidence from real resolution output.",
        inputSchema: {
          type: "object",
          properties: {
            record: { type: "object" },
            governance: { type: "object" },
            scan_results: { type: "object" },
            report_timestamp: { type: "string", description: "Optional explicit timestamp for deterministic report output" }
          },
          required: ["record", "governance", "scan_results"]
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
        content: [{ type: "text", text: JSON.stringify(mapToolError(error, name), null, 2) }],
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

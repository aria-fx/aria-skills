import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface OasfRecord {
  name: string;
  version: string;
  schema_version: string;
  description: string;
  skills: Array<{ id: number; name: string }>;
  modules: Array<{ type: string; ref?: string; version?: string }>;
}

interface OasfGovernanceFile {
  governance: OasfGovernance;
}

interface OasfGovernance {
  sensitivity_tier: string;
  approval_chain: string[];
  allowed_consumers: string[];
  compliance_frameworks: string[];
}

describe("Agent Integration Tests", () => {
  const agentsDir = path.resolve(__dirname, "../agents");
  const agents = ["aria-super", "gateway-contract-drift-reviewer", "skill-lifecycle-reviewer"];

  describe("Agent Manifests", () => {
    it.each(agents)("%s agent has valid OASF record", async (agentName) => {
      const recordPath = path.join(agentsDir, agentName, "oasf-record.json");
      const content = await fs.readFile(recordPath, "utf-8");
      const record: OasfRecord = JSON.parse(content);

      expect(record.name).toMatch(/^aria\.dev\/agents\//);
      expect(record.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(record.schema_version).toBe("1.0.0");
      expect(record.description).toBeTruthy();
      expect(Array.isArray(record.skills)).toBe(true);
      expect(record.skills.length).toBeGreaterThan(0);
      expect(Array.isArray(record.modules)).toBe(true);
      expect(record.modules.length).toBeGreaterThan(0);

      // Verify modules reference skills
      const mcp_modules = record.modules.filter((m) => m.type === "mcp_server");
      expect(mcp_modules.length).toBeGreaterThan(0);
      mcp_modules.forEach((mod) => {
        expect(mod.ref).toMatch(/^aria\.dev\/skills\//);
        expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });

    it.each(agents)("%s agent has valid OASF governance overlay", async (agentName) => {
      const governancePath = path.join(agentsDir, agentName, "oasf-governance.json");
      const content = await fs.readFile(governancePath, "utf-8");
      const { governance } = JSON.parse(content) as OasfGovernanceFile;

      expect(["public", "internal", "confidential", "highly_confidential"]).toContain(
        governance.sensitivity_tier
      );
      expect(Array.isArray(governance.approval_chain)).toBe(true);
      expect(Array.isArray(governance.allowed_consumers)).toBe(true);
      expect(Array.isArray(governance.compliance_frameworks)).toBe(true);

      // All new agents should be internal or higher sensitivity
      expect(["internal", "confidential", "highly_confidential"]).toContain(
        governance.sensitivity_tier
      );
    });

    it.each(agents)("%s agent has valid MCP config", async (agentName) => {
      const mcpPath = path.join(agentsDir, agentName, "mcp-config.json");
      const content = await fs.readFile(mcpPath, "utf-8");
      const config: Record<string, unknown> = JSON.parse(content);

      expect(config.mcpServers).toBeDefined();
      const servers = config.mcpServers as Record<string, unknown>;
      expect(Object.keys(servers).length).toBeGreaterThan(0);

      Object.entries(servers).forEach(([key, server]) => {
        const srv = server as Record<string, unknown>;
        expect(srv.command).toBeTruthy();
        expect(Array.isArray(srv.args)).toBe(true);
        if (srv.metadata) {
          const meta = srv.metadata as Record<string, unknown>;
          expect(meta.oasf_ref).toMatch(/^aria\.dev\/skills\//);
        }
      });
    });
  });

  describe("Agent Dependencies", () => {
    it("aria-super references validate, catalog, scaffold, publish skills", async () => {
      const recordPath = path.join(agentsDir, "aria-super", "oasf-record.json");
      const content = await fs.readFile(recordPath, "utf-8");
      const record: OasfRecord = JSON.parse(content);

      const refs = record.modules
        .filter((m) => m.type === "mcp_server")
        .map((m) => m.ref)
        .sort();

      expect(refs).toContain("aria.dev/skills/validate");
      expect(refs).toContain("aria.dev/skills/catalog");
      expect(refs).toContain("aria.dev/skills/scaffold");
      expect(refs).toContain("aria.dev/skills/publish");
    });

    it("gateway-contract-drift-reviewer references validate, catalog, scaffold", async () => {
      const recordPath = path.join(agentsDir, "gateway-contract-drift-reviewer", "oasf-record.json");
      const content = await fs.readFile(recordPath, "utf-8");
      const record: OasfRecord = JSON.parse(content);

      const refs = record.modules
        .filter((m) => m.type === "mcp_server")
        .map((m) => m.ref)
        .sort();

      expect(refs).toContain("aria.dev/skills/validate");
      expect(refs).toContain("aria.dev/skills/catalog");
      expect(refs).toContain("aria.dev/skills/scaffold");
    });

    it("skill-lifecycle-reviewer references all 6 skills", async () => {
      const recordPath = path.join(agentsDir, "skill-lifecycle-reviewer", "oasf-record.json");
      const content = await fs.readFile(recordPath, "utf-8");
      const record: OasfRecord = JSON.parse(content);

      const refs = record.modules
        .filter((m) => m.type === "mcp_server")
        .map((m) => m.ref)
        .sort();

      const expectedSkills = [
        "aria.dev/skills/catalog",
        "aria.dev/skills/dependency-scan",
        "aria.dev/skills/publish",
        "aria.dev/skills/purview-sync",
        "aria.dev/skills/scaffold",
        "aria.dev/skills/validate",
      ].sort();

      expect(refs).toEqual(expectedSkills);
    });
  });

  describe("Agent Governance", () => {
    it.each(agents)("%s agent is properly classified", async (agentName) => {
      const recordPath = path.join(agentsDir, agentName, "oasf-record.json");
      const recordContent = await fs.readFile(recordPath, "utf-8");
      const record: OasfRecord = JSON.parse(recordContent);

      const governancePath = path.join(agentsDir, agentName, "oasf-governance.json");
      const govContent = await fs.readFile(governancePath, "utf-8");
      const { governance } = JSON.parse(govContent) as OasfGovernanceFile;

      // Verify name and governance alignment
      expect(record.name).toMatch(/^aria\.dev\/agents\//);
      expect(governance.sensitivity_tier).toBeTruthy();

      // All agents should have at least one compliance framework
      expect(governance.compliance_frameworks.length).toBeGreaterThan(0);
      expect(governance.compliance_frameworks).toContain("SOC2");
    });

    it("aria-super is internal and allows all-employees", async () => {
      const governancePath = path.join(agentsDir, "aria-super", "oasf-governance.json");
      const content = await fs.readFile(governancePath, "utf-8");
      const { governance } = JSON.parse(content) as OasfGovernanceFile;

      expect(governance.sensitivity_tier).toBe("internal");
      expect(governance.allowed_consumers).toContain("all-employees");
    });
  });
});

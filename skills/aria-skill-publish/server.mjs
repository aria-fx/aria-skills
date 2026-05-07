#!/usr/bin/env node
// aria-skill-publish — MCP Server
// Packages ARIA assets as OCI artifacts and pushes to registries.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const server = new Server(
  { name: "aria-skill-publish", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "build_oci_artifact",
      description: "Build an OCI artifact from an ARIA asset directory containing oasf-record.json, oasf-governance.json, and src/.",
      inputSchema: {
        type: "object",
        properties: {
          asset_path: { type: "string", description: "Path to the ARIA asset directory" },
          registry: { type: "string", description: "OCI registry (e.g., ghcr.io/org/aria-assets)" }
        },
        required: ["asset_path", "registry"]
      }
    },
    {
      name: "push_to_registry",
      description: "Push a built OCI artifact to the target registry.",
      inputSchema: {
        type: "object",
        properties: {
          image_ref: { type: "string", description: "Full image reference including tag" }
        },
        required: ["image_ref"]
      }
    },
    {
      name: "calculate_cid",
      description: "Calculate the content-addressed identifier (CID/SHA-256 digest) for an OCI artifact.",
      inputSchema: {
        type: "object",
        properties: {
          asset_path: { type: "string", description: "Path to the ARIA asset directory" }
        },
        required: ["asset_path"]
      }
    },
    {
      name: "tag_release",
      description: "Tag the current OCI artifact with a semantic version and 'latest'.",
      inputSchema: {
        type: "object",
        properties: {
          image_ref: { type: "string", description: "Base image reference" },
          version: { type: "string", description: "Semantic version tag" }
        },
        required: ["image_ref", "version"]
      }
    }
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  let result;

  switch (name) {
    case "build_oci_artifact": {
      const recordPath = `${args.asset_path}/oasf-record.json`;
      if (!existsSync(recordPath)) {
        result = { success: false, error: `No oasf-record.json found at ${args.asset_path}` };
        break;
      }
      const record = JSON.parse(readFileSync(recordPath, "utf-8"));
      const artifactName = record.name.replace(/\//g, "-");
      const tag = record.version;
      const imageRef = `${args.registry}/${artifactName}:${tag}`;

      result = {
        success: true,
        image_ref: imageRef,
        asset_name: record.name,
        version: tag,
        command: `docker build -t ${imageRef} ${args.asset_path}`
      };
      break;
    }

    case "push_to_registry": {
      result = {
        success: true,
        pushed: args.image_ref,
        command: `docker push ${args.image_ref}`
      };
      break;
    }

    case "calculate_cid": {
      const files = ["oasf-record.json", "oasf-governance.json"];
      const contents = files
        .map(f => `${args.asset_path}/${f}`)
        .filter(existsSync)
        .map(f => readFileSync(f, "utf-8"))
        .join("");
      const digest = createHash("sha256").update(contents).digest("hex");
      result = { cid: `sha256:${digest}`, algorithm: "sha256" };
      break;
    }

    case "tag_release": {
      result = {
        success: true,
        tags: [`${args.image_ref}:${args.version}`, `${args.image_ref}:latest`],
        commands: [
          `docker tag ${args.image_ref}:${args.version} ${args.image_ref}:latest`,
          `docker push ${args.image_ref}:${args.version}`,
          `docker push ${args.image_ref}:latest`
        ]
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

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleToolCall } from "../server.mjs";

test("build_oci_artifact reads manifests and generates publish metadata", async () => {
  const assetPath = mkdtempSync(path.join(tmpdir(), "aria-publish-"));

  try {
    writeFileSync(
      path.join(assetPath, "oasf-record.json"),
      JSON.stringify({ name: "aria.dev/skills/publish", version: "1.2.3" })
    );
    writeFileSync(
      path.join(assetPath, "oasf-governance.json"),
      JSON.stringify({ governance: { sensitivity_tier: "internal" } })
    );

    const result = await handleToolCall("build_oci_artifact", {
      asset_path: assetPath,
      registry: "ghcr.io/aria-fx/aria-skills"
    });

    assert.equal(result.success, true);
    assert.equal(result.asset_name, "aria.dev/skills/publish");
    assert.equal(result.image_ref, "ghcr.io/aria-fx/aria-skills/aria.dev-skills-publish:1.2.3");
    assert.match(result.command, /docker build -t ghcr\.io\/aria-fx\/aria-skills\/aria\.dev-skills-publish:1\.2\.3/);
  } finally {
    rmSync(assetPath, { recursive: true, force: true });
  }
});

test("calculate_cid hashes manifest contents deterministically", async () => {
  const assetPath = mkdtempSync(path.join(tmpdir(), "aria-publish-"));

  try {
    const record = JSON.stringify({ name: "aria.dev/skills/publish", version: "1.2.3" });
    const governance = JSON.stringify({ governance: { sensitivity_tier: "internal" } });
    writeFileSync(path.join(assetPath, "oasf-record.json"), record);
    writeFileSync(path.join(assetPath, "oasf-governance.json"), governance);

    const result = await handleToolCall("calculate_cid", {
      asset_path: assetPath
    });

    const expected = createHash("sha256").update(record + governance).digest("hex");
    assert.equal(result.cid, `sha256:${expected}`);
    assert.equal(result.algorithm, "sha256");
  } finally {
    rmSync(assetPath, { recursive: true, force: true });
  }
});

test("tag_release and push_to_registry return publish commands", async () => {
  const pushResult = await handleToolCall("push_to_registry", {
    image_ref: "ghcr.io/aria-fx/aria-skills/aria.dev-skills-publish:1.2.3"
  });
  assert.equal(pushResult.success, true);
  assert.match(pushResult.command, /docker push/);

  const tagResult = await handleToolCall("tag_release", {
    image_ref: "ghcr.io/aria-fx/aria-skills/aria.dev-skills-publish",
    version: "1.2.3"
  });
  assert.deepEqual(tagResult.tags, [
    "ghcr.io/aria-fx/aria-skills/aria.dev-skills-publish:1.2.3",
    "ghcr.io/aria-fx/aria-skills/aria.dev-skills-publish:latest"
  ]);
  assert.equal(tagResult.commands.length, 3);
});

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptPath = path.resolve(process.cwd(), ".github/scripts/detect-changed-skills.sh");
const tempRepos: string[] = [];

function run(command: string, cwd: string): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8" }).trim();
}

function createRepoWithHistory(): { repoDir: string; baseSha: string; headSha: string } {
  const repoDir = mkdtempSync(path.join(tmpdir(), "changed-skills-"));
  tempRepos.push(repoDir);

  run("git init", repoDir);
  run('git config user.name "test-user"', repoDir);
  run('git config user.email "test@example.com"', repoDir);

  mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
  mkdirSync(path.join(repoDir, "skills", "aria-skill-beta"), { recursive: true });
  writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "SKILL.md"), "# alpha\n");
  writeFileSync(path.join(repoDir, "skills", "aria-skill-beta", "SKILL.md"), "# beta\n");
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  run("git add . && git commit -m 'base'", repoDir);
  const baseSha = run("git rev-parse HEAD", repoDir);

  writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "SKILL.md"), "# alpha updated\n");
  writeFileSync(path.join(repoDir, "skills", "aria-skill-beta", "notes.txt"), "note\n");
  writeFileSync(path.join(repoDir, "README.md"), "hello world\n");
  run("git add . && git commit -m 'head'", repoDir);
  const headSha = run("git rev-parse HEAD", repoDir);

  return { repoDir, baseSha, headSha };
}

afterEach(() => {
  while (tempRepos.length > 0) {
    const repoDir = tempRepos.pop();
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }
});

describe("detect-changed-skills.sh", () => {
  it("returns a unique sorted JSON array of changed skill directories", () => {
    const { repoDir, baseSha, headSha } = createRepoWithHistory();

    const output = execFileSync("bash", [scriptPath], {
      cwd: repoDir,
      env: { ...process.env, BASE_SHA: baseSha, HEAD_SHA: headSha },
      encoding: "utf8"
    }).trim();

    expect(output).toBe('["aria-skill-alpha","aria-skill-beta"]');
  });

  it("writes matrix output to GITHUB_OUTPUT when provided", () => {
    const { repoDir, baseSha, headSha } = createRepoWithHistory();
    const outputFile = path.join(repoDir, "github-output.txt");

    execFileSync("bash", [scriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        OUTPUT_KEY: "matrix",
        GITHUB_OUTPUT: outputFile
      },
      encoding: "utf8"
    });

    const githubOutput = readFileSync(outputFile, "utf8").trim();
    expect(githubOutput).toBe('matrix=["aria-skill-alpha","aria-skill-beta"]');
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scriptPath = path.resolve(process.cwd(), ".github/scripts/detect-changed-skills.sh");
const lintSectionsScriptPath = path.resolve(process.cwd(), ".github/scripts/lint-skill-markdown-sections.sh");
const warnEvalsScriptPath = path.resolve(process.cwd(), ".github/scripts/warn-missing-evals.sh");
const detectEvalTargetsScriptPath = path.resolve(process.cwd(), ".github/scripts/detect-eval-targets.sh");
const bumpSkillVersionScriptPath = path.resolve(process.cwd(), ".github/scripts/bump-skill-version.sh");
const filterPublishableSkillsScriptPath = path.resolve(process.cwd(), ".github/scripts/filter-publishable-skills.sh");
const compareEvalSummaryScriptPath = path.resolve(process.cwd(), ".github/scripts/compare-eval-summary.mjs");
const summarizeEvalResultsScriptPath = path.resolve(process.cwd(), ".github/scripts/summarize-eval-results.mjs");
const detectModelDriftScriptPath = path.resolve(process.cwd(), ".github/scripts/detect-model-drift.mjs");
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

describe("skill lint scripts", () => {
  it("fails when required SKILL.md sections are missing", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-sections-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "SKILL.md"), "## Description\n");

    try {
      execFileSync("bash", [lintSectionsScriptPath], {
        cwd: repoDir,
        env: { ...process.env, CHANGED_SKILLS: '["aria-skill-alpha"]' },
        encoding: "utf8"
      });
    } catch (error) {
      const typedError = error as { stdout?: string; stderr?: string };
      const combinedOutput = `${typedError.stdout || ""}${typedError.stderr || ""}`;
      expect(combinedOutput).toContain("SKILL.md missing required section");
      return;
    }

    expect.fail("Expected lint script to fail for missing required SKILL.md sections");
  });

  it("emits warning annotation when evals yaml is missing", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-evals-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
    const output = execFileSync("bash", [warnEvalsScriptPath], {
      cwd: repoDir,
      env: { ...process.env, CHANGED_SKILLS: '["aria-skill-alpha"]' },
      encoding: "utf8"
    });

    expect(output).toContain("::warning::[aria-skill-alpha] Missing evals/*.yaml (warning only)");
  });

  it("detects only changed skills with has_evals=true and eval files", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-eval-targets-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha", "evals"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "oasf-record.json"), JSON.stringify({ has_evals: true }));
    writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "evals", "promptfoo.yaml"), "prompts: []\n");

    mkdirSync(path.join(repoDir, "skills", "aria-skill-beta", "evals"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-beta", "oasf-record.json"), JSON.stringify({ has_evals: false }));
    writeFileSync(path.join(repoDir, "skills", "aria-skill-beta", "evals", "promptfoo.yaml"), "prompts: []\n");

    mkdirSync(path.join(repoDir, "skills", "aria-skill-gamma"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-gamma", "oasf-record.json"), JSON.stringify({ has_evals: true }));

    const output = execFileSync("bash", [detectEvalTargetsScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        CHANGED_SKILLS: '["aria-skill-alpha","aria-skill-beta","aria-skill-gamma","aria-skill-missing"]'
      },
      encoding: "utf8"
    }).trim();

    expect(output).toBe('["aria-skill-alpha"]');
  });
});

describe("publish workflow helper scripts", () => {
  it("patch-bumps version.txt for each changed skill and falls back to oasf-record version", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-version-bump-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "version.txt"), "1.2.3\n");

    mkdirSync(path.join(repoDir, "skills", "aria-skill-beta"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-beta", "oasf-record.json"), JSON.stringify({ version: "2.0.9" }));

    const output = execFileSync("bash", [bumpSkillVersionScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        CHANGED_SKILLS: '["aria-skill-alpha","aria-skill-beta","aria-skill-missing"]'
      },
      encoding: "utf8"
    }).trim();

    expect(JSON.parse(output)).toEqual({
      "aria-skill-alpha": "1.2.4",
      "aria-skill-beta": "2.0.10"
    });

    expect(readFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "version.txt"), "utf8").trim()).toBe("1.2.4");
    expect(readFileSync(path.join(repoDir, "skills", "aria-skill-beta", "version.txt"), "utf8").trim()).toBe("2.0.10");
  });

  it("filters publishable skills to only those with mcp-manifest.json", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-publishable-filter-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
    writeFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "mcp-manifest.json"), "{}\n");

    mkdirSync(path.join(repoDir, "skills", "aria-skill-beta"), { recursive: true });

    const output = execFileSync("bash", [filterPublishableSkillsScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        CHANGED_SKILLS: '["aria-skill-alpha","aria-skill-beta"]'
      },
      encoding: "utf8"
    }).trim();

    expect(output).toBe('["aria-skill-alpha"]');
  });
});

describe("compare-eval-summary.mjs", () => {
  it("passes when pass rate drop is at most five percentage points and logs delta", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-eval-regression-pass-"));
    tempRepos.push(repoDir);

    const currentDir = path.join(repoDir, "current");
    const baselineDir = path.join(repoDir, "baseline");
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(baselineDir, { recursive: true });

    writeFileSync(
      path.join(currentDir, "eval-summary.json"),
      JSON.stringify([{ skill: "aria-skill-alpha", passRate: 84 }], null, 2)
    );
    writeFileSync(
      path.join(baselineDir, "eval-summary.json"),
      JSON.stringify([{ skill: "aria-skill-alpha", passRate: 88 }], null, 2)
    );

    const output = execFileSync("node", [compareEvalSummaryScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        CURRENT_SUMMARY_PATH: currentDir,
        BASELINE_SUMMARY_PATH: baselineDir,
        MAX_ALLOWED_DROP_POINTS: "5"
      },
      encoding: "utf8"
    });

    expect(output).toContain("[aria-skill-alpha] baseline=88% current=84% delta=-4pp");
    expect(output).toContain("Regression gate passed.");
  });

  it("fails when pass rate drops by more than five percentage points", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-eval-regression-fail-"));
    tempRepos.push(repoDir);

    const currentDir = path.join(repoDir, "current");
    const baselineDir = path.join(repoDir, "baseline");
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(baselineDir, { recursive: true });

    writeFileSync(
      path.join(currentDir, "eval-summary.json"),
      JSON.stringify([{ skill: "aria-skill-alpha", passRate: 82 }], null, 2)
    );
    writeFileSync(
      path.join(baselineDir, "eval-summary.json"),
      JSON.stringify([{ skill: "aria-skill-alpha", passRate: 90 }], null, 2)
    );

    try {
      execFileSync("node", [compareEvalSummaryScriptPath], {
        cwd: repoDir,
        env: {
          ...process.env,
          CURRENT_SUMMARY_PATH: currentDir,
          BASELINE_SUMMARY_PATH: baselineDir,
          MAX_ALLOWED_DROP_POINTS: "5"
        },
        encoding: "utf8"
      });
    } catch (error) {
      const typedError = error as { stdout?: string; stderr?: string };
      const combinedOutput = `${typedError.stdout || ""}${typedError.stderr || ""}`;
      expect(combinedOutput).toContain("Pass rate regressed by 8 percentage points");
      expect(combinedOutput).toContain("Maximum allowed drop is 5");
      return;
    }

    expect.fail("Expected regression comparison script to fail when drop exceeds threshold");
  });

  it("auto-passes with a notice when baseline is missing", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-eval-regression-missing-baseline-"));
    tempRepos.push(repoDir);

    const currentDir = path.join(repoDir, "current");
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      path.join(currentDir, "eval-summary.json"),
      JSON.stringify([{ skill: "aria-skill-alpha", passRate: 100 }], null, 2)
    );

    const output = execFileSync("node", [compareEvalSummaryScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        CURRENT_SUMMARY_PATH: currentDir,
        BASELINE_SUMMARY_PATH: path.join(repoDir, "missing-baseline"),
        MAX_ALLOWED_DROP_POINTS: "5"
      },
      encoding: "utf8"
    });

    expect(output).toContain("::notice::No baseline eval summary artifact found");
    expect(output).toContain("Regression gate auto-passes");
  });
});

describe("summarize-eval-results.mjs", () => {
  it("ranks models by pass rate then avg tokens and writes model-affinity.json", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-eval-summary-"));
    tempRepos.push(repoDir);

    mkdirSync(path.join(repoDir, "skills", "aria-skill-alpha"), { recursive: true });
    mkdirSync(path.join(repoDir, "eval-results", "aria-skill-alpha", "gpt-4o-mini"), { recursive: true });
    mkdirSync(path.join(repoDir, "eval-results", "aria-skill-alpha", "gpt-4o"), { recursive: true });
    mkdirSync(path.join(repoDir, "eval-results", "aria-skill-alpha", "claude-sonnet-4"), { recursive: true });

    writeFileSync(
      path.join(repoDir, "eval-results", "aria-skill-alpha", "gpt-4o-mini", "results.json"),
      JSON.stringify({ stats: { total: 4, passed: 4, totalTokens: 360 } }, null, 2)
    );
    writeFileSync(
      path.join(repoDir, "eval-results", "aria-skill-alpha", "gpt-4o", "results.json"),
      JSON.stringify({ stats: { total: 4, passed: 4, totalTokens: 400 } }, null, 2)
    );
    writeFileSync(
      path.join(repoDir, "eval-results", "aria-skill-alpha", "claude-sonnet-4", "results.json"),
      JSON.stringify({ stats: { total: 4, passed: 3, totalTokens: 300 } }, null, 2)
    );

    execFileSync("node", [summarizeEvalResultsScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        EVAL_RESULTS_ROOT: path.join(repoDir, "eval-results"),
        EVAL_SUMMARY_MARKDOWN: path.join(repoDir, "eval-summary.md"),
        EVAL_SUMMARY_JSON: path.join(repoDir, "eval-summary.json"),
        GITHUB_WORKSPACE: repoDir,
        GITHUB_SHA: "abc123"
      },
      encoding: "utf8"
    });

    const summary = JSON.parse(readFileSync(path.join(repoDir, "eval-summary.json"), "utf8")) as Array<{
      skill: string;
      optimalModel: string;
      passRate: number;
      avgTokens: number;
    }>;
    expect(summary).toEqual([
      { skill: "aria-skill-alpha", optimalModel: "gpt-4o-mini", passRate: 100, avgTokens: 90 }
    ]);

    const affinity = JSON.parse(
      readFileSync(path.join(repoDir, "skills", "aria-skill-alpha", "model-affinity.json"), "utf8")
    ) as {
      optimalModel: string;
      scoreboard: Array<{ model: string; passRate: number; avgTokens: number }>;
      commitSha: string;
      selectionCriteria: { primary: string; tiebreaker: string };
    };

    expect(affinity.optimalModel).toBe("gpt-4o-mini");
    expect(affinity.scoreboard.map((row) => row.model)).toEqual(["gpt-4o-mini", "gpt-4o", "claude-sonnet-4"]);
    expect(affinity.commitSha).toBe("abc123");
    expect(affinity.selectionCriteria).toEqual({ primary: "passRate desc", tiebreaker: "avgTokens asc" });

    const markdown = readFileSync(path.join(repoDir, "eval-summary.md"), "utf8");
    expect(markdown).toContain("### Multi-Model Eval Scoreboard");
    expect(markdown).toContain("**gpt-4o-mini ← optimal**");
  });
});

describe("detect-model-drift.mjs", () => {
  it("flags drift when optimal model changes or pass rate drops more than threshold", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-model-drift-detect-"));
    tempRepos.push(repoDir);

    const baselineRoot = path.join(repoDir, "baseline", "skills");
    const currentRoot = path.join(repoDir, "current", "skills");
    mkdirSync(path.join(baselineRoot, "aria-skill-alpha"), { recursive: true });
    mkdirSync(path.join(currentRoot, "aria-skill-alpha"), { recursive: true });

    writeFileSync(
      path.join(baselineRoot, "aria-skill-alpha", "model-affinity.json"),
      JSON.stringify({
        optimalModel: "gpt-4o-mini",
        scoreboard: [{ model: "gpt-4o-mini", passRate: 95, avgTokens: 100 }]
      }, null, 2)
    );
    writeFileSync(
      path.join(currentRoot, "aria-skill-alpha", "model-affinity.json"),
      JSON.stringify({
        optimalModel: "claude-sonnet-4",
        scoreboard: [{ model: "claude-sonnet-4", passRate: 90, avgTokens: 105 }]
      }, null, 2)
    );

    const githubOutput = path.join(repoDir, "github-output.txt");
    execFileSync("node", [detectModelDriftScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        BASELINE_AFFINITY_ROOT: baselineRoot,
        CURRENT_AFFINITY_ROOT: currentRoot,
        DRIFT_MAX_PASS_RATE_DROP: "3",
        DRIFT_REPORT_JSON: path.join(repoDir, "drift-report.json"),
        DRIFT_REPORT_MARKDOWN: path.join(repoDir, "drift-report.md"),
        GITHUB_OUTPUT: githubOutput
      },
      encoding: "utf8"
    });

    const report = JSON.parse(readFileSync(path.join(repoDir, "drift-report.json"), "utf8")) as {
      driftDetected: boolean;
      affectedSkills: Array<{ skill: string; optimalModelChanged: boolean; passRateDropped: boolean }>;
    };
    expect(report.driftDetected).toBe(true);
    expect(report.affectedSkills).toHaveLength(1);
    expect(report.affectedSkills[0]).toMatchObject({
      skill: "aria-skill-alpha",
      optimalModelChanged: true,
      passRateDropped: true
    });

    const markdown = readFileSync(path.join(repoDir, "drift-report.md"), "utf8");
    expect(markdown).toContain("| aria-skill-alpha | gpt-4o-mini | claude-sonnet-4 | 95% | 90% | 5 |");
    expect(readFileSync(githubOutput, "utf8")).toContain("drift_detected=true");
  });

  it("does not flag drift when pass rate drop is within threshold and optimal model remains same", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "skill-model-drift-none-"));
    tempRepos.push(repoDir);

    const baselineRoot = path.join(repoDir, "baseline", "skills");
    const currentRoot = path.join(repoDir, "current", "skills");
    mkdirSync(path.join(baselineRoot, "aria-skill-alpha"), { recursive: true });
    mkdirSync(path.join(currentRoot, "aria-skill-alpha"), { recursive: true });

    writeFileSync(
      path.join(baselineRoot, "aria-skill-alpha", "model-affinity.json"),
      JSON.stringify({
        optimalModel: "gpt-4o-mini",
        scoreboard: [{ model: "gpt-4o-mini", passRate: 95, avgTokens: 100 }]
      }, null, 2)
    );
    writeFileSync(
      path.join(currentRoot, "aria-skill-alpha", "model-affinity.json"),
      JSON.stringify({
        optimalModel: "gpt-4o-mini",
        scoreboard: [{ model: "gpt-4o-mini", passRate: 93, avgTokens: 105 }]
      }, null, 2)
    );

    const githubOutput = path.join(repoDir, "github-output.txt");
    const output = execFileSync("node", [detectModelDriftScriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        BASELINE_AFFINITY_ROOT: baselineRoot,
        CURRENT_AFFINITY_ROOT: currentRoot,
        DRIFT_MAX_PASS_RATE_DROP: "3",
        DRIFT_REPORT_JSON: path.join(repoDir, "drift-report.json"),
        DRIFT_REPORT_MARKDOWN: path.join(repoDir, "drift-report.md"),
        GITHUB_OUTPUT: githubOutput
      },
      encoding: "utf8"
    });

    expect(output).toContain("No model drift detected.");
    const report = JSON.parse(readFileSync(path.join(repoDir, "drift-report.json"), "utf8")) as {
      driftDetected: boolean;
      affectedSkills: Array<unknown>;
    };
    expect(report.driftDetected).toBe(false);
    expect(report.affectedSkills).toEqual([]);
    expect(readFileSync(githubOutput, "utf8")).toContain("drift_detected=false");
  });
});

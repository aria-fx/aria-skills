#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const resultsRoot = process.env.EVAL_RESULTS_ROOT || "eval-results";
const outputMarkdownPath = process.env.EVAL_SUMMARY_MARKDOWN || "eval-summary.md";
const outputJsonPath = process.env.EVAL_SUMMARY_JSON || "eval-summary.json";
const failThreshold = Number(process.env.EVAL_FAIL_THRESHOLD || "80");
const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const commitSha = process.env.GITHUB_SHA || "";
const affinityCriteria = {
  primary: "passRate desc",
  tiebreaker: "avgTokens asc"
};

if (!fs.existsSync(resultsRoot)) {
  fs.writeFileSync(outputMarkdownPath, "No eval artifacts were found.");
  fs.writeFileSync(outputJsonPath, JSON.stringify([], null, 2));
  process.exit(0);
}

function listResultFiles(rootDir) {
  const queue = [rootDir];
  const files = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === "results.json") {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function parseResultFile(filePath) {
  const relParts = path.relative(resultsRoot, filePath).split(path.sep);
  const skill = relParts[0] || "unknown-skill";
  const model = relParts[1] || "unknown-model";
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const stats = parsed.stats || {};
  const resultRows = Array.isArray(parsed.results) ? parsed.results : [];
  const inferredPassed = resultRows.filter((row) => row?.success === true || row?.pass === true || row?.gradingResult?.pass === true).length;
  const inferredTotal = resultRows.length;
  const total = Number(stats.total ?? stats.tests ?? inferredTotal);
  const passed = Number(stats.successes ?? stats.passed ?? inferredPassed);
  const failed = Number(stats.failures ?? Math.max(total - passed, 0));
  const passRate = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;
  const totalTokens = Number(
    stats.totalTokens ??
      stats.total_tokens ??
      stats.tokens ??
      stats.tokensUsed?.total ??
      stats.tokenUsage?.total ??
      0
  );
  const avgTokens = total > 0 ? Number((totalTokens / total).toFixed(2)) : Number(totalTokens.toFixed(2));
  const status = passRate >= failThreshold ? "PASS" : "FAIL";

  return { skill, model, passed, failed, total, passRate, totalTokens, avgTokens, status };
}

const bySkill = new Map();
const errors = [];

for (const filePath of listResultFiles(resultsRoot)) {
  try {
    const parsed = parseResultFile(filePath);
    const rows = bySkill.get(parsed.skill) || [];
    rows.push(parsed);
    bySkill.set(parsed.skill, rows);
  } catch (error) {
    const relParts = path.relative(resultsRoot, filePath).split(path.sep);
    const skill = relParts[0] || "unknown-skill";
    const model = relParts[1] || "unknown-model";
    errors.push({ skill, model, error: `invalid JSON: ${error.message}` });
  }
}

const skills = [...bySkill.keys()].sort();
const summary = [];
const lines = ["<!-- unit-eval-summary -->", "### Multi-Model Eval Scoreboard", ""];

for (const skill of skills) {
  const rows = (bySkill.get(skill) || [])
    .slice()
    .sort((a, b) => (b.passRate - a.passRate) || (a.avgTokens - b.avgTokens) || a.model.localeCompare(b.model));
  const optimal = rows[0];

  if (!optimal) {
    continue;
  }

  const affinity = {
    optimalModel: optimal.model,
    scoreboard: rows.map((row) => ({
      model: row.model,
      status: row.status,
      passed: row.passed,
      failed: row.failed,
      total: row.total,
      passRate: row.passRate,
      avgTokens: row.avgTokens
    })),
    commitSha,
    selectionCriteria: affinityCriteria
  };

  const affinityPath = path.join(repoRoot, "skills", skill, "model-affinity.json");
  if (fs.existsSync(path.dirname(affinityPath))) {
    fs.writeFileSync(affinityPath, `${JSON.stringify(affinity, null, 2)}\n`);
  } else {
    errors.push({ skill, model: "n/a", error: "skill directory missing for model-affinity.json write" });
  }

  summary.push({
    skill,
    optimalModel: optimal.model,
    passRate: optimal.passRate,
    avgTokens: optimal.avgTokens
  });

  lines.push(`#### \`${skill}\``);
  lines.push("");
  lines.push("| Model | Status | Passed | Failed | Pass rate | Avg tokens |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    const modelLabel = row.model === optimal.model ? `**${row.model} ← optimal**` : row.model;
    lines.push(
      `| ${modelLabel} | ${row.status} | ${row.passed} | ${row.failed} | ${row.passRate}% (${row.passed}/${row.total}) | ${row.avgTokens} |`
    );
  }
  lines.push("");
}

if (skills.length === 0) {
  lines.push("No eval artifacts were found.");
}

if (errors.length > 0) {
  lines.push("Errors:");
  for (const row of errors) {
    lines.push(`- \`${row.skill}\` / \`${row.model}\`: ${row.error}`);
  }
}

fs.writeFileSync(outputMarkdownPath, `${lines.join("\n")}\n`);
fs.writeFileSync(outputJsonPath, JSON.stringify(summary, null, 2));

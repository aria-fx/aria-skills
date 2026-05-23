#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const resultsRoot = process.env.EVAL_RESULTS_ROOT || "eval-results";
const outputMarkdownPath = process.env.EVAL_SUMMARY_MARKDOWN || "eval-summary.md";
const outputJsonPath = process.env.EVAL_SUMMARY_JSON || "eval-summary.json";
const failThreshold = Number(process.env.EVAL_FAIL_THRESHOLD || "80");

if (!fs.existsSync(resultsRoot)) {
  fs.writeFileSync(outputMarkdownPath, "No eval artifacts were found.");
  fs.writeFileSync(outputJsonPath, JSON.stringify([], null, 2));
  process.exit(0);
}

const skillDirs = fs.readdirSync(resultsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
const summary = skillDirs.map((entry) => {
  const skill = entry.name;
  const filePath = path.join(resultsRoot, skill, "results.json");

  if (!fs.existsSync(filePath)) {
    return { skill, passed: 0, failed: 0, total: 0, passRate: 0, status: "FAIL", error: "results.json missing" };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const stats = parsed.stats || {};
    const resultRows = Array.isArray(parsed.results) ? parsed.results : [];
    const inferredPassed = resultRows.filter((row) => row?.success === true || row?.pass === true || row?.gradingResult?.pass === true).length;
    const inferredTotal = resultRows.length;
    const total = Number(stats.total ?? stats.tests ?? inferredTotal);
    const passed = Number(stats.successes ?? stats.passed ?? inferredPassed);
    const failed = Number(stats.failures ?? Math.max(total - passed, 0));
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const status = passRate >= failThreshold ? "PASS" : "FAIL";
    return { skill, passed, failed, total, passRate, status };
  } catch (error) {
    return {
      skill,
      passed: 0,
      failed: 0,
      total: 0,
      passRate: 0,
      status: "FAIL",
      error: `invalid JSON: ${error.message}`
    };
  }
});

const lines = [
  "<!-- unit-eval-summary -->",
  "### Unit Eval Summary",
  "",
  "| Skill | Status | Passed | Failed | Pass rate |",
  "| --- | --- | ---: | ---: | ---: |",
  ...summary.map(
    (row) =>
      `| \`${row.skill}\` | ${row.status} | ${row.passed} | ${row.failed} | ${row.passRate}%${row.total > 0 ? ` (${row.passed}/${row.total})` : ""} |`
  )
];

const errors = summary.filter((row) => row.error);
if (errors.length > 0) {
  lines.push("", "Errors:");
  for (const row of errors) {
    lines.push(`- \`${row.skill}\`: ${row.error}`);
  }
}

fs.writeFileSync(outputMarkdownPath, `${lines.join("\n")}\n`);
fs.writeFileSync(outputJsonPath, JSON.stringify(summary, null, 2));

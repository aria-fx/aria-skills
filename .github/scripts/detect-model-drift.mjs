#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const baselineRoot = process.env.BASELINE_AFFINITY_ROOT || "model-affinity-baseline/skills";
const currentRoot = process.env.CURRENT_AFFINITY_ROOT || "skills";
const defaultMaxDrop = 3;
const maxDropEnv = process.env.DRIFT_MAX_PASS_RATE_DROP;
const parsedMaxDrop = maxDropEnv === undefined || maxDropEnv.trim() === ""
  ? defaultMaxDrop
  : Number(maxDropEnv);
const maxDrop = Number.isFinite(parsedMaxDrop) ? parsedMaxDrop : defaultMaxDrop;
if (!Number.isFinite(parsedMaxDrop)) {
  console.warn(
    `::warning::Invalid DRIFT_MAX_PASS_RATE_DROP value "${maxDropEnv}". Falling back to default ${defaultMaxDrop}.`
  );
}
const reportJsonPath = process.env.DRIFT_REPORT_JSON || "model-drift-report.json";
const reportMarkdownPath = process.env.DRIFT_REPORT_MARKDOWN || "model-drift-report.md";
const githubOutputPath = process.env.GITHUB_OUTPUT;

function readAffinity(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const scoreboard = Array.isArray(parsed?.scoreboard) ? parsed.scoreboard : [];
  const model = typeof parsed?.optimalModel === "string" ? parsed.optimalModel : "";
  const matchedRow = scoreboard.find((row) => row?.model === model);
  const fallbackRow = scoreboard[0];
  const chosenRow = matchedRow || fallbackRow;
  const passRate = Number(chosenRow?.passRate);

  return {
    optimalModel: model,
    passRate: Number.isFinite(passRate) ? passRate : null
  };
}

function listSkills(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function appendOutput(name, value) {
  if (!githubOutputPath) {
    return;
  }
  fs.appendFileSync(githubOutputPath, `${name}=${value}\n`);
}

const affectedSkills = [];

for (const skill of listSkills(currentRoot)) {
  const currentPath = path.join(currentRoot, skill, "model-affinity.json");
  const baselinePath = path.join(baselineRoot, skill, "model-affinity.json");

  if (!fs.existsSync(currentPath) || !fs.existsSync(baselinePath)) {
    continue;
  }

  let current;
  let baseline;
  try {
    current = readAffinity(currentPath);
    baseline = readAffinity(baselinePath);
  } catch (error) {
    console.warn(`::warning::[${skill}] Unable to parse model affinity data: ${error.message}`);
    continue;
  }

  if (typeof current.optimalModel !== "string" || typeof baseline.optimalModel !== "string") {
    continue;
  }

  const optimalModelChanged = current.optimalModel !== baseline.optimalModel;
  const passRateDrop = Number.isFinite(baseline.passRate) && Number.isFinite(current.passRate)
    ? Number((baseline.passRate - current.passRate).toFixed(2))
    : null;
  const passRateDropped = passRateDrop !== null && passRateDrop > maxDrop;

  if (!optimalModelChanged && !passRateDropped) {
    continue;
  }

  affectedSkills.push({
    skill,
    baselineOptimalModel: baseline.optimalModel,
    currentOptimalModel: current.optimalModel,
    baselinePassRate: baseline.passRate,
    currentPassRate: current.passRate,
    passRateDrop,
    optimalModelChanged,
    passRateDropped,
    trigger: [
      optimalModelChanged ? "optimal-model-changed" : null,
      passRateDropped ? `pass-rate-drop>${maxDrop}` : null
    ].filter(Boolean).join(",")
  });
}

const signature = JSON.stringify({
  maxDrop,
  affectedSkills: affectedSkills.map((row) => ({
    skill: row.skill,
    baselineOptimalModel: row.baselineOptimalModel,
    currentOptimalModel: row.currentOptimalModel,
    baselinePassRate: row.baselinePassRate,
    currentPassRate: row.currentPassRate,
    trigger: row.trigger
  }))
});
const eventKey = crypto.createHash("sha256").update(signature).digest("hex").slice(0, 16);
const driftDetected = affectedSkills.length > 0;

const report = {
  generatedAt: new Date().toISOString(),
  maxDrop,
  driftDetected,
  eventKey,
  affectedSkills
};

const markdownLines = [
  "### Drifted Skills",
  "",
  "| Skill | Baseline optimal | Current optimal | Baseline pass rate | Current pass rate | Drop (pp) | Trigger |",
  "| --- | --- | --- | ---: | ---: | ---: | --- |"
];

if (driftDetected) {
  for (const row of affectedSkills) {
    const baselinePassRate = Number.isFinite(row.baselinePassRate) ? `${row.baselinePassRate}%` : "n/a";
    const currentPassRate = Number.isFinite(row.currentPassRate) ? `${row.currentPassRate}%` : "n/a";
    const drop = Number.isFinite(row.passRateDrop) ? `${row.passRateDrop}` : "n/a";
    markdownLines.push(
      `| ${row.skill} | ${row.baselineOptimalModel} | ${row.currentOptimalModel} | ${baselinePassRate} | ${currentPassRate} | ${drop} | ${row.trigger} |`
    );
  }
} else {
  markdownLines.push("| _none_ | - | - | - | - | - | - |");
}

fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(reportMarkdownPath, `${markdownLines.join("\n")}\n`);

appendOutput("drift_detected", driftDetected ? "true" : "false");
appendOutput("drift_event_key", eventKey);

if (driftDetected) {
  console.log(`::warning::Detected model drift for ${affectedSkills.length} skill(s). Event key: ${eventKey}`);
} else {
  console.log("No model drift detected.");
}

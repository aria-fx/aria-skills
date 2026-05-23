#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const currentSummaryPath = process.env.CURRENT_SUMMARY_PATH || "eval-summary/current";
const baselineSummaryPath = process.env.BASELINE_SUMMARY_PATH || "eval-summary/baseline";
const maxAllowedDropPoints = Number(process.env.MAX_ALLOWED_DROP_POINTS || "5");

function findSummaryFile(inputPath) {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return inputPath;
  }

  if (stat.isDirectory()) {
    const queue = [inputPath];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isFile() && entry.name === "eval-summary.json") {
          return entryPath;
        }

        if (entry.isDirectory()) {
          queue.push(entryPath);
        }
      }
    }
  }

  return null;
}

function loadSummary(summaryPath) {
  const raw = fs.readFileSync(summaryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array in ${summaryPath}`);
  }
  return parsed;
}

const currentFile = findSummaryFile(currentSummaryPath);
if (!currentFile) {
  console.error(`::error::Current eval summary not found at ${currentSummaryPath}`);
  process.exit(1);
}

const currentSummary = loadSummary(currentFile);
const baselineFile = findSummaryFile(baselineSummaryPath);
if (!baselineFile) {
  console.log(`::notice::No baseline eval summary artifact found at ${baselineSummaryPath}. Regression gate auto-passes.`);
  process.exit(0);
}

const baselineSummary = loadSummary(baselineFile);
const baselineBySkill = new Map(
  baselineSummary
    .filter((row) => typeof row?.skill === "string")
    .map((row) => [row.skill, Number(row.passRate)])
);

const regressions = [];
for (const row of currentSummary) {
  const skill = row?.skill;
  const currentPassRate = Number(row?.passRate);

  if (typeof skill !== "string" || !Number.isFinite(currentPassRate)) {
    continue;
  }

  const baselinePassRate = baselineBySkill.get(skill);
  if (!Number.isFinite(baselinePassRate)) {
    console.log(
      `::notice::[${skill}] Missing baseline score on main. Current pass rate=${currentPassRate}%. Auto-pass for first baseline run.`
    );
    continue;
  }

  const delta = Number((currentPassRate - baselinePassRate).toFixed(2));
  console.log(`[${skill}] baseline=${baselinePassRate}% current=${currentPassRate}% delta=${delta}pp`);

  if (delta < -maxAllowedDropPoints) {
    regressions.push({ skill, baselinePassRate, currentPassRate, delta });
  }
}

if (regressions.length > 0) {
  for (const regression of regressions) {
    const droppedBy = Number(Math.abs(regression.delta).toFixed(2));
    console.error(
      `::error::[${regression.skill}] Pass rate regressed by ${droppedBy} percentage points ` +
        `(main=${regression.baselinePassRate}%, pr=${regression.currentPassRate}%). ` +
        `Maximum allowed drop is ${maxAllowedDropPoints} percentage points.`
    );
  }
  process.exit(1);
}

console.log(`Regression gate passed. No skill dropped by more than ${maxAllowedDropPoints} percentage points.`);

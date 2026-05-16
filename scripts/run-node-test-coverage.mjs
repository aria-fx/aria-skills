#!/usr/bin/env node

import { spawn } from "node:child_process";

const COVERAGE_BASELINE = {
  lines: 65,
  branches: 35,
  functions: 80
};

const testArgs = process.argv.slice(2);

if (testArgs.length === 0) {
  console.error("Usage: node run-node-test-coverage.mjs <node-test-args...>");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", "--experimental-test-coverage", "--test-reporter=spec", ...testArgs],
  { stdio: ["inherit", "pipe", "pipe"] }
);

child.on("error", (error) => {
  console.error(`Failed to start Node test coverage run: ${error.message}`);
  process.exit(1);
});

let output = "";

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process[stream === child.stdout ? "stdout" : "stderr"].write(text);
  });
}

function parseCoverageTableCells(line) {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function normalizeCoverageHeader(cell) {
  return cell.toLowerCase().replace(/[^a-z]+/g, "");
}

function parseOverallCoverageSummary(text) {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find(
    (line) => line.includes("|") && /branch\s*%/i.test(line) && /func/i.test(line) && /line\s*%/i.test(line)
  );
  const allFilesLine = lines.find((line) => /\ball files\b/i.test(line) && line.includes("|"));

  if (!allFilesLine) {
    return null;
  }

  const rowCells = parseCoverageTableCells(allFilesLine);

  if (headerLine) {
    const headerCells = parseCoverageTableCells(headerLine);
    const headerIndexes = new Map(
      headerCells.map((cell, index) => [normalizeCoverageHeader(cell), index])
    );

    const branchesIndex = headerIndexes.get("branch");
    const functionsIndex = headerIndexes.get("funcs") ?? headerIndexes.get("functions");
    const linesIndex = headerIndexes.get("line") ?? headerIndexes.get("lines");

    if (branchesIndex !== undefined && functionsIndex !== undefined && linesIndex !== undefined) {
      const branches = Number.parseFloat(rowCells[branchesIndex]);
      const functions = Number.parseFloat(rowCells[functionsIndex]);
      const coveredLines = Number.parseFloat(rowCells[linesIndex]);

      if (
        Number.isFinite(branches) &&
        Number.isFinite(functions) &&
        Number.isFinite(coveredLines)
      ) {
        return {
          lines: coveredLines,
          branches,
          functions
        };
      }
    }
  }

  const percentageValues = rowCells
    .slice(1)
    .map((cell) => Number.parseFloat(cell))
    .filter((value) => Number.isFinite(value));

  if (percentageValues.length === 3) {
    return {
      lines: percentageValues[0],
      branches: percentageValues[1],
      functions: percentageValues[2]
    };
  }

  if (percentageValues.length < 4) {
    return null;
  }

  return {
    lines: percentageValues[3],
    branches: percentageValues[1],
    functions: percentageValues[2]
  };
}

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  const coverage = parseOverallCoverageSummary(output);
  if (!coverage) {
    console.error("Coverage baseline check failed: could not parse overall coverage summary.");
    process.exit(1);
  }

  const failures = Object.entries(COVERAGE_BASELINE)
    .filter(([key, minimum]) => coverage[key] < minimum)
    .map(([key, minimum]) => `${key} ${coverage[key].toFixed(2)}% < ${minimum}%`);

  if (failures.length > 0) {
    console.error(`Coverage baseline failed: ${failures.join(", ")}`);
    process.exit(1);
  }

  console.log(
    `Coverage baseline met: lines ${coverage.lines.toFixed(2)}%, ` +
      `branches ${coverage.branches.toFixed(2)}%, functions ${coverage.functions.toFixed(2)}%`
  );
});

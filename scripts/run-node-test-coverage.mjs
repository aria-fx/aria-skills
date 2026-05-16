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

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }

  const match = output.match(/all fil.*?\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/i);
  if (!match) {
    console.error("Coverage baseline check failed: could not parse overall coverage summary.");
    process.exit(1);
  }

  const coverage = {
    lines: Number.parseFloat(match[1]),
    branches: Number.parseFloat(match[2]),
    functions: Number.parseFloat(match[3])
  };

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

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const changedSkills = JSON.parse(process.env.CHANGED_SKILLS || "[]");
const schemaPath = path.join(process.cwd(), "schemas", "oasf-skill.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });

addFormats(ajv);

const validate = ajv.compile(schema);
const failures = [];

for (const skillName of changedSkills) {
  const manifestPath = path.join(process.cwd(), "skills", skillName, "oasf-manifest.json");

  if (!fs.existsSync(manifestPath)) {
    failures.push(`[${skillName}] Missing oasf-manifest.json`);
    continue;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!validate(manifest)) {
      const schemaErrors = (validate.errors || [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      failures.push(`[${skillName}] oasf-manifest.json failed schema validation: ${schemaErrors}`);
    }
  } catch (error) {
    failures.push(`[${skillName}] Invalid oasf-manifest.json: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error("OASF manifest validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("OASF manifest schema validation passed.");

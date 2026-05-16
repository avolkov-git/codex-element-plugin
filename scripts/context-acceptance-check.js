#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const localMatrixPath = path.resolve(repoRoot, "docs/evals/context-acceptance-scenarios.json");
const legacyMatrixPath = path.resolve(repoRoot, "../local-codex-docs/EVALS/context-acceptance-scenarios.json");
const matrixPath = fs.existsSync(localMatrixPath) ? localMatrixPath : legacyMatrixPath;

function fail(message) {
  errors.push(message);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasNonEmptyArray(object, key) {
  return Array.isArray(object[key]) && object[key].length > 0;
}

const errors = [];

if (!fs.existsSync(matrixPath)) {
  fail(`Acceptance matrix not found: ${matrixPath}`);
} else {
  let matrix;
  try {
    matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  } catch (error) {
    fail(`Acceptance matrix is not valid JSON: ${error.message}`);
  }

  if (matrix) {
    const scenarios = asArray(matrix.scenarios);
    const requiredIds = asArray(matrix.requiredScenarioIds);
    const minimumScenarios = Number(matrix.minimumScenarios || requiredIds.length);
    const ids = new Set();
    const duplicateIds = new Set();
    const areaCounts = new Map();

    if (matrix.version !== 1) {
      fail(`Expected matrix.version = 1, got ${JSON.stringify(matrix.version)}`);
    }
    if (scenarios.length < minimumScenarios) {
      fail(`Expected at least ${minimumScenarios} scenarios, got ${scenarios.length}`);
    }
    if (!hasNonEmptyArray(matrix, "globalReject")) {
      fail("matrix.globalReject must be a non-empty array");
    }

    for (const scenario of scenarios) {
      if (!scenario || typeof scenario !== "object") {
        fail("Each scenario must be an object");
        continue;
      }

      const id = String(scenario.id || "");
      if (!id) {
        fail("Scenario is missing id");
      } else if (ids.has(id)) {
        duplicateIds.add(id);
      } else {
        ids.add(id);
      }

      for (const key of ["title", "area", "chatKind", "mode", "prompt"]) {
        if (!scenario[key] || typeof scenario[key] !== "string") {
          fail(`${id || "<missing-id>"}: missing string field ${key}`);
        }
      }

      for (const key of ["manualSteps", "reject", "acceptance"]) {
        if (!hasNonEmptyArray(scenario, key)) {
          fail(`${id || "<missing-id>"}: ${key} must be a non-empty array`);
        }
      }

      if (!scenario.expected || typeof scenario.expected !== "object") {
        fail(`${id || "<missing-id>"}: expected must be an object`);
      } else {
        for (const key of ["context", "transcript", "output"]) {
          if (!hasNonEmptyArray(scenario.expected, key)) {
            fail(`${id || "<missing-id>"}: expected.${key} must be a non-empty array`);
          }
        }
      }

      if (scenario.area) {
        areaCounts.set(scenario.area, (areaCounts.get(scenario.area) || 0) + 1);
      }
    }

    for (const duplicateId of duplicateIds) {
      fail(`Duplicate scenario id: ${duplicateId}`);
    }

    for (const requiredId of requiredIds) {
      if (!ids.has(requiredId)) {
        fail(`Missing required scenario: ${requiredId}`);
      }
    }

    const requiredAreas = [
      "routing",
      "docs",
      "project",
      "diagnostics",
      "docs-cache",
      "budget",
      "resilience",
      "safety",
      "transcript"
    ];
    for (const area of requiredAreas) {
      if (!areaCounts.has(area)) {
        fail(`Missing required scenario area: ${area}`);
      }
    }

    if (!errors.length) {
      const areaSummary = [...areaCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([area, count]) => `${area}=${count}`)
        .join(", ");
      console.log(`Context acceptance matrix OK: ${scenarios.length} scenarios (${areaSummary}).`);
      console.log(`Matrix: ${matrixPath}`);
    }
  }
}

if (errors.length) {
  console.error("Context acceptance matrix failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

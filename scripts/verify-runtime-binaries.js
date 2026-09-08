#!/usr/bin/env node

const path = require("path");
const {
  targets,
  targetPaths,
  verifyRuntimeManifest,
  validateRuntimeFile
} = require("./runtime-preflight-lib");

const parsedArgs = parseArgs(process.argv.slice(2));
if (parsedArgs.help) {
  printHelp();
  process.exit(0);
}

const root = path.resolve(parsedArgs.root || path.resolve(__dirname, ".."));
const args = new Set(parsedArgs.flags);
const requireCurrent = args.has("--require-current");
const requireAll = args.has("--require-all");
const allowLfsPointer = args.has("--allow-lfs-pointer");

const currentPlatformId = `${process.platform}-${process.arch}`;
const errors = [];
const warnings = [];
const platformFilter = new Set(parsedArgs.platforms);
const checkedPlatforms = [];
const unknownPlatforms = [...platformFilter].filter((platformId) => !targets.some((target) => target.platformId === platformId || target.legacyPlatformId === platformId));
for (const platformId of unknownPlatforms) {
  errors.push(`unknown platform ${platformId}; supported: ${targets.map((target) => target.platformId).join(", ")}`);
}

for (const target of targets) {
  if (platformFilter.size && !platformFilter.has(target.platformId) && !platformFilter.has(target.legacyPlatformId)) {
    continue;
  }
  const candidatePaths = targetPaths(root, target);
  const existingPath = candidatePaths.find((candidate) => require("fs").existsSync(candidate));
  const required = platformFilter.size > 0 || requireAll || (requireCurrent && target.platformId === currentPlatformId);

  if (!existingPath) {
    if (required) {
      errors.push(`missing runtime for ${target.platformId}: expected ${candidatePaths.join(" or ")}`);
    }
    continue;
  }

  const result = validateRuntimeFile(existingPath, target, { allowLfsPointer });
  checkedPlatforms.push(target.platformId);
  errors.push(...result.errors);
  warnings.push(...result.warnings);
}

errors.push(...verifyRuntimeManifest(root, checkedPlatforms, { allowLfsPointer }));

if (warnings.length) {
  for (const warning of warnings) {
    console.warn(`WARN ${warning}`);
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  process.exit(1);
}

console.log(`Runtime binary preflight passed: ${root}`);

function parseArgs(rawArgs) {
  const result = {
    flags: [],
    platforms: [],
    root: "",
    help: false
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--root") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throwUsage("--root requires a path value");
      }
      result.root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      result.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--platform") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throwUsage("--platform requires a platform id");
      }
      result.platforms.push(...splitPlatformList(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      result.platforms.push(...splitPlatformList(arg.slice("--platform=".length)));
      continue;
    }
    result.flags.push(arg);
  }

  return result;
}

function splitPlatformList(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function throwUsage(message) {
  console.error(`ERROR ${message}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: node scripts/verify-runtime-binaries.js [options]

Options:
  --require-current         Require runtime for the current Node platform.
  --require-all             Require runtimes for every supported target.
  --platform <id>[,<id>]    Require and validate one or more platform ids.
  --root <path>             Validate a staged plugin root instead of this repo.
  --allow-lfs-pointer       Treat Git LFS pointer files as warnings.
  --help                    Show this help.

Examples:
  node scripts/verify-runtime-binaries.js --require-current
  node scripts/verify-runtime-binaries.js --platform linux-x64 --root /opt/element/plugins/codex
  node scripts/verify-runtime-binaries.js --require-all --root ./deploy/codex-plugin
`);
}

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  targets,
  targetPaths,
  validateRuntimeFile
} = require("./runtime-preflight-lib");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const root = path.resolve(args.root || path.resolve(__dirname, ".."));
const strict = args.strict;
const allowLfsPointer = args.allowLfsPointer && !strict;
const errors = [];
const warnings = [];

checkRoot(root);
checkRequiredFiles(root);
checkForbiddenEntries(root);
checkPackageMetadata(root);
checkRuntimeBinaries(root);

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

console.log(`Deploy payload preflight passed: ${root}`);

function checkRoot(value) {
  if (!fs.existsSync(value)) {
    errors.push(`plugin root does not exist: ${value}`);
    return;
  }
  const stat = fs.statSync(value);
  if (!stat.isDirectory()) {
    errors.push(`plugin root is not a directory: ${value}`);
  }
}

function checkRequiredFiles(value) {
  const required = [
    "package.json",
    "dist/extension.js",
    "media/chat.js",
    "media/sidebar.js",
    "media/settings.js",
    "resources/context/codex-element-language-rules.md",
    "resources/icons/codex.svg"
  ];
  for (const relativePath of required) {
    const filePath = path.join(value, relativePath);
    if (!fs.existsSync(filePath)) {
      errors.push(`required deploy file is missing: ${relativePath}`);
    }
  }
}

function checkForbiddenEntries(value) {
  const forbiddenDirs = new Set([
    "node_modules",
    ".git",
    ".tmp",
    "coverage"
  ]);
  const forbiddenFileNames = new Set([
    ".DS_Store",
    "Thumbs.db"
  ]);
  const forbiddenExts = new Set([
    ".log",
    ".tmp",
    ".vsix"
  ]);

  walk(value, (entryPath, entry, relativePath) => {
    if (entry.isDirectory() && forbiddenDirs.has(entry.name)) {
      const message = `forbidden directory in deploy payload: ${relativePath}`;
      strict ? errors.push(message) : warnings.push(message);
      return false;
    }
    if (entry.isFile() && forbiddenFileNames.has(entry.name)) {
      const message = `forbidden file in deploy payload: ${relativePath}`;
      strict ? errors.push(message) : warnings.push(message);
    }
    if (entry.isFile() && forbiddenExts.has(path.extname(entry.name).toLowerCase())) {
      const message = `forbidden file type in deploy payload: ${relativePath}`;
      strict ? errors.push(message) : warnings.push(message);
    }
    return true;
  });
}

function checkPackageMetadata(value) {
  const packagePath = path.join(value, "package.json");
  if (!fs.existsSync(packagePath)) {
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    errors.push(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!manifest.name) {
    errors.push("package.json is missing name.");
  }
  if (!manifest.version) {
    errors.push("package.json is missing version.");
  }
  if (manifest.main !== "./dist/extension.js") {
    errors.push(`package.json main must be ./dist/extension.js, got ${manifest.main || "-"}.`);
  }

  const lockPath = path.join(value, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    warnings.push("package-lock.json is missing; reproducible local checks may be weaker.");
    return;
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.version && manifest.version && lock.version !== manifest.version) {
      errors.push(`package-lock.json version ${lock.version} does not match package.json version ${manifest.version}.`);
    }
    const rootPackage = lock.packages && lock.packages[""];
    if (rootPackage?.version && manifest.version && rootPackage.version !== manifest.version) {
      errors.push(`package-lock root version ${rootPackage.version} does not match package.json version ${manifest.version}.`);
    }
  } catch (error) {
    errors.push(`package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkRuntimeBinaries(value) {
  const requestedTargets = requestedRuntimeTargets();
  const requestedPlatformIds = new Set(requestedTargets.map((target) => target.platformId));
  for (const target of requestedTargets) {
    const candidatePaths = targetPaths(value, target);
    const existingPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
    if (!existingPath) {
      errors.push(`missing runtime for ${target.platformId}: expected ${candidatePaths.join(" or ")}`);
      continue;
    }
    const result = validateRuntimeFile(existingPath, target, { allowLfsPointer });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  if (!args.platformOnly) {
    return;
  }

  for (const target of targets) {
    if (requestedPlatformIds.has(target.platformId)) {
      continue;
    }
    for (const candidatePath of targetPaths(value, target)) {
      if (fs.existsSync(candidatePath)) {
        errors.push(`unexpected runtime in platform-only payload: ${path.relative(value, candidatePath)}`);
      }
    }
  }
}

function requestedRuntimeTargets() {
  if (args.requireAll) {
    return targets;
  }

  if (!args.platforms.length) {
    return [targetForCurrentPlatform()];
  }

  const result = [];
  for (const platformId of args.platforms) {
    if (platformId === "all") {
      for (const target of targets) {
        result.push(target);
      }
      continue;
    }
    const target = targets.find((candidate) => candidate.platformId === platformId || candidate.legacyPlatformId === platformId);
    if (!target) {
      errors.push(`unknown platform ${platformId}; supported: ${targets.map((item) => item.platformId).join(", ")}`);
      continue;
    }
    result.push(target);
  }
  return dedupeTargets(result);
}

function targetForCurrentPlatform() {
  const current = `${process.platform}-${process.arch}`;
  const target = targets.find((candidate) => candidate.platformId === current);
  if (!target) {
    errors.push(`current platform is unsupported by deploy preflight: ${current}`);
    return targets[0];
  }
  return target;
}

function dedupeTargets(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item.platformId)) {
      continue;
    }
    seen.add(item.platformId);
    result.push(item);
  }
  return result;
}

function walk(dir, visit, rootDir = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    errors.push(`cannot read deploy directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, entryPath) || entry.name;
    const shouldDescend = visit(entryPath, entry, relativePath);
    if (entry.isDirectory() && shouldDescend !== false) {
      walk(entryPath, visit, rootDir);
    }
  }
}

function parseArgs(rawArgs) {
  const result = {
    root: "",
    platforms: [],
    strict: false,
    allowLfsPointer: false,
    requireAll: false,
    platformOnly: false,
    help: false
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--strict") {
      result.strict = true;
      continue;
    }
    if (arg === "--allow-lfs-pointer") {
      result.allowLfsPointer = true;
      continue;
    }
    if (arg === "--require-all") {
      result.requireAll = true;
      continue;
    }
    if (arg === "--platform-only") {
      result.platformOnly = true;
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
    throwUsage(`unknown option: ${arg}`);
  }

  if (result.requireAll && result.platformOnly) {
    throwUsage("--platform-only cannot be combined with --require-all");
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
  console.log(`Usage: node scripts/verify-deploy-payload.js [options]

Options:
  --root <path>             Validate deploy payload root. Defaults to this repo.
  --platform <id>[,<id>]    Require runtime for one or more platform ids. Use "all" for full matrix.
  --platform-only           Fail if runtimes for non-requested platforms are present.
  --require-all             Require runtimes for every supported target.
  --strict                  Treat deploy trash files and Git LFS pointers as errors.
  --allow-lfs-pointer       Treat Git LFS pointer runtime as warning in non-strict dev checks.
  --help                    Show this help.

Examples:
  node scripts/verify-deploy-payload.js --platform win32-x64 --allow-lfs-pointer
  node scripts/verify-deploy-payload.js --root /opt/element/plugins/codex --platform linux-x64 --strict
  node scripts/verify-deploy-payload.js --root ./deploy/codex-plugin --require-all --strict
`);
}

#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
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

const sourceRoot = path.resolve(__dirname, "..");
const targetRoot = path.resolve(args.target || path.resolve(sourceRoot, "..", "codex-plugin-deploy"));
const runtimeRoot = args.runtimeRoot ? path.resolve(args.runtimeRoot) : "";
const browserRuntimeRoot = args.browserRuntimeRoot ? path.resolve(args.browserRuntimeRoot) : "";
const errors = [];
const warnings = [];

main();

function main() {
  validateTargetPath();
  if (runtimeRoot) {
    validateRuntimeRoot();
  }
  if (browserRuntimeRoot) {
    validateBrowserRuntimeRoot();
  }
  if (errors.length) {
    finish();
  }

  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-bin-backup."));
  const backupBin = path.join(backupRoot, "bin");

  try {
    backupExistingBin(backupBin);
    resetTargetRoot();
    copyPayload(sourceRoot, targetRoot);
    overlayPreservedRuntimes(backupBin);
    overlayRuntimeRoot();
    overlayBrowserRuntimeRoot();
    pruneUnrequestedRuntimePlatforms();
    pruneUnrequestedBrowserPlatforms();
    removeInvalidAlternativeRuntimeFiles();
    removeInvalidUnrequestedRuntimeFiles();
    runDeployPreflight();
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }

  finish();
}

function validateTargetPath() {
  if (targetRoot === sourceRoot) {
    errors.push(`target must not equal source root: ${targetRoot}`);
  }
  if (isInside(sourceRoot, targetRoot)) {
    errors.push(`target must not contain source root: ${targetRoot}`);
  }
  if (isInside(targetRoot, sourceRoot)) {
    errors.push(`target must not be inside source root: ${targetRoot}`);
  }
  if (path.parse(targetRoot).root === targetRoot) {
    errors.push(`refusing to stage into filesystem root: ${targetRoot}`);
  }
}

function validateRuntimeRoot() {
  if (!fs.existsSync(runtimeRoot)) {
    errors.push(`runtime root does not exist: ${runtimeRoot}`);
    return;
  }
  if (!fs.statSync(runtimeRoot).isDirectory()) {
    errors.push(`runtime root is not a directory: ${runtimeRoot}`);
  }
}

function validateBrowserRuntimeRoot() {
  if (!fs.existsSync(browserRuntimeRoot)) {
    errors.push(`browser runtime root does not exist: ${browserRuntimeRoot}`);
    return;
  }
  if (!fs.statSync(browserRuntimeRoot).isDirectory()) {
    errors.push(`browser runtime root is not a directory: ${browserRuntimeRoot}`);
  }
}

function backupExistingBin(backupBin) {
  const currentBin = path.join(targetRoot, "bin");
  if (!fs.existsSync(currentBin)) {
    return;
  }
  copyDirectory(currentBin, backupBin);
}

function resetTargetRoot() {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
}

function copyPayload(fromRoot, toRoot) {
  copyDirectory(fromRoot, toRoot, shouldCopyPayloadEntry);
}

function shouldCopyPayloadEntry(relativePath, entry) {
  const name = entry.name;
  // Linked Git worktrees store .git as a file, not a directory.
  if (name === ".git") { return false; }
  if (entry.isDirectory()) {
    if (args.platformOnly && path.dirname(relativePath) === "bin") {
      return requestedRuntimeDirectoryNames().has(name);
    }
    if (args.platformOnly && path.dirname(relativePath) === "browser") {
      return requestedRuntimeDirectoryNames().has(name);
    }
    return ![
      ".git",
      "node_modules",
      ".tmp",
      "coverage"
    ].includes(name);
  }

  if ([
    ".DS_Store",
    "Thumbs.db"
  ].includes(name)) {
    return false;
  }

  const ext = path.extname(name).toLowerCase();
  if ([
    ".log",
    ".tmp",
    ".vsix"
  ].includes(ext)) {
    return false;
  }

  return true;
}

function requestedRuntimeDirectoryNames() {
  const names = new Set();
  for (const target of requestedRuntimeTargets()) {
    names.add(target.platformId);
  }
  return names;
}

function overlayPreservedRuntimes(backupBin) {
  if (!fs.existsSync(backupBin)) {
    return;
  }

  for (const target of targets) {
    const backupPath = targetPaths(path.dirname(backupBin), target).find((candidate) => fs.existsSync(candidate));
    if (!backupPath) {
      continue;
    }
    const backupValidation = validateRuntimeFile(backupPath, target);
    if (backupValidation.errors.length) {
      continue;
    }

    const destinationPath = targetPaths(targetRoot, target)[0];
    const destinationValidation = validateRuntimeFile(destinationPath, target);
    if (destinationValidation.summary.exists && !destinationValidation.errors.length) {
      continue;
    }

    copyFileWithMode(backupPath, destinationPath);
    warnings.push(`preserved existing valid runtime for ${target.platformId}: ${destinationPath}`);
  }
}

function overlayRuntimeRoot() {
  if (!runtimeRoot) {
    return;
  }

  for (const target of requestedRuntimeTargets()) {
    const sourcePath = targetPaths(runtimeRoot, target).find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      warnings.push(`runtime root has no binary for ${target.platformId}: expected ${targetPaths(runtimeRoot, target).join(" or ")}`);
      continue;
    }
    const validation = validateRuntimeFile(sourcePath, target);
    if (validation.errors.length) {
      errors.push(...validation.errors.map((error) => `runtime root ${error}`));
      continue;
    }
    const destinationPath = targetPaths(targetRoot, target)[0];
    copyFileWithMode(sourcePath, destinationPath);
  }
}

function overlayBrowserRuntimeRoot() {
  if (!browserRuntimeRoot) {
    return;
  }

  for (const target of requestedRuntimeTargets()) {
    const sourcePath = path.join(browserRuntimeRoot, "browser", target.platformId);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      errors.push(`browser runtime root has no payload for ${target.platformId}: ${sourcePath}`);
      continue;
    }
    const destinationPath = path.join(targetRoot, "browser", target.platformId);
    fs.rmSync(destinationPath, { recursive: true, force: true });
    copyDirectory(sourcePath, destinationPath);
  }
}

function removeInvalidAlternativeRuntimeFiles() {
  for (const target of targets) {
    const canonicalPath = targetPaths(targetRoot, target)[0];
    const canonicalValidation = validateRuntimeFile(canonicalPath, target);
    if (!canonicalValidation.summary.exists || canonicalValidation.errors.length) {
      continue;
    }

    for (const candidatePath of targetPaths(targetRoot, target).slice(1)) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }
      const validation = validateRuntimeFile(candidatePath, target);
      if (!validation.errors.length) {
        continue;
      }
      fs.rmSync(candidatePath, { force: true });
      warnings.push(`removed invalid alternative runtime for ${target.platformId}: ${candidatePath}`);
    }
  }
}

function pruneUnrequestedRuntimePlatforms() {
  if (!args.platformOnly) {
    return;
  }

  const requested = new Set(requestedRuntimeTargets().map((target) => target.platformId));
  for (const target of targets) {
    if (requested.has(target.platformId)) {
      if (target.legacyPlatformId) {
        const legacyDirectory = path.dirname(targetPaths(targetRoot, target)[1]);
        if (fs.existsSync(legacyDirectory)) {
          fs.rmSync(legacyDirectory, { recursive: true, force: true });
          warnings.push(`removed legacy runtime directory from platform-only payload: ${legacyDirectory}`);
        }
      }
      continue;
    }
    for (const candidatePath of targetPaths(targetRoot, target)) {
      const platformDirectory = path.dirname(candidatePath);
      if (!fs.existsSync(platformDirectory)) {
        continue;
      }
      fs.rmSync(platformDirectory, { recursive: true, force: true });
      warnings.push(`removed unrequested runtime platform ${target.platformId}: ${platformDirectory}`);
    }
  }
}

function pruneUnrequestedBrowserPlatforms() {
  if (!args.platformOnly) {
    return;
  }
  const browserRoot = path.join(targetRoot, "browser");
  if (!fs.existsSync(browserRoot)) {
    return;
  }
  const requested = new Set(requestedRuntimeTargets().map((target) => target.platformId));
  for (const entry of fs.readdirSync(browserRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || requested.has(entry.name)) {
      continue;
    }
    const platformDirectory = path.join(browserRoot, entry.name);
    fs.rmSync(platformDirectory, { recursive: true, force: true });
    warnings.push(`removed unrequested browser runtime platform ${entry.name}: ${platformDirectory}`);
  }
}

function removeInvalidUnrequestedRuntimeFiles() {
  const requested = new Set(requestedRuntimeTargets().map((target) => target.platformId));
  for (const target of targets) {
    if (requested.has(target.platformId)) {
      continue;
    }
    for (const candidatePath of targetPaths(targetRoot, target)) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }
      const validation = validateRuntimeFile(candidatePath, target, { allowLfsPointer: false });
      if (!validation.errors.length) {
        continue;
      }
      fs.rmSync(candidatePath, { force: true });
      warnings.push(`removed invalid unrequested runtime for ${target.platformId}: ${candidatePath}`);
    }
  }
}

function runDeployPreflight() {
  const preflightArgs = [
    path.join(sourceRoot, "scripts", "verify-deploy-payload.js"),
    "--root",
    targetRoot
  ];

  if (args.requireAll) {
    preflightArgs.push("--require-all");
  } else {
    for (const platformId of args.platforms) {
      preflightArgs.push("--platform", platformId);
    }
  }

  if (args.strict) {
    preflightArgs.push("--strict");
  }
  if (args.allowLfsPointer) {
    preflightArgs.push("--allow-lfs-pointer");
  }
  if (args.platformOnly) {
    preflightArgs.push("--platform-only");
  }
  if (browserRuntimeRoot) {
    preflightArgs.push("--require-browser");
  }

  const result = childProcess.spawnSync(process.execPath, preflightArgs, {
    cwd: sourceRoot,
    encoding: "utf8"
  });

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.error) {
    errors.push(`deploy preflight failed to start: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    errors.push(`deploy preflight failed with code ${result.status}`);
  }
}

function requestedRuntimeTargets() {
  if (args.requireAll) {
    return targets;
  }
  const result = [];
  for (const platformId of args.platforms) {
    const target = targets.find((candidate) => candidate.platformId === platformId || candidate.legacyPlatformId === platformId);
    if (!target) {
      errors.push(`unknown platform ${platformId}; supported: ${targets.map((item) => item.platformId).join(", ")}`);
      continue;
    }
    if (!result.some((item) => item.platformId === target.platformId)) {
      result.push(target);
    }
  }
  return result;
}

function copyDirectory(fromRoot, toRoot, filter = () => true) {
  fs.mkdirSync(toRoot, { recursive: true });
  const entries = fs.readdirSync(fromRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(fromRoot, entry.name);
    const destinationPath = path.join(toRoot, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (!filter(relativePath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, filter);
      continue;
    }
    if (entry.isFile()) {
      copyFileWithMode(sourcePath, destinationPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(sourcePath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.symlinkSync(linkTarget, destinationPath);
    }
  }
}

function copyFileWithMode(sourcePath, destinationPath) {
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, stat.mode & 0o777);
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(rawArgs) {
  const result = {
    target: "",
    runtimeRoot: "",
    browserRuntimeRoot: "",
    platforms: ["win32-x64"],
    requireAll: false,
    platformOnly: false,
    strict: false,
    allowLfsPointer: false,
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
      result.platforms = [];
      continue;
    }
    if (arg === "--platform-only") {
      result.platformOnly = true;
      continue;
    }
    if (arg === "--target") {
      const value = readValue(rawArgs, index, "--target");
      result.target = value.value;
      index = value.index;
      continue;
    }
    if (arg.startsWith("--target=")) {
      result.target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--runtime-root") {
      const value = readValue(rawArgs, index, "--runtime-root");
      result.runtimeRoot = value.value;
      index = value.index;
      continue;
    }
    if (arg.startsWith("--runtime-root=")) {
      result.runtimeRoot = arg.slice("--runtime-root=".length);
      continue;
    }
    if (arg === "--browser-runtime-root") {
      const value = readValue(rawArgs, index, "--browser-runtime-root");
      result.browserRuntimeRoot = value.value;
      index = value.index;
      continue;
    }
    if (arg.startsWith("--browser-runtime-root=")) {
      result.browserRuntimeRoot = arg.slice("--browser-runtime-root=".length);
      continue;
    }
    if (arg === "--platform") {
      const value = readValue(rawArgs, index, "--platform");
      result.platforms = splitPlatformList(value.value);
      index = value.index;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      result.platforms = splitPlatformList(arg.slice("--platform=".length));
      continue;
    }
    throwUsage(`unknown option: ${arg}`);
  }

  if (result.requireAll && result.platformOnly) {
    throwUsage("--platform-only cannot be combined with --require-all");
  }

  return result;
}

function readValue(rawArgs, index, optionName) {
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) {
    throwUsage(`${optionName} requires a value`);
  }
  return { value, index: index + 1 };
}

function splitPlatformList(value) {
  const platforms = value.split(",").map((item) => item.trim()).filter(Boolean);
  return platforms.length ? platforms : ["win32-x64"];
}

function throwUsage(message) {
  console.error(`ERROR ${message}`);
  printHelp();
  process.exit(1);
}

function finish() {
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
  console.log(`Deploy payload staged: ${targetRoot}`);
}

function printHelp() {
  console.log(`Usage: node scripts/stage-deploy-payload.js [options]

Options:
  --target <path>           Output deploy payload directory. Defaults to ../codex-plugin-deploy.
  --platform <id>[,<id>]    Runtime platforms to validate and optionally overlay. Defaults to win32-x64.
  --platform-only           Remove every runtime platform not requested by --platform.
  --require-all             Validate and optionally overlay every supported runtime target.
  --runtime-root <path>     Optional root with real runtime binaries in bin-compatible layout.
  --browser-runtime-root <path>
                            Optional root with browser/<platform> managed Playwright payloads.
  --strict                  Fail on deploy trash files and Git LFS pointers.
  --allow-lfs-pointer       Allow Git LFS pointer runtime as warning for dev staging.
  --help                    Show this help.

Examples:
  node scripts/stage-deploy-payload.js --allow-lfs-pointer
  node scripts/stage-deploy-payload.js --target ../release/win32-x64/codex-plugins --platform win32-x64 --platform-only --strict
  node scripts/stage-deploy-payload.js --target ../codex-plugin-deploy --platform win32-x64 --strict --runtime-root /secure/runtime
  node scripts/stage-deploy-payload.js --target ../codex-plugin-deploy --require-all --strict --runtime-root /secure/runtime
`);
}

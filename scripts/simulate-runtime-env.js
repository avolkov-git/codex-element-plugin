#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveRuntime,
  targets,
  validateRuntimeFile
} = require("./runtime-preflight-lib");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, "..");
const pluginRoot = path.resolve(args.pluginRoot || repoRoot);
const platformId = args.platform || `${process.platform}-${process.arch}`;
const target = targets.find((candidate) => candidate.platformId === platformId || candidate.legacyPlatformId === platformId);
const env = buildSimulatedEnv(args);
const report = buildReport();

printReport(report, args.json);
if (report.errors.length) {
  process.exit(1);
}

function buildReport() {
  const errors = [];
  const warnings = [];
  if (!target) {
    errors.push(`Unsupported platform: ${platformId}. Supported: ${targets.map((item) => item.platformId).join(", ")}`);
  }

  const runtime = target
    ? resolveAndValidateRuntime(pluginRoot, platformId, errors, warnings)
    : undefined;
  const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());
  const globalStorageRoot = path.resolve(args.globalStorageRoot || path.join(workspaceRoot, ".settings", "globalStorage", "element-ai.codex-element-v1"));
  const config = resolveConfigRootForSimulation(platformId, env, args, globalStorageRoot);
  const codexHome = path.join(config.selectedPath, "users", args.profileId, "codex-home");
  const runtimeCwd = resolveRuntimeCwd(workspaceRoot, codexHome, globalStorageRoot);
  const toolEnv = buildRipgrepEnvPatch(platformId, env, args.rgPath, warnings);
  const normalEnv = buildRuntimeEnv(platformId, env, codexHome, toolEnv.env);
  const minimalEnv = buildMinimalRuntimeEnv(platformId, env, codexHome, toolEnv.env);

  checkPluginRoot(pluginRoot, errors, warnings);
  if (runtime?.selectedPath) {
    checkPathStatus("runtime binary directory", path.dirname(runtime.selectedPath), { requireReadable: true, requireExecutable: true }, errors, warnings);
  }
  checkWorkspaceRoot(workspaceRoot, warnings);
  checkPathStatus("configRoot", config.selectedPath, { requireWritable: true }, errors, warnings);
  checkPathStatus("codexHome parent", path.dirname(codexHome), { requireWritable: true }, errors, warnings);
  checkPathStatus("runtime cwd", runtimeCwd, { requireReadable: true }, errors, warnings);
  if (target?.platformId.startsWith("linux") || target?.platformId.startsWith("darwin")) {
    checkUnixServiceUserAssumptions(config.selectedPath, runtimeCwd, env, warnings);
  }
  if (!normalEnv.PATH && !normalEnv.Path) {
    warnings.push("runtime PATH is empty; shell commands may fail unless Codex uses absolute paths.");
  }
  if (!platformId.startsWith("win32") && isInside(config.selectedPath, pluginRoot)) {
    warnings.push(`config root is inside plugin root; production /plugins may be read-only: ${config.selectedPath}`);
  }

  return {
    ok: errors.length === 0,
    platformId,
    pluginRoot,
    serviceUser: args.serviceUser,
    runtime,
    config,
    workspaceRoot,
    globalStorageRoot,
    codexHome,
    runtimeCwd,
    env: summarizeEnv(normalEnv),
    minimalEnv: summarizeEnv(minimalEnv),
    ripgrep: toolEnv.summary,
    errors,
    warnings
  };
}

function resolveAndValidateRuntime(root, id, errors, warnings) {
  const resolution = resolveRuntime(root, id);
  const validation = resolution.target
    ? validateRuntimeFile(resolution.selectedPath, resolution.target, { required: true, allowLfsPointer: args.allowLfsPointer })
    : { errors: [], warnings: [], summary: undefined };
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);
  return {
    platformId: resolution.target?.platformId || id,
    executableName: resolution.target?.executableName || "",
    selectedPath: resolution.selectedPath,
    candidates: resolution.candidates,
    legacy: resolution.legacy,
    summary: validation.summary
  };
}

function buildSimulatedEnv(options) {
  if (options.emptyEnv) {
    return {};
  }
  if (options.serviceUser) {
    const key = pathEnvKey(options.platform || `${process.platform}-${process.arch}`, process.env);
    return {
      [key]: process.env[key] || process.env.PATH || "",
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || ""
    };
  }
  return { ...process.env };
}

function resolveConfigRootForSimulation(id, simulatedEnv, options, globalStorageRoot) {
  if (options.configRoot) {
    return {
      selectedPath: path.resolve(options.configRoot),
      reason: "explicit --config-root",
      candidates: [{ path: path.resolve(options.configRoot), status: pathStatus(path.resolve(options.configRoot)) }]
    };
  }

  if (id.startsWith("win32")) {
    const programData = simulatedEnv.PROGRAMDATA || simulatedEnv.ProgramData || "C:\\ProgramData";
    const candidate = path.join(programData, "CodexElement");
    return {
      selectedPath: candidate,
      reason: "windows ProgramData default",
      candidates: [{ path: candidate, status: pathStatus(candidate) }]
    };
  }

  const home = simulatedEnv.HOME || "";
  const candidates = [
    simulatedEnv.CODEX_ELEMENT_CONFIG_ROOT || "",
    simulatedEnv.XDG_STATE_HOME ? path.join(simulatedEnv.XDG_STATE_HOME, "codex-element") : "",
    home ? path.join(home, ".local", "state", "codex-element") : "",
    simulatedEnv.XDG_DATA_HOME ? path.join(simulatedEnv.XDG_DATA_HOME, "codex-element") : "",
    home ? path.join(home, ".local", "share", "codex-element") : "",
    home ? path.join(home, ".codex-element") : "",
    path.join(globalStorageRoot, "codex-element")
  ].filter(Boolean);
  const details = candidates.map((candidate) => ({ path: path.resolve(candidate), status: pathStatus(path.resolve(candidate)) }));
  const selected = details.find((candidate) => candidate.status.writable || candidate.status.parentWritable) || details[details.length - 1];
  return {
    selectedPath: selected?.path || path.join(globalStorageRoot, "codex-element"),
    reason: selected?.status.writable ? "first writable config candidate" : "fallback to global storage",
    candidates: details
  };
}

function resolveRuntimeCwd(workspaceRoot, codexHome, globalStorageRoot) {
  if (args.forceSafeCwd) {
    return globalStorageRoot;
  }
  const workspace = pathStatus(workspaceRoot);
  if (workspace.exists && workspace.readable) {
    return workspaceRoot;
  }
  const codex = pathStatus(codexHome);
  if (codex.exists && codex.readable) {
    return codexHome;
  }
  return globalStorageRoot;
}

function buildRuntimeEnv(id, baseEnv, codexHome, toolEnv) {
  const env = { ...baseEnv, ...toolEnv };
  env.CODEX_HOME = codexHome;
  ensureUnixRuntimeHomeEnv(id, env, codexHome);
  normalizePathEnv(id, env);
  return env;
}

function buildMinimalRuntimeEnv(id, baseEnv, codexHome, toolEnv) {
  const env = {};
  for (const key of minimalRuntimeEnvKeys(id)) {
    if (baseEnv[key]) {
      env[key] = baseEnv[key];
    }
  }
  env.CODEX_HOME = codexHome;
  env[pathEnvKey(id, env)] = minimalRuntimePathValue(id, baseEnv);
  Object.assign(env, toolEnv);
  ensureUnixRuntimeHomeEnv(id, env, codexHome);
  normalizePathEnv(id, env);
  return env;
}

function ensureUnixRuntimeHomeEnv(id, env, codexHome) {
  if (id.startsWith("win32")) {
    return;
  }
  if (!env.HOME) {
    env.HOME = codexHome;
  }
  if (!env.XDG_CONFIG_HOME) {
    env.XDG_CONFIG_HOME = path.join(codexHome, "xdg-config");
  }
  if (!env.XDG_CACHE_HOME) {
    env.XDG_CACHE_HOME = path.join(codexHome, "xdg-cache");
  }
  if (!env.XDG_DATA_HOME) {
    env.XDG_DATA_HOME = path.join(codexHome, "xdg-data");
  }
}

function normalizePathEnv(id, env) {
  if (!id.startsWith("win32")) {
    return;
  }
  const value = env.Path || env.PATH;
  delete env.Path;
  delete env.PATH;
  if (value) {
    env.Path = value;
  }
}

function buildRipgrepEnvPatch(id, baseEnv, ripgrepPath, warnings) {
  if (!ripgrepPath) {
    return { env: {}, summary: { configured: false, path: "", warning: "" } };
  }
  const executable = resolveRipgrepExecutablePath(id, ripgrepPath);
  if (!executable) {
    const warning = "Configured rg path is not a file or does not contain rg executable.";
    warnings.push(warning);
    return { env: {}, summary: { configured: true, path: ripgrepPath, warning } };
  }

  const dir = path.dirname(executable);
  const key = pathEnvKey(id, baseEnv);
  const currentPath = baseEnv[key] || baseEnv.PATH || baseEnv.Path || "";
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  const alreadyPresent = entries.some((entry) => normalizePathForCompare(id, entry) === normalizePathForCompare(id, dir));
  const env = { RIPGREP_PATH: executable };
  if (!alreadyPresent) {
    env[key] = [dir, ...entries].join(path.delimiter);
  }
  return { env, summary: { configured: true, path: executable, pathPatched: !alreadyPresent, warning: "" } };
}

function resolveRipgrepExecutablePath(id, input) {
  const normalized = path.resolve(input);
  const executableName = id.startsWith("win32") ? "rg.exe" : "rg";
  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
      const executable = path.join(normalized, executableName);
      return fs.statSync(executable).isFile() ? executable : "";
    }
    return stat.isFile() ? normalized : "";
  } catch {
    return "";
  }
}

function minimalRuntimeEnvKeys(id) {
  if (!id.startsWith("win32")) {
    return ["HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  }
  return [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "USERNAME",
    "USERDOMAIN"
  ];
}

function minimalRuntimePathValue(id, baseEnv) {
  if (!id.startsWith("win32")) {
    return baseEnv.PATH || "/usr/local/bin:/usr/bin:/bin";
  }
  const windowsRoot = baseEnv.SystemRoot || baseEnv.WINDIR || "C:\\Windows";
  return [
    path.join(windowsRoot, "System32"),
    windowsRoot,
    path.join(windowsRoot, "System32", "Wbem"),
    path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")
  ].join(path.delimiter);
}

function checkPluginRoot(root, errors, warnings) {
  const status = pathStatus(root);
  if (!status.exists || !status.isDirectory) {
    errors.push(`plugin root is not a readable directory: ${root}`);
    return;
  }
  if (!status.readable) {
    errors.push(`plugin root is not readable by current user: ${root}`);
  }
  if (!status.executable) {
    warnings.push(`plugin root is not searchable/executable by current user: ${root}`);
  }
}

function checkWorkspaceRoot(root, warnings) {
  const status = pathStatus(root);
  if (!status.exists) {
    warnings.push(`workspace root does not exist in dry-run environment: ${root}`);
    return;
  }
  if (!status.readable) {
    warnings.push(`workspace root is not readable by current user: ${root}`);
  }
}

function checkPathStatus(label, value, options, errors, warnings) {
  const status = pathStatus(value);
  if (options.requireReadable && status.exists && !status.readable) {
    warnings.push(`${label} is not readable: ${value}`);
  }
  if (options.requireExecutable && status.exists && !status.executable) {
    warnings.push(`${label} is not searchable/executable: ${value}`);
  }
  if (options.requireWritable && !status.writable && !status.parentWritable) {
    errors.push(`${label} is not writable and nearest existing parent is not writable: ${value}`);
  }
}

function checkUnixServiceUserAssumptions(configRoot, cwd, simulatedEnv, warnings) {
  if (!args.serviceUser) {
    return;
  }
  if (simulatedEnv.HOME) {
    warnings.push("service-user simulation still has HOME; use --empty-env to test missing HOME fallback.");
  }
  if (configRoot.startsWith("/usr/") || configRoot.startsWith("/opt/") || configRoot.startsWith("/etc/")) {
    warnings.push(`config root is under a likely system-owned path: ${configRoot}`);
  }
  if (cwd.startsWith("/usr/") || cwd.startsWith("/opt/") || cwd.startsWith("/etc/")) {
    warnings.push(`runtime cwd is under a likely system-owned path: ${cwd}`);
  }
}

function pathStatus(value) {
  const resolved = path.resolve(value);
  try {
    const stat = fs.statSync(resolved);
    return {
      path: resolved,
      exists: true,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      readable: canAccess(resolved, fs.constants.R_OK),
      writable: canAccess(resolved, fs.constants.W_OK),
      executable: canAccess(resolved, fs.constants.X_OK),
      parent: path.dirname(resolved),
      parentWritable: canAccess(path.dirname(resolved), fs.constants.W_OK)
    };
  } catch {
    const parent = nearestExistingParent(resolved);
    return {
      path: resolved,
      exists: false,
      isDirectory: false,
      isFile: false,
      mode: "-",
      readable: false,
      writable: false,
      executable: false,
      parent,
      parentWritable: parent ? canAccess(parent, fs.constants.W_OK) : false
    };
  }
}

function canAccess(value, mode) {
  try {
    fs.accessSync(value, mode);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingParent(value) {
  let current = path.resolve(value);
  while (current && current !== path.dirname(current)) {
    current = path.dirname(current);
    if (fs.existsSync(current)) {
      return current;
    }
  }
  return fs.existsSync(current) ? current : "";
}

function pathEnvKey(id, env) {
  if (!id.startsWith("win32")) {
    return "PATH";
  }
  return Object.prototype.hasOwnProperty.call(env, "Path") ? "Path" : "PATH";
}

function normalizePathForCompare(id, value) {
  const resolved = path.resolve(value);
  return id.startsWith("win32") ? resolved.toLowerCase() : resolved;
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function summarizeEnv(runtimeEnv) {
  const key = runtimeEnv.Path ? "Path" : "PATH";
  const pathValue = runtimeEnv[key] || "";
  return {
    keys: Object.keys(runtimeEnv).length,
    pathKey: key,
    pathLength: pathValue.length,
    codexHome: runtimeEnv.CODEX_HOME || "",
    home: runtimeEnv.HOME || "",
    xdgConfigHome: runtimeEnv.XDG_CONFIG_HOME || "",
    xdgCacheHome: runtimeEnv.XDG_CACHE_HOME || "",
    xdgDataHome: runtimeEnv.XDG_DATA_HOME || "",
    ripgrepPath: runtimeEnv.RIPGREP_PATH || ""
  };
}

function parseArgs(rawArgs) {
  const result = {
    platform: "",
    pluginRoot: "",
    workspaceRoot: "",
    configRoot: "",
    globalStorageRoot: "",
    profileId: "dry-run-profile",
    rgPath: "",
    serviceUser: false,
    emptyEnv: false,
    forceSafeCwd: false,
    allowLfsPointer: false,
    json: false,
    help: false
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--service-user") {
      result.serviceUser = true;
      continue;
    }
    if (arg === "--empty-env") {
      result.emptyEnv = true;
      continue;
    }
    if (arg === "--force-safe-cwd") {
      result.forceSafeCwd = true;
      continue;
    }
    if (arg === "--allow-lfs-pointer") {
      result.allowLfsPointer = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    const valueArg = readValueArg(rawArgs, index);
    if (valueArg) {
      result[valueArg.key] = valueArg.value;
      index = valueArg.nextIndex;
      continue;
    }
    throwUsage(`unknown option: ${arg}`);
  }

  return result;
}

function readValueArg(rawArgs, index) {
  const optionMap = {
    "--platform": "platform",
    "--plugin-root": "pluginRoot",
    "--workspace-root": "workspaceRoot",
    "--config-root": "configRoot",
    "--global-storage-root": "globalStorageRoot",
    "--profile-id": "profileId",
    "--rg-path": "rgPath"
  };
  const arg = rawArgs[index];
  for (const [option, key] of Object.entries(optionMap)) {
    if (arg === option) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throwUsage(`${option} requires a value`);
      }
      return { key, value, nextIndex: index + 1 };
    }
    if (arg.startsWith(`${option}=`)) {
      return { key, value: arg.slice(option.length + 1), nextIndex: index };
    }
  }
  return undefined;
}

function throwUsage(message) {
  console.error(`ERROR ${message}`);
  printHelp();
  process.exit(1);
}

function printReport(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(`Codex runtime dry-run: ${value.ok ? "PASS" : "FAIL"}`);
  console.log(`platform=${value.platformId}`);
  console.log(`pluginRoot=${value.pluginRoot}`);
  console.log(`runtime=${value.runtime?.selectedPath || "-"}`);
  console.log(`runtimeKind=${value.runtime?.summary?.kind || "-"} arch=${value.runtime?.summary?.arch || "-"} executable=${value.runtime?.summary?.executable ? "yes" : "no"}`);
  console.log(`configRoot=${value.config.selectedPath} (${value.config.reason})`);
  console.log(`codexHome=${value.codexHome}`);
  console.log(`workspaceRoot=${value.workspaceRoot}`);
  console.log(`runtimeCwd=${value.runtimeCwd}`);
  console.log(`envKeys=${value.env.keys} pathKey=${value.env.pathKey} pathLength=${value.env.pathLength}`);
  console.log(`HOME=${value.env.home || "-"}`);
  console.log(`XDG_CONFIG_HOME=${value.env.xdgConfigHome || "-"}`);
  console.log(`rg=${value.ripgrep.path || "-"}${value.ripgrep.pathPatched ? " (PATH patched)" : ""}`);
  for (const warning of value.warnings) {
    console.warn(`WARN ${warning}`);
  }
  for (const error of value.errors) {
    console.error(`ERROR ${error}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/simulate-runtime-env.js [options]

Options:
  --platform <id>              Target platform id. Defaults to current Node platform.
  --plugin-root <path>         Plugin root to inspect. Defaults to this repo.
  --workspace-root <path>      Workspace root used as normal runtime cwd.
  --config-root <path>         Explicit Codex Element config root.
  --global-storage-root <path> Simulated extension globalStorage root.
  --profile-id <id>            Profile id for CODEX_HOME simulation.
  --rg-path <path>             Optional rg executable or directory.
  --service-user               Simulate restricted service-user assumptions.
  --empty-env                  Start from an empty environment.
  --force-safe-cwd             Simulate minimal-env fallback cwd.
  --allow-lfs-pointer          Report Git LFS pointer as warning.
  --json                       Print machine-readable JSON.
  --help                       Show this help.

Examples:
  node scripts/simulate-runtime-env.js --platform linux-x64 --service-user --empty-env --allow-lfs-pointer
  node scripts/simulate-runtime-env.js --platform linux-x64 --plugin-root /opt/element/plugins/codex --config-root /var/lib/codex-element
  node scripts/simulate-runtime-env.js --platform darwin-arm64 --workspace-root /tmp/workspace --json
`);
}

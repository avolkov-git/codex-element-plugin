#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
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
const currentPlatformId = `${process.platform}-${process.arch}`;
const target = targets.find((candidate) => candidate.platformId === platformId || candidate.legacyPlatformId === platformId);
const report = buildReport();

printReport(report, args.json);
process.exit(report.errors.length ? 1 : 0);

function buildReport() {
  const errors = [];
  const warnings = [];
  if (!target) {
    errors.push(`Unsupported platform: ${platformId}. Supported: ${targets.map((item) => item.platformId).join(", ")}`);
  }
  if (target && !target.platformId.startsWith("linux") && !target.platformId.startsWith("darwin")) {
    errors.push(`Unix smoke check supports only linux-* and darwin-* targets, got ${target.platformId}.`);
  }

  const runtime = target ? resolveAndValidateRuntime(errors, warnings) : undefined;
  const workspaceRoot = path.resolve(args.workspaceRoot || process.cwd());
  const globalStorageRoot = path.resolve(args.globalStorageRoot || path.join(workspaceRoot, ".settings", "globalStorage", "element-ai.codex-element-v1"));
  const configRoot = resolveConfigRoot(workspaceRoot, globalStorageRoot);
  const codexHome = path.join(configRoot.selectedPath, "users", args.profileId, "codex-home");
  const runtimeCwd = resolveRuntimeCwd(workspaceRoot, codexHome, globalStorageRoot);
  const runtimeEnv = buildRuntimeEnv(codexHome, args.rgPath, warnings);
  const versionProbe = probeRuntimeVersion(runtime?.selectedPath || "", runtimeEnv, errors, warnings);
  const rgProbe = probeRipgrep(args.rgPath, runtimeEnv, warnings);

  checkPluginRoot(pluginRoot, errors, warnings);
  if (runtime?.selectedPath) {
    checkPathStatus("runtime binary directory", path.dirname(runtime.selectedPath), { requireReadable: true, requireExecutable: true }, errors, warnings);
  }
  checkWorkspaceRoot(workspaceRoot, warnings);
  checkPathStatus("configRoot", configRoot.selectedPath, { requireWritable: true }, errors, warnings);
  checkPathStatus("codexHome parent", path.dirname(codexHome), { requireWritable: true }, errors, warnings);
  checkPathStatus("runtime cwd", runtimeCwd, { requireReadable: true, requireExecutable: true }, errors, warnings);
  checkRiskyUnixPaths(configRoot.selectedPath, runtimeCwd, warnings);

  return {
    ok: errors.length === 0,
    platformId: target?.platformId || platformId,
    currentPlatformId,
    pluginRoot,
    runtime,
    runtimeVersion: versionProbe,
    configRoot,
    codexHome,
    workspaceRoot,
    globalStorageRoot,
    runtimeCwd,
    env: summarizeEnv(runtimeEnv),
    ripgrep: rgProbe,
    errors,
    warnings
  };
}

function resolveAndValidateRuntime(errors, warnings) {
  const resolution = resolveRuntime(pluginRoot, platformId);
  const validation = resolution.target
    ? validateRuntimeFile(resolution.selectedPath, resolution.target, { required: true })
    : { errors: [], warnings: [], summary: undefined };
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);
  return {
    platformId: resolution.target?.platformId || platformId,
    selectedPath: resolution.selectedPath,
    candidates: resolution.candidates,
    legacy: resolution.legacy,
    summary: validation.summary
  };
}

function resolveConfigRoot(workspaceRoot, globalStorageRoot) {
  if (args.configRoot) {
    const selectedPath = path.resolve(args.configRoot);
    return {
      selectedPath,
      reason: "explicit --config-root",
      candidates: [{ path: selectedPath, status: pathStatus(selectedPath) }]
    };
  }

  const envRoot = process.env.CODEX_ELEMENT_CONFIG_ROOT || "";
  const home = process.env.HOME || "";
  const candidates = [
    envRoot,
    process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "codex-element") : "",
    home ? path.join(home, ".local", "state", "codex-element") : "",
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "codex-element") : "",
    home ? path.join(home, ".local", "share", "codex-element") : "",
    home ? path.join(home, ".codex-element") : "",
    path.join(globalStorageRoot, "codex-element")
  ].filter(Boolean);
  const details = candidates.map((candidate) => ({ path: path.resolve(candidate), status: pathStatus(path.resolve(candidate)) }));
  const selected = details.find((candidate) => candidate.status.writable || candidate.status.parentWritable) || details[details.length - 1];
  return {
    selectedPath: selected?.path || path.join(workspaceRoot, ".codex-element"),
    reason: selected?.status.writable ? "first writable config candidate" : "fallback candidate",
    candidates: details
  };
}

function resolveRuntimeCwd(workspaceRoot, codexHome, globalStorageRoot) {
  const workspace = pathStatus(workspaceRoot);
  if (workspace.exists && workspace.isDirectory && workspace.readable && workspace.executable) {
    return workspaceRoot;
  }
  const codex = pathStatus(codexHome);
  if (codex.exists && codex.isDirectory && codex.readable && codex.executable) {
    return codexHome;
  }
  return globalStorageRoot;
}

function buildRuntimeEnv(codexHome, rgPath, warnings) {
  const env = { ...process.env, CODEX_HOME: codexHome };
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
  if (!env.PATH) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin";
  }

  const rgExecutable = resolveRipgrepExecutablePath(rgPath);
  if (rgPath && !rgExecutable) {
    warnings.push(`configured rg path is not usable: ${rgPath}`);
  }
  if (rgExecutable) {
    env.RIPGREP_PATH = rgExecutable;
    env.PATH = uniquePathEntries([path.dirname(rgExecutable), env.PATH]).join(path.delimiter);
  }
  return env;
}

function probeRuntimeVersion(runtimePath, env, errors, warnings) {
  if (!runtimePath) {
    return { status: "skipped", reason: "runtime path is unavailable", stdout: "", stderr: "", exitCode: null, signal: "" };
  }
  if (args.skipVersionProbe) {
    return { status: "skipped", reason: "--skip-version-probe", stdout: "", stderr: "", exitCode: null, signal: "" };
  }
  if (!args.forceVersionProbe && currentPlatformId !== (target?.platformId || platformId)) {
    warnings.push(`runtime version probe skipped because current Node platform is ${currentPlatformId}, target is ${target?.platformId || platformId}. Run this script on the target host to execute the binary.`);
    return { status: "skipped", reason: "current platform differs from target", stdout: "", stderr: "", exitCode: null, signal: "" };
  }

  const result = childProcess.spawnSync(runtimePath, ["--version"], {
    cwd: path.dirname(runtimePath),
    env,
    encoding: "utf8",
    timeout: args.timeoutMs,
    windowsHide: true
  });
  const stdout = truncate((result.stdout || "").trim(), 1000);
  const stderr = truncate((result.stderr || "").trim(), 1000);
  if (result.error) {
    errors.push(`runtime --version failed to start: ${result.error.message}`);
    return { status: "error", reason: result.error.message, stdout, stderr, exitCode: result.status, signal: result.signal || "" };
  }
  if (result.status !== 0) {
    errors.push(`runtime --version exited with code ${result.status}; stderr=${stderr || "-"}`);
    return { status: "error", reason: `exit ${result.status}`, stdout, stderr, exitCode: result.status, signal: result.signal || "" };
  }
  return { status: "ok", reason: "", stdout, stderr, exitCode: result.status, signal: result.signal || "" };
}

function probeRipgrep(rgPath, env, warnings) {
  const executable = resolveRipgrepExecutablePath(rgPath) || findExecutableInPath("rg", env.PATH || "");
  if (!executable) {
    warnings.push("rg was not found. Codex can run, but project searches may be slower or fallback to shell-specific commands.");
    return { status: "missing", path: "", version: "", error: "" };
  }
  const result = childProcess.spawnSync(executable, ["--version"], {
    cwd: pluginRoot,
    env,
    encoding: "utf8",
    timeout: args.timeoutMs,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const error = result.error?.message || `exit ${result.status}: ${truncate((result.stderr || "").trim(), 500)}`;
    warnings.push(`rg probe failed: ${error}`);
    return { status: "error", path: executable, version: "", error };
  }
  return {
    status: "ok",
    path: executable,
    version: firstLine(result.stdout || ""),
    error: ""
  };
}

function resolveRipgrepExecutablePath(input) {
  if (!input) {
    return "";
  }
  const normalized = path.resolve(input);
  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
      const executable = path.join(normalized, "rg");
      return fs.statSync(executable).isFile() ? executable : "";
    }
    return stat.isFile() ? normalized : "";
  } catch {
    return "";
  }
}

function findExecutableInPath(name, pathValue) {
  for (const entry of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && canAccess(candidate, fs.constants.X_OK)) {
        return candidate;
      }
    } catch {
      // Ignore broken PATH entries.
    }
  }
  return "";
}

function checkPluginRoot(root, errors, warnings) {
  const status = pathStatus(root);
  if (!status.exists || !status.isDirectory) {
    errors.push(`plugin root is not a directory: ${root}`);
    return;
  }
  if (!status.readable) {
    errors.push(`plugin root is not readable: ${root}`);
  }
  if (!status.executable) {
    errors.push(`plugin root is not searchable/executable: ${root}`);
  }
  if (status.writable) {
    warnings.push(`plugin root is writable by the service user. This is acceptable for staging, but production /plugins is usually read-only: ${root}`);
  }
}

function checkWorkspaceRoot(root, warnings) {
  const status = pathStatus(root);
  if (!status.exists) {
    warnings.push(`workspace root does not exist: ${root}`);
    return;
  }
  if (!status.readable) {
    warnings.push(`workspace root is not readable: ${root}`);
  }
  if (!status.executable) {
    warnings.push(`workspace root is not searchable/executable: ${root}`);
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

function checkRiskyUnixPaths(configRoot, runtimeCwd, warnings) {
  for (const [label, value] of [["config root", configRoot], ["runtime cwd", runtimeCwd]]) {
    if (value.startsWith("/usr/") || value.startsWith("/opt/") || value.startsWith("/etc/")) {
      warnings.push(`${label} is under a likely system-owned path: ${value}`);
    }
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

function uniquePathEntries(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    for (const entry of String(value || "").split(path.delimiter).filter(Boolean)) {
      const key = path.resolve(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function summarizeEnv(env) {
  return {
    keys: Object.keys(env).length,
    pathLength: (env.PATH || "").length,
    codexHome: env.CODEX_HOME || "",
    home: env.HOME || "",
    xdgConfigHome: env.XDG_CONFIG_HOME || "",
    xdgCacheHome: env.XDG_CACHE_HOME || "",
    xdgDataHome: env.XDG_DATA_HOME || "",
    ripgrepPath: env.RIPGREP_PATH || ""
  };
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0].trim();
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function parseArgs(rawArgs) {
  const result = {
    platform: "",
    pluginRoot: "",
    workspaceRoot: "",
    configRoot: "",
    globalStorageRoot: "",
    profileId: "unix-smoke-profile",
    rgPath: "",
    timeoutMs: 5000,
    skipVersionProbe: false,
    forceVersionProbe: false,
    json: false,
    help: false
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--skip-version-probe") {
      result.skipVersionProbe = true;
      continue;
    }
    if (arg === "--force-version-probe") {
      result.forceVersionProbe = true;
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

  result.timeoutMs = Number(result.timeoutMs) || 5000;
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
    "--rg-path": "rgPath",
    "--timeout-ms": "timeoutMs"
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

  console.log(`Codex Unix smoke check: ${value.ok ? "PASS" : "FAIL"}`);
  console.log(`platform=${value.platformId} current=${value.currentPlatformId}`);
  console.log(`pluginRoot=${value.pluginRoot}`);
  console.log(`runtime=${value.runtime?.selectedPath || "-"}`);
  console.log(`runtimeKind=${value.runtime?.summary?.kind || "-"} arch=${value.runtime?.summary?.arch || "-"} executable=${value.runtime?.summary?.executable ? "yes" : "no"}`);
  console.log(`runtimeVersion=${value.runtimeVersion.status}${value.runtimeVersion.stdout ? ` ${value.runtimeVersion.stdout}` : ""}`);
  console.log(`configRoot=${value.configRoot.selectedPath} (${value.configRoot.reason})`);
  console.log(`codexHome=${value.codexHome}`);
  console.log(`workspaceRoot=${value.workspaceRoot}`);
  console.log(`runtimeCwd=${value.runtimeCwd}`);
  console.log(`envKeys=${value.env.keys} pathLength=${value.env.pathLength}`);
  console.log(`HOME=${value.env.home || "-"}`);
  console.log(`XDG_CONFIG_HOME=${value.env.xdgConfigHome || "-"}`);
  console.log(`rg=${value.ripgrep.path || "-"} status=${value.ripgrep.status}${value.ripgrep.version ? ` version=${value.ripgrep.version}` : ""}`);
  for (const warning of value.warnings) {
    console.warn(`WARN ${warning}`);
  }
  for (const error of value.errors) {
    console.error(`ERROR ${error}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/unix-smoke-check.js [options]

Options:
  --platform <id>              Target Unix platform id: linux-x64, linux-arm64, darwin-x64, darwin-arm64.
  --plugin-root <path>         Deployed plugin root, usually the /plugins/codex directory.
  --workspace-root <path>      Workspace root used as normal runtime cwd.
  --config-root <path>         Codex Element config root that must be writable by this user.
  --global-storage-root <path> Simulated extension globalStorage root.
  --profile-id <id>            Profile id for CODEX_HOME smoke path.
  --rg-path <path>             Optional rg executable or directory.
  --timeout-ms <ms>            Timeout for runtime/rg probes. Default: 5000.
  --skip-version-probe         Do not execute codex --version.
  --force-version-probe        Execute codex --version even if current platform differs from target.
  --json                       Print machine-readable JSON.
  --help                       Show this help.

Examples:
  node scripts/unix-smoke-check.js --platform linux-x64 --plugin-root /opt/1c/plugins/codex --config-root /var/lib/codex-element --workspace-root /srv/element/workspace
  node scripts/unix-smoke-check.js --platform darwin-arm64 --plugin-root /Applications/Element/plugins/codex --config-root "$HOME/Library/Application Support/CodexElement"
`);
}

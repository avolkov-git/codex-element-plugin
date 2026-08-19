#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PLAYWRIGHT_MCP_VERSION = "0.0.78";
const args = parseArgs(process.argv.slice(2));
const platformId = args.platform || `${process.platform}-${process.arch}`;
const currentPlatformId = `${process.platform}-${process.arch}`;
const supported = new Set(["win32-x64", "linux-x64"]);
const outputRoot = path.resolve(args.root || path.resolve(__dirname, "..", "browser-runtime"));

if (args.help) {
  printHelp();
  process.exit(0);
}
if (!supported.has(platformId)) {
  fail(`unsupported browser runtime platform: ${platformId}`);
}
if (platformId !== currentPlatformId) {
  fail(`browser runtime must be prepared on its target OS: requested ${platformId}, runner is ${currentPlatformId}`);
}

const targetRoot = path.join(outputRoot, "browser", platformId);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `codex-element-browser-${platformId}.`));
try {
  fs.writeFileSync(path.join(workspace, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["install", "--omit=dev", "--ignore-scripts", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`], workspace, {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
  });

  const packageJsonPath = require.resolve("@playwright/mcp/package.json", { paths: [workspace] });
  const packageRoot = path.dirname(packageJsonPath);
  const packageManifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const playwrightCli = require.resolve("playwright/cli", { paths: [packageRoot, workspace] });
  const browsersPath = path.join(workspace, "browsers");
  run(process.execPath, [playwrightCli, "install", "chromium"], workspace, {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath
  });

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(path.join(workspace, "node_modules"), path.join(targetRoot, "node_modules"), { recursive: true, dereference: true });
  fs.cpSync(browsersPath, path.join(targetRoot, "browsers"), { recursive: true, dereference: true });

  const nodeRelativePath = process.platform === "win32" ? "node/node.exe" : "node/node";
  const nodeTarget = path.join(targetRoot, nodeRelativePath);
  fs.mkdirSync(path.dirname(nodeTarget), { recursive: true });
  fs.copyFileSync(process.execPath, nodeTarget);
  if (process.platform !== "win32") {
    fs.chmodSync(nodeTarget, 0o755);
  }

  const launcherSource = findLauncher(path.join(targetRoot, "node_modules", "@playwright", "mcp"));
  const browserExecutable = findBrowserExecutable(path.join(targetRoot, "browsers"));
  if (process.platform !== "win32") {
    fs.chmodSync(browserExecutable, 0o755);
  }
  const manifest = {
    schemaVersion: 1,
    platformId,
    playwrightMcpVersion: String(packageManifest.version || PLAYWRIGHT_MCP_VERSION),
    nodeVersion: process.version,
    nodePath: normalizeRelative(nodeRelativePath),
    launcherPath: normalizeRelative(path.relative(targetRoot, launcherSource)),
    browserExecutablePath: normalizeRelative(path.relative(targetRoot, browserExecutable))
  };
  fs.writeFileSync(path.join(targetRoot, "runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  smokeTestBrowser(targetRoot, manifest);
  console.log(`Browser runtime prepared: ${targetRoot}`);
  console.log(`Playwright MCP ${manifest.playwrightMcpVersion}; ${manifest.nodeVersion}; ${manifest.browserExecutablePath}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function smokeTestBrowser(targetRoot, manifest) {
  const script = [
    "const { chromium } = require(process.argv[1]);",
    "(async () => {",
    "  const browser = await chromium.launch({ headless: true, executablePath: process.argv[2] });",
    "  try {",
    "    const page = await browser.newPage();",
    "    await page.goto('data:text/html,<title>Codex browser release smoke test</title>');",
    "    if (await page.title() !== 'Codex browser release smoke test') throw new Error('unexpected page title');",
    "  } finally {",
    "    await browser.close();",
    "  }",
    "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });"
  ].join("\n");
  run(
    path.join(targetRoot, manifest.nodePath),
    [
      "-e",
      script,
      path.join(targetRoot, "node_modules", "playwright"),
      path.join(targetRoot, manifest.browserExecutablePath)
    ],
    targetRoot,
    process.env
  );
}

function findLauncher(packageRoot) {
  const candidates = ["cli.js", "lib/cli.js", "index.js"].map((value) => path.join(packageRoot, value));
  const candidate = candidates.find((value) => fs.existsSync(value) && fs.statSync(value).isFile());
  if (!candidate) {
    fail(`cannot find @playwright/mcp launcher under ${packageRoot}`);
  }
  return candidate;
}

function findBrowserExecutable(root) {
  const names = process.platform === "win32" ? new Set(["chrome.exe", "headless_shell.exe"]) : new Set(["chrome", "chrome-headless-shell"]);
  const matches = [];
  walk(root, (filePath, entry) => {
    if (entry.isFile() && names.has(entry.name)) {
      matches.push(filePath);
    }
  });
  matches.sort((left, right) => scoreBrowser(right) - scoreBrowser(left) || left.localeCompare(right));
  if (!matches.length) {
    fail(`cannot find Chromium executable under ${root}`);
  }
  return matches[0];
}

function scoreBrowser(value) {
  const normalized = value.toLowerCase();
  return (normalized.includes("chrome-headless-shell") ? 4 : 0) + (normalized.includes("chromium-") ? 2 : 0);
}

function walk(root, visit) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    visit(candidate, entry);
    if (entry.isDirectory()) {
      walk(candidate, visit);
    }
  }
}

function run(command, commandArgs, cwd, env) {
  const result = childProcess.spawnSync(command, commandArgs, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} exited with code ${result.status}`);
  }
}

function parseArgs(rawArgs) {
  const result = { root: "", platform: "", help: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--root" || arg === "--platform") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      result[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  return result;
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log("Usage: node scripts/prepare-browser-runtime.js --root <path> --platform <win32-x64|linux-x64>");
}

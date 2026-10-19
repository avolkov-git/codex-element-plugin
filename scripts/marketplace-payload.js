const fs = require("node:fs");
const path = require("node:path");
const { targetForPlatform, runtimeFileNames } = require("./runtime-preflight-lib");
const { verifyLinuxBrowserDependencies } = require("./linux-browser-dependencies");

// Only call with the disposable stage created by package-platform-releases.js.
function prepareMarketplacePayload(root, platformId) {
  root = fs.realpathSync(root);
  const source = fs.realpathSync(path.resolve(__dirname, ".."));
  if (root === source || source.startsWith(root + path.sep) || root.startsWith(source + path.sep) || root === path.parse(root).root) {
    throw new Error("Marketplace preparation requires a separate staging directory");
  }
  const target = targetForPlatform(platformId);
  if (!target) throw new Error(`Unknown platform: ${platformId}`);
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.xbsl?.schemaVersion !== 1) throw new Error("Missing XBSL declaration");
  const browserRoot = path.join(root, "browser", platformId);
  const browser = JSON.parse(fs.readFileSync(path.join(browserRoot, "runtime.json"), "utf8"));
  if (browser.platformId !== platformId || browser.schemaVersion !== 1) throw new Error("Browser platform mismatch");
  const linuxDependencies = verifyLinuxBrowserDependencies(browserRoot, browser);
  for (const field of ["nodePath", "launcherPath", "browserExecutablePath"]) {
    const relative = browser[field];
    if (typeof relative !== "string" || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") || path.isAbsolute(relative)) {
      throw new Error(`Unsafe browser path: ${field}`);
    }
    const file = path.join(browserRoot, relative);
    if (!fs.lstatSync(file).isFile() || !fs.statSync(file).size || !fs.realpathSync(file).startsWith(browserRoot + path.sep)) {
      throw new Error(`Missing or linked browser file: ${field}`);
    }
  }
  const parts = browser.browserExecutablePath.split("/");
  if (parts[0] !== "browsers" || !/^chromium(?:_headless_shell)?-\d+$/.test(parts[1])) {
    throw new Error("Unexpected browser executable layout");
  }
  // The runtime always passes executablePath explicitly. Keep that exact browser,
  // plus ffmpeg/winldd and notices; remove only the unused second Chromium build.
  const browsersRoot = path.join(browserRoot, "browsers");
  for (const entry of fs.readdirSync(browsersRoot)) {
    if (/^chromium(?:_headless_shell)?-\d+$/.test(entry) && entry !== parts[1]) {
      fs.rmSync(path.join(browsersRoot, entry), { recursive: true });
    }
  }
  // MCP starts via node + launcherPath, never the npm command shims/symlinks.
  fs.rmSync(path.join(browserRoot, "node_modules", ".bin"), { recursive: true, force: true });
  const shipped = new Set(["package.json", "package-lock.json", "README.md", "LICENSE", "dist", "media", "resources", "bin", "browser", "docs"]);
  for (const entry of fs.readdirSync(root)) {
    if (!shipped.has(entry)) fs.rmSync(path.join(root, entry), { recursive: true });
  }
  const required = new Set(manifest.xbsl.package.requiredFiles);
  const inventory = [];
  function walk(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Unsupported archive entry: ${name}`);
      inventory.push({ name, size: entry.isFile() ? fs.statSync(filename).size : 0, file: entry.isFile() });
      if (entry.isDirectory()) walk(filename, name);
      else if (/^(dist|media|resources)\//.test(name) && fs.statSync(filename).size > 0) required.add(name);
    }
  }
  walk(root);
  for (const file of runtimeFileNames(target)) required.add(`bin/${platformId}/${file}`);
  required.add(`browser/${platformId}/runtime.json`);
  for (const field of ["nodePath", "launcherPath", "browserExecutablePath"]) required.add(`browser/${platformId}/${browser[field]}`);
  for (const file of linuxDependencies) required.add(`browser/${platformId}/${file}`);
  if (required.size > 1000) throw new Error("XBSL requiredFiles limit exceeded");
  for (const file of required) {
    if (!inventory.some(entry => entry.name === file && entry.file && entry.size > 0)) throw new Error(`Missing required file: ${file}`);
  }
  manifest.xbsl.package.requiredFiles = [...required].sort();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const unpackedBytes = inventory.reduce((sum, entry) => sum + (entry.name === "package.json" ? fs.statSync(manifestPath).size : entry.size), 0);
  if (inventory.length + 1 > 10000 || unpackedBytes > 1024 ** 3) throw new Error("XBSL archive content limits exceeded");
  return { entries: inventory.length + 1, unpackedBytes, requiredFiles: required.size };
}

module.exports = { prepareMarketplacePayload };

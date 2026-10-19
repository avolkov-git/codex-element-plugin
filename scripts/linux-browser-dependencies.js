const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const MANIFEST_PATH = "linux-deps/manifest.json";
const HOST_LIBRARY = /^(?:ld-linux-x86-64\.so\.2|lib(?:c|m|dl|pthread|rt|resolv|util|anl|BrokenLocale)\.so\.[0-9]+)$/;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function containedFile(root, relative) {
  if (typeof relative !== "string" || !relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe Linux browser dependency path: ${relative}`);
  }
  const file = path.join(root, relative);
  if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) {
    throw new Error(`Missing or linked Linux browser dependency: ${relative}`);
  }
  return file;
}

function parseLdd(output) {
  if (/=>\s+not found/.test(output)) throw new Error(`Missing build-host libraries:\n${output}`);
  return output.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)\s+\(0x[0-9a-f]+\)/i);
    return match ? [{ name: match[1], filename: match[2] }] : [];
  });
}

function chromiumLauncher(binaryName) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(binaryName)) throw new Error("Unsafe Chromium binary name");
  return `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
ROOT=$(CDPATH= cd -- "$HERE/../../.." && pwd -P)
# Keep the private library search path out of Node.js, Codex and the IDE.
export LD_LIBRARY_PATH="$ROOT/linux-deps/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="$ROOT/linux-deps/fonts.conf"
export FONTCONFIG_PATH="$ROOT/linux-deps"
exec "$HERE/${binaryName}" "$@"
`;
}

function verifyLinuxBrowserDependencies(root, runtime) {
  if (!runtime.linuxDependenciesPath) return [];
  if (runtime.platformId !== "linux-x64" || runtime.linuxDependenciesPath !== MANIFEST_PATH) {
    throw new Error("Linux browser dependencies do not match the runtime platform/layout");
  }
  const manifestFile = containedFile(root, MANIFEST_PATH);
  if (fs.statSync(manifestFile).size > 256 * 1024) throw new Error("Linux dependency manifest is too large");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.distribution !== "ubuntu" || manifest.version !== "24.04"
    || manifest.architecture !== "amd64" || manifest.launcherPath !== runtime.browserExecutablePath
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 800) {
    throw new Error("Invalid Linux browser dependency manifest");
  }
  const expectedLauncher = path.posix.join(path.posix.dirname(manifest.browserBinaryPath || ""), "codex-chromium");
  if (!/^browsers\/chromium(?:_headless_shell)?-\d+\/[^/]+\/[^/]+$/.test(manifest.browserBinaryPath || "")
    || expectedLauncher !== manifest.launcherPath || manifest.browserBinaryPath === expectedLauncher) {
    throw new Error("Invalid portable Chromium layout");
  }
  const files = new Set();
  for (const record of manifest.files) {
    if (!record || typeof record.path !== "string" || files.has(record.path)
      || !(record.path.startsWith("linux-deps/") || [manifest.browserBinaryPath, manifest.launcherPath].includes(record.path))) {
      throw new Error("Invalid or duplicate Linux dependency record");
    }
    const file = containedFile(root, record.path);
    const stat = fs.statSync(file);
    if (!Number.isSafeInteger(record.size) || record.size <= 0 || record.size !== stat.size
      || !/^[a-f0-9]{64}$/.test(record.sha256 || "") || digest(fs.readFileSync(file)) !== record.sha256) {
      throw new Error(`Linux dependency checksum mismatch: ${record.path}`);
    }
    if (record.executable && process.platform !== "win32" && !(stat.mode & 0o111)) {
      throw new Error(`Linux dependency is not executable: ${record.path}`);
    }
    if (record.path.startsWith("linux-deps/lib/")) {
      if (HOST_LIBRARY.test(path.posix.basename(record.path))) throw new Error("Do not bundle the host glibc/loader");
      const bytes = fs.readFileSync(file);
      if (bytes.length < 20 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) {
        throw new Error(`Linux dependency is not ELF x86-64: ${record.path}`);
      }
    }
    files.add(record.path);
  }
  for (const required of [manifest.browserBinaryPath, manifest.launcherPath, "linux-deps/fonts.conf", "linux-deps/lib/libgbm.so.1", "linux-deps/NOTICE.txt"]) {
    if (!files.has(required)) throw new Error(`Required Linux dependency is not inventoried: ${required}`);
  }
  if (!manifest.packages?.length || ![...files].some(file => file.startsWith("linux-deps/fonts/"))) {
    throw new Error("Linux dependencies require fonts and package provenance");
  }
  return [MANIFEST_PATH, ...files];
}

function bundleLinuxBrowserDependencies(root) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux dependencies on Linux x64");
  const release = fs.readFileSync("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="24\.04"$/m.test(release)) {
    throw new Error("Build the portable browser on Ubuntu 24.04, not an arbitrary Linux runner");
  }
  root = fs.realpathSync(root);
  const runtimePath = path.join(root, "runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  if (runtime.platformId !== "linux-x64") throw new Error("Expected linux-x64 browser runtime");
  const previous = runtime.linuxDependenciesPath ? JSON.parse(fs.readFileSync(containedFile(root, MANIFEST_PATH), "utf8")) : undefined;
  const browserBinaryPath = previous?.browserBinaryPath || runtime.browserExecutablePath;
  if (!/^browsers\/chromium(?:_headless_shell)?-\d+\/[^/]+\/(?:chrome|chrome-headless-shell)$/.test(browserBinaryPath)) {
    throw new Error("Unexpected Chromium binary layout");
  }
  const binary = containedFile(root, browserBinaryPath);
  const dependencies = path.join(root, "linux-deps");
  fs.rmSync(dependencies, { recursive: true, force: true });
  fs.mkdirSync(path.join(dependencies, "lib"), { recursive: true });
  const env = { ...process.env, LC_ALL: "C" };
  delete env.LD_LIBRARY_PATH; delete env.LD_PRELOAD;
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  function copy(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.copyFileSync(fs.realpathSync(source), destination);
    fs.chmodSync(destination, 0o644);
  }
  const packages = new Map(), libraries = new Map(), hostLibraries = new Set();
  function recordPackage(file) {
    const real = fs.realpathSync(file);
    let owner;
    for (const candidate of [...new Set([file, real, real.replace(/^\/usr\/lib\//, "/lib/")])]) {
      try { owner = run("dpkg-query", ["-S", candidate]).split("\n").find(line => line.endsWith(`: ${candidate}`))?.split(": ")[0]; } catch {}
      if (owner) break;
    }
    if (!owner || !/^[a-z0-9+.-]+(?::amd64)?$/.test(owner)) throw new Error(`No Ubuntu package owns ${file}`);
    if (packages.has(owner)) return;
    const [name, version, source, sourceVersion] = run("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}", owner]).trim().split("\t");
    const shortName = name.split(":")[0];
    const notice = `/usr/share/doc/${shortName}/copyright`;
    const destination = path.join(dependencies, "licenses", shortName, "copyright");
    copy(notice, destination);
    packages.set(owner, { name, version, source: source || shortName, sourceVersion: sourceVersion || version,
      copyright: `linux-deps/licenses/${shortName}/copyright`, sourceUrl: `https://launchpad.net/ubuntu/+source/${source || shortName}/${encodeURIComponent(sourceVersion || version)}` });
  }
  function collect(file) {
    for (const item of parseLdd(run("ldd", [file]))) {
      if (HOST_LIBRARY.test(item.name)) { hostLibraries.add(item.name); continue; }
      if (!/^[a-zA-Z0-9_.+-]+$/.test(item.name)) throw new Error("Unsafe shared library name");
      if (libraries.has(item.name)) {
        if (libraries.get(item.name) !== fs.realpathSync(item.filename)) throw new Error(`Ambiguous dependency: ${item.name}`);
        continue;
      }
      libraries.set(item.name, fs.realpathSync(item.filename));
      copy(item.filename, path.join(dependencies, "lib", item.name));
      recordPackage(item.filename);
    }
  }
  collect(binary);
  // These modules are loaded with dlopen, so the Chromium ELF dependency list alone is incomplete.
  for (const name of ["libnssckbi.so", "libsoftokn3.so", "libfreebl3.so", "libfreeblpriv3.so", "libfontconfig.so.1", "libfreetype.so.6"]) {
    const file = `/usr/lib/x86_64-linux-gnu/${name}`;
    collect(file);
    libraries.set(name, fs.realpathSync(file));
    copy(file, path.join(dependencies, "lib", name));
    recordPackage(file);
  }
  for (const name of fs.readdirSync(path.dirname(binary))) {
    if (/\.so(?:\.\d+)*$/.test(name)) collect(path.join(path.dirname(binary), name));
  }
  for (const file of run("dpkg-query", ["-L", "fonts-liberation"]).split("\n").filter(file => /\.ttf$/i.test(file))) {
    const destination = path.join(dependencies, "fonts", path.basename(file));
    copy(file, destination); recordPackage(file);
  }
  for (const name of fs.readdirSync("/usr/share/common-licenses")) {
    copy(path.join("/usr/share/common-licenses", name), path.join(dependencies, "licenses", "common", name));
  }
  fs.writeFileSync(path.join(dependencies, "fonts.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir prefix="relative">fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir>/usr/share/fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>Liberation Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Liberation Mono</family></prefer></alias>
</fontconfig>
`);
  fs.writeFileSync(path.join(dependencies, "NOTICE.txt"), "Unmodified Ubuntu 24.04 amd64 shared libraries and Liberation fonts.\nEach component retains its own license; see licenses/ and manifest.json for package versions, copyright files and corresponding source links.\nThese components are not relicensed under the plugin MIT license. Keep notices and provide corresponding sources as required when redistributing.\nThe host supplies glibc and the ELF loader. This directory is private to Chromium, not a replacement for OS libraries.\n");
  const launcherPath = path.posix.join(path.posix.dirname(browserBinaryPath), "codex-chromium");
  fs.writeFileSync(path.join(root, launcherPath), chromiumLauncher(path.basename(binary)), { mode: 0o755 });
  fs.chmodSync(path.join(root, launcherPath), 0o755);
  const files = [];
  function inventory(file) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) inventory(path.join(file, name)); return; }
    if (!stat.isFile()) throw new Error(`Do not ship dependency symlinks: ${file}`);
    files.push({ path: path.relative(root, file).split(path.sep).join("/"), size: stat.size, sha256: digest(fs.readFileSync(file)), executable: Boolean(stat.mode & 0o111) });
  }
  inventory(dependencies); inventory(binary); inventory(path.join(root, launcherPath));
  const manifest = { schemaVersion: 1, distribution: "ubuntu", version: "24.04", architecture: "amd64", browserBinaryPath, launcherPath,
    hostLibraries: [...hostLibraries].sort(), packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), files };
  fs.writeFileSync(path.join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
  runtime.browserExecutablePath = launcherPath;
  runtime.linuxDependenciesPath = MANIFEST_PATH;
  verifyLinuxBrowserDependencies(root, runtime);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2) + "\n");
  console.log(`Bundled ${libraries.size} libraries and fonts from ${packages.size} Ubuntu packages: ${dependencies}`);
  return manifest;
}

module.exports = { bundleLinuxBrowserDependencies, verifyLinuxBrowserDependencies, parseLdd, chromiumLauncher, HOST_LIBRARY };

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/linux-browser-dependencies.js <browser/linux-x64>");
    bundleLinuxBrowserDependencies(process.argv[2]);
  } catch (error) { console.error(error); process.exitCode = 1; }
}

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const repo = path.resolve(__dirname, "..");
const { targetForPlatform, runtimeFileNames } = require("../scripts/runtime-preflight-lib");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function put(root, name, value = "fixture", mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value); fs.chmodSync(file, mode);
  return file;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stage-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "codex-plugin-deploy");
  for (const name of ["stage-deploy-payload.js", "verify-deploy-payload.js", "runtime-preflight-lib.js"]) {
    put(source, `scripts/${name}`, fs.readFileSync(path.join(repo, "scripts", name)));
  }
  const production = JSON.parse(fs.readFileSync(path.join(repo, "package.json")));
  put(source, "package.json", JSON.stringify({ name: "stage-review", publisher: "review", version: "1.0.0", engines: { vscode: "^1.97.0" }, main: "./dist/extension.js",
    scripts: { "deploy:stage:strict": production.scripts["deploy:stage:strict"] }, xbsl: { schemaVersion: 1, package: { requiredFiles: [] } } }));
  for (const name of ["dist/extension.js", "media/chat.js", "media/xbsl-highlighter.js", "media/sidebar.js", "media/settings.js", "media/settings.css", "media/settings-icons.js", "media/settings-icons.NOTICES.txt", "resources/context/codex-element-language-rules.md", "resources/context/yaml.cjs", "resources/context/yaml.LICENSE", "resources/context/ast/native-xbsl-ast.jar", "resources/context/ast/build.json", "resources/icons/codex.svg"]) put(source, name);
  const files = [];
  for (const platform of ["win32-x64", "linux-x64"]) {
    const spec = targetForPlatform(platform);
    for (const name of runtimeFileNames(spec)) {
      const bytes = Buffer.alloc(512);
      if (spec.kind === "pe") { bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132); }
      else { bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(0x3e, 18); }
      bytes.write(name, 200);
      const relative = `bin/${platform}/${name}`;
      put(source, relative, bytes, 0o755);
      files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
    }
  }
  put(source, "bin/runtime-manifest.json", JSON.stringify({ version: "fixture", files }));
  put(target, "previous-release.txt", "old target must survive failed staging");
  return { root, source, target };
}

function browser(root, marker = "old", platform = "win32-x64") {
  const dir = path.join(root, "browser", platform);
  const manifest = { schemaVersion: 1, platformId: platform, nodePath: "node/node" + (platform.startsWith("win") ? ".exe" : ""), launcherPath: "node_modules/@playwright/mcp/cli.js", browserExecutablePath: "browsers/chromium-9876/chrome" };
  put(dir, "runtime.json", JSON.stringify(manifest));
  for (const file of [manifest.nodePath, manifest.browserExecutablePath]) put(dir, file, marker, 0o755);
  put(dir, manifest.launcherPath, "console.log(require('./node_modules/transport').marker);\n");
  put(dir, "node_modules/@playwright/mcp/node_modules/transport/index.js", `exports.marker = ${JSON.stringify(marker)};\n`);
  put(dir, "browsers/chromium-9876/resources.pak", `pak:${marker}`);
  return { dir, manifest };
}

function run(f, args = [], env = {}, strict = true) {
  return spawnSync(process.execPath, [path.join(f.source, "scripts/stage-deploy-payload.js"), "--target", f.target, "--platform", "win32-x64", ...(strict ? ["--strict"] : []), ...args], {
    cwd: f.source, encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, ...env }
  });
}

function snapshot(root) {
  const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file), relative = path.relative(root, file);
      entries.push([relative, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? hash(fs.readFileSync(file)) : "directory"]);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root); return entries;
}

function unchanged(f, before, result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(snapshot(f.target), before, "failed staging changed the previous target");
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith(".codex-plugin-stage-")), false, "temporary stage leaked");
}

test("B1: unmodified npm strict command preserves the complete installed browser runtime", t => {
  const f = fixture(t), old = browser(f.target), before = snapshot(old.dir);
  const userConfig = put(f.root, "user.npmrc", ""), globalConfig = put(f.root, "global.npmrc", "");
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "deploy:stage:strict"], {
    cwd: f.source, encoding: "utf8", timeout: 10000, env: { ...process.env, npm_config_cache: path.join(f.root, "npm-cache"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_update_notifier: "false" }, shell: process.platform === "win32"
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(old.dir), before);
  assert.equal(fs.existsSync(path.join(f.target, "previous-release.txt")), false, "successful stage replaces non-runtime files");
  const cli = spawnSync(process.execPath, [path.join(old.dir, old.manifest.launcherPath)], { encoding: "utf8", timeout: 5000 });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /old/);
});

test("source browser includes nested npm dependencies, excludes dev dependencies, and replaces rather than merges old runtime", t => {
  const f = fixture(t), old = browser(f.target), source = browser(f.source, "source");
  put(old.dir, "obsolete-module.js"); put(f.source, "node_modules/dev-only/index.js");
  const r = run(f); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(old.dir), snapshot(source.dir));
  assert.equal(fs.existsSync(path.join(f.target, "node_modules")), false);
});

test("explicit browser overlay takes precedence over both source and previous target", t => {
  const f = fixture(t), old = browser(f.target); browser(f.source, "source");
  const external = path.join(f.root, "external"), selected = browser(external, "overlay");
  const r = run(f, ["--browser-runtime-root", external]); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(old.dir), snapshot(selected.dir));
});

test("platform-only staging keeps the requested old browser and prunes other platforms", t => {
  const f = fixture(t), old = browser(f.target), before = snapshot(old.dir);
  browser(f.target, "linux", "linux-x64");
  const r = run(f, ["--platform-only"]); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(old.dir), before);
  assert.equal(fs.existsSync(path.join(f.target, "browser/linux-x64")), false);
});

test("without platform-only the other installed platform is preserved too", t => {
  const f = fixture(t); browser(f.target);
  const other = browser(f.target, "linux", "linux-x64"), before = snapshot(other.dir);
  const r = run(f); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(other.dir), before);
});

for (const [label, mutate, error] of [
  ["malformed manifest", b => put(b.dir, "runtime.json", "{"), /manifest is invalid/],
  ["oversized manifest", b => put(b.dir, "runtime.json", Buffer.alloc(1024 * 1024 + 1, 32)), /exceeds 1 MiB/],
  ["platform mismatch", b => put(b.dir, "runtime.json", JSON.stringify({ ...b.manifest, platformId: "linux-x64" })), /does not match/],
  ["missing launcher", b => fs.unlinkSync(path.join(b.dir, b.manifest.launcherPath)), /launcherPath is missing/],
  ["empty launcher", b => put(b.dir, b.manifest.launcherPath, ""), /expected a nonempty file/],
  ["escaping path", b => put(b.dir, "runtime.json", JSON.stringify({ ...b.manifest, launcherPath: "../outside.js" })), /unsafe manifest path/],
  ["LFS launcher", b => put(b.dir, b.manifest.launcherPath, "version https://git-lfs.github.com/spec/v1\n"), /Git LFS pointer/]
]) {
  test(`invalid preserved browser (${label}) fails without modifying target`, t => {
    const f = fixture(t), b = browser(f.target); mutate(b); const before = snapshot(f.target);
    const r = run(f); unchanged(f, before, r); assert.match(r.stderr, error);
  });
}

test("invalid explicit overlay is not silently replaced by a valid installed browser", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  const overlay = path.join(f.root, "overlay"), b = browser(overlay);
  fs.unlinkSync(path.join(b.dir, b.manifest.launcherPath));
  const r = run(f, ["--browser-runtime-root", overlay]); unchanged(f, before, r); assert.match(r.stderr, /launcherPath/);
});

test("invalid source browser fails closed even when an older valid runtime is available", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target), b = browser(f.source);
  put(b.dir, "runtime.json", "null");
  const r = run(f); unchanged(f, before, r); assert.match(r.stderr, /does not match/);
});

test("unrelated preflight error preserves the installed browser and all previous target files", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  fs.unlinkSync(path.join(f.source, "resources/context/yaml.cjs"));
  const r = run(f); unchanged(f, before, r); assert.match(r.stderr, /required deploy file is missing/);
});

test("missing requested overlay platform fails without damaging the target", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  const overlay = path.join(f.root, "overlay"); browser(overlay, "linux", "linux-x64");
  const r = run(f, ["--browser-runtime-root", overlay]); unchanged(f, before, r); assert.match(r.stderr, /no payload for win32-x64/);
});

test("legacy development and strict staging without a browser remain supported", t => {
  const f = fixture(t);
  for (const strict of [false, true]) {
    const r = run(f, strict ? [] : ["--allow-lfs-pointer"], {}, strict); assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(f.target, "browser")), false);
  }
});

test("strict distribution metadata cannot promise a missing browser runtime", t => {
  const f = fixture(t), manifest = JSON.parse(fs.readFileSync(path.join(f.source, "package.json")));
  manifest.xbsl.package.requiredFiles = ["browser/win32-x64/runtime.json"];
  put(f.source, "package.json", JSON.stringify(manifest)); const before = snapshot(f.target);
  const r = run(f); unchanged(f, before, r); assert.match(r.stderr, /missing browser runtime/);
});

test("a declared ordinary browser asset may be an empty placeholder", t => {
  const f = fixture(t), b = browser(f.source);
  put(b.dir, "node_modules/@playwright/mcp/empty-placeholder", "");
  const manifest = JSON.parse(fs.readFileSync(path.join(f.source, "package.json")));
  manifest.xbsl.package.requiredFiles = ["browser/win32-x64/node_modules/@playwright/mcp/empty-placeholder"];
  put(f.source, "package.json", JSON.stringify(manifest));
  const r = run(f); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(path.join(f.target, manifest.xbsl.package.requiredFiles[0])).size, 0);
});

test("fresh staging failure leaves no incomplete target directory", t => {
  const f = fixture(t); fs.rmSync(f.target, { recursive: true });
  const b = browser(f.source); fs.unlinkSync(path.join(b.dir, b.manifest.nodePath));
  const r = run(f); assert.notEqual(r.status, 0); assert.equal(fs.existsSync(f.target), false);
});

test("publish rename failure restores the old target", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  const hook = put(f.root, "reject-publish.cjs", `const fs = require('node:fs'); const original = fs.renameSync;
fs.renameSync = function(from, to) { if (require('node:path').basename(from) === 'payload') throw new Error('injected publish failure'); return original.apply(this, arguments); };\n`);
  const r = run(f, [], { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` }); unchanged(f, before, r); assert.match(r.stderr, /injected publish failure/);
});

test("a failed rollback retains the complete old target at the reported recovery path", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  const hook = put(f.root, "reject-publish-and-restore.cjs", `const fs = require('node:fs'); const original = fs.renameSync;
fs.renameSync = function(from, to) { if (['payload', 'previous'].includes(require('node:path').basename(from))) throw new Error('injected rename failure'); return original.apply(this, arguments); };\n`);
  const r = run(f, [], { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` }); assert.notEqual(r.status, 0);
  const working = fs.readdirSync(f.root).filter(name => name.startsWith(".codex-plugin-stage-"));
  assert.equal(working.length, 1);
  const recovery = path.join(f.root, working[0], "previous");
  assert.deepEqual(snapshot(recovery), before);
  assert.ok(r.stderr.includes(`previous payload retained at ${recovery}`), r.stderr);
  assert.equal(fs.existsSync(f.target), false);
});

test("bounded preflight timeout leaves the previous target untouched", t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  const hook = put(f.root, "timeout-preflight.cjs", `const cp = require('node:child_process'); const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) { if (args[0].endsWith('verify-deploy-payload.js')) {
  if (options.timeout !== 60000 || options.maxBuffer !== 4 * 1024 * 1024) throw new Error('unbounded preflight');
  return { error: new Error('ETIMEDOUT preflight'), status: null, signal: 'SIGTERM' };
} return original.apply(this, arguments); };\n`);
  const r = run(f, [], { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` }); unchanged(f, before, r); assert.match(r.stderr, /ETIMEDOUT preflight/);
});

test("browser executable validation only reads its bounded prefix", t => {
  const f = fixture(t), b = browser(f.source), file = path.join(b.dir, b.manifest.nodePath);
  fs.truncateSync(file, 2 * 1024 * 1024);
  const hook = put(f.root, "bound-browser-reads.cjs", `const fs = require('node:fs'); const original = fs.readFileSync;
fs.readFileSync = function(file) { if (String(file).endsWith('node.exe')) throw new Error('unbounded browser read'); return original.apply(this, arguments); };\n`);
  const r = run(f, [], { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` }); assert.equal(r.status, 0, r.stderr);
});

test("escaping browser symlinks are rejected without modifying target", { skip: process.platform === "win32" }, t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target), b = browser(f.source);
  const outside = put(f.root, "outside.js"); fs.symlinkSync(outside, path.join(b.dir, "node_modules/escape.js"));
  const r = run(f); unchanged(f, before, r); assert.match(r.stderr, /escaping browser runtime link/);
});

test("a broken source browser platform link cannot silently remove the previous runtime", { skip: process.platform === "win32" }, t => {
  const f = fixture(t); browser(f.target); const before = snapshot(f.target);
  fs.mkdirSync(path.join(f.source, "browser"));
  fs.symlinkSync(path.join(f.root, "does-not-exist"), path.join(f.source, "browser/win32-x64"));
  const r = run(f, ["--platform-only"]); unchanged(f, before, r); assert.match(r.stderr, /invalid browser runtime directory/);
});

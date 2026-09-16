const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { targets, targetForPlatform, runtimeFileNames, verifyRuntimeManifest } = require("../scripts/runtime-preflight-lib");
const { loadSource } = require("./service-test-utils.cjs");
const shippedManifest = require("../bin/runtime-manifest.json");

test("0.154.0 manifest pins all six platforms and all sixteen official release artifacts", () => {
  assert.equal(shippedManifest.version, "0.154.0");
  assert.equal(shippedManifest.source, "https://github.com/openai/codex/releases/tag/rust-v0.154.0");
  const triples = {
    "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin"
  };
  const expectedPaths = [];
  for (const [platformId, triple] of Object.entries(triples)) {
    const windows = platformId.startsWith("win32-");
    const names = windows
      ? ["codex.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "codex-code-mode-host.exe"]
      : ["codex", "codex-code-mode-host"];
    assert.deepEqual(runtimeFileNames(targetForPlatform(platformId)), names);
    for (const name of names) {
      const relative = `bin/${platformId}/${name}`;
      expectedPaths.push(relative);
      const entry = shippedManifest.files.find((file) => file.path === relative);
      assert.ok(entry, relative);
      assert.equal(entry.asset, `${name.replace(/\.exe$/, "")}-${triple}${windows ? ".exe" : ""}.tar.gz`);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.match(entry.assetSha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(entry.size) && entry.size > 512);
    }
  }
  assert.deepEqual(shippedManifest.files.map((file) => file.path).sort(), expectedPaths.sort(), "no missing, extra or duplicated binaries");
});

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-payload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, relative, data, mode = 0o644) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.chmodSync(file, mode);
  return file;
}
function binary(target, name, version) {
  const bytes = Buffer.alloc(512);
  if (target.kind === "pe") {
    bytes.write("MZ"); bytes.writeUInt32LE(0x80, 0x3c); bytes.write("PE\0\0", 0x80);
    bytes.writeUInt16LE(target.arch === "x64" ? 0x8664 : 0xaa64, 0x84);
  } else if (target.kind === "elf") {
    bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1;
    bytes.writeUInt16LE(target.arch === "x64" ? 0x3e : 0xb7, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  bytes.write(name, 200);
  bytes.write(version, 400);
  return bytes;
}
function fixture(root, target, pointers = false, version = shippedManifest.version) {
  const files = runtimeFileNames(target).map((name) => {
    const bytes = binary(target, name, version), relative = `bin/${target.platformId}/${name}`;
    const entry = { path: relative, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    write(root, relative, pointers ? `version https://git-lfs.github.com/spec/v1\noid sha256:${entry.sha256}\nsize ${entry.size}\n` : bytes, target.executableBit ? 0o755 : 0o644);
    return entry;
  });
  write(root, "bin/runtime-manifest.json", JSON.stringify({ version, files }));
  return files.at(-1).path;
}

for (const target of targets) {
  test(`${target.platformId}: missing companion, checksum and executable format are validated`, { skip: process.platform === "win32" && target.executableBit }, (t) => {
    const root = temp(t), helper = fixture(root, target), file = path.join(root, helper), original = fs.readFileSync(file);
    assert.deepEqual(verifyRuntimeManifest(root, [target.platformId]), []);
    fs.unlinkSync(file);
    assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /missing runtime.*code-mode-host/);
    fs.writeFileSync(file, original); fs.chmodSync(file, target.executableBit ? 0o755 : 0o644);
    const changed = Buffer.from(original); changed[400] = 1; fs.writeFileSync(file, changed);
    assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /does not match pinned runtime/);
    fs.writeFileSync(file, "not an executable");
    assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /kind=unknown/);
    fs.writeFileSync(file, original);
    if (target.executableBit && process.platform !== "win32") {
      fs.chmodSync(file, 0o644);
      assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /missing executable bit/);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "bin/runtime-manifest.json")));
    manifest.files.pop(); write(root, "bin/runtime-manifest.json", JSON.stringify(manifest));
    assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /missing checksum.*code-mode-host/);
  });
  test(`${target.platformId}: LFS pointer is allowed only for a source checkout`, (t) => {
    const root = temp(t); fixture(root, target, true);
    assert.deepEqual(verifyRuntimeManifest(root, [target.platformId], { allowLfsPointer: true }), []);
    assert.match(verifyRuntimeManifest(root, [target.platformId]).join("\n"), /code-mode-host.*Git LFS pointer/);
  });
  test(`${target.platformId}: every executable is required and stale 0.153.4 bytes are rejected`, { skip: process.platform === "win32" && target.executableBit }, (t) => {
    const root = temp(t); fixture(root, target);
    for (const name of runtimeFileNames(target)) {
      const relative = `bin/${target.platformId}/${name}`, file = path.join(root, relative), original = fs.readFileSync(file);
      fs.unlinkSync(file);
      assert.ok(verifyRuntimeManifest(root, [target.platformId]).some(error => error.includes(file) && error.includes("missing runtime")), name);
      write(root, relative, binary(target, name, "0.153.4"), target.executableBit ? 0o755 : 0o644);
      assert.ok(verifyRuntimeManifest(root, [target.platformId]).some(error => error.includes(relative) && error.includes("pinned runtime 0.154.0")), name);
      write(root, relative, original, target.executableBit ? 0o755 : 0o644);
    }
    assert.deepEqual(verifyRuntimeManifest(root, [target.platformId]), []);
  });
}

function stagingFixture(root, target) {
  const source = path.join(root, "source"); fixture(source, target, true);
  for (const script of ["stage-deploy-payload.js", "verify-deploy-payload.js", "runtime-preflight-lib.js"]) {
    write(source, `scripts/${script}`, fs.readFileSync(path.join(__dirname, "../scripts", script)));
  }
  write(source, "package.json", JSON.stringify({
    name: "fixture", publisher: "fixture-author", version: "1.0.2-rc",
    engines: { vscode: "^1.97.0" }, main: "./dist/extension.js"
  }));
  for (const relative of ["dist/extension.js", "media/chat.js", "media/xbsl-highlighter.js", "media/sidebar.js", "media/settings.js", "media/settings.css", "media/settings-icons.js", "media/settings-icons.NOTICES.txt", "resources/context/codex-element-language-rules.md", "resources/icons/codex.svg"]) write(source, relative, "fixture");
  return source;
}
function stage(source, destination, runtimeRoot) {
  return spawnSync(process.execPath, [path.join(source, "scripts/stage-deploy-payload.js"), "--target", destination, "--platform", "win32-x64", "--platform-only", "--strict", ...(runtimeRoot ? ["--runtime-root", runtimeRoot] : [])], { encoding: "utf8", timeout: 10000 });
}
for (const [label, mutate, expected] of [
  ["missing publisher", (manifest) => delete manifest.publisher, /publisher must be a non-empty string/],
  ["blank name", (manifest) => { manifest.name = "  "; }, /name must be a non-empty string/],
  ["numeric version", (manifest) => { manifest.version = 103; }, /version must be a non-empty string/],
  ["missing engines", (manifest) => delete manifest.engines, /engines must be an object/],
  ["string engines", (manifest) => { manifest.engines = "^1.97.0"; }, /engines must be an object/],
  ["blank API range", (manifest) => { manifest.engines.vscode = " "; }, /engines must be an object/],
  ["missing entry point", (manifest) => delete manifest.main, /main must be/],
  ["missing browser entry file", (manifest) => { manifest.browser = "./dist/missing.js"; }, /browser must point to a file/],
  ["missing icon file", (manifest) => { manifest.icon = "resources/missing.svg"; }, /icon must point to a file/],
  ["entry outside plugin", (manifest) => { manifest.browser = "../outside.js"; }, /browser must point to a file/]
]) {
  test(`staging rejects publication manifest with ${label}`, (t) => {
    const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target);
    const runtimeRoot = path.join(root, "runtime");
    fixture(runtimeRoot, target);
    const manifestPath = path.join(source, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = stage(source, path.join(root, "deploy"), runtimeRoot);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, expected);
  });
}
test("staging only warns about missing optional publication metadata", (t) => {
  const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target);
  const runtimeRoot = path.join(root, "runtime");
  fixture(runtimeRoot, target);
  const result = stage(source, path.join(root, "deploy"), runtimeRoot);
  assert.equal(result.status, 0, result.stderr);
  for (const field of ["displayName", "description", "categories"]) {
    assert.match(result.stderr, new RegExp(`WARN package.json ${field}`));
  }
});
test("staging copies every companion from an external runtime root", (t) => {
  const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target);
  const runtimeRoot = path.join(root, "runtime"), destination = path.join(root, "deploy");
  fixture(runtimeRoot, target);
  const result = stage(source, destination, runtimeRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(verifyRuntimeManifest(destination, [target.platformId]), []);
});
test("restaging preserves real companions when the source contains LFS pointers", (t) => {
  const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target), destination = path.join(root, "deploy");
  fixture(destination, target);
  const result = stage(source, destination);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(verifyRuntimeManifest(destination, [target.platformId]), []);
});
test("restaging rejects a preserved 0.153.4 runtime under the 0.154.0 manifest", (t) => {
  const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target), destination = path.join(root, "deploy");
  fixture(destination, target, false, "0.153.4");
  const result = stage(source, destination);
  assert.notEqual(result.status, 0);
  for (const name of runtimeFileNames(target)) assert.ok(result.stderr.includes(`bin/${target.platformId}/${name} does not match pinned runtime 0.154.0`), result.stderr);
});
test("staging rejects an incomplete external runtime", (t) => {
  const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target), runtimeRoot = path.join(root, "runtime");
  const helper = fixture(runtimeRoot, target); fs.unlinkSync(path.join(runtimeRoot, helper));
  const result = stage(source, path.join(root, "deploy"), runtimeRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /code-mode-host/);
});
for (const asset of ["settings.css", "settings-icons.js", "settings-icons.NOTICES.txt"]) {
  test(`staging rejects missing settings asset ${asset}`, (t) => {
    const root = temp(t), target = targetForPlatform("win32-x64"), source = stagingFixture(root, target);
    const runtimeRoot = path.join(root, "runtime");
    fixture(runtimeRoot, target);
    fs.unlinkSync(path.join(source, "media", asset));
    const result = stage(source, path.join(root, "deploy"), runtimeRoot);
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes(`required deploy file is missing: media/${asset}`), result.stderr);
  });
}
test("runtime startup reports a missing Code Mode host in Russian before spawning", (t) => {
  const root = temp(t), target = targetForPlatform(`${process.platform}-${process.arch}`), helper = fixture(root, target);
  const { resolveBundledRuntimeExecutable, validateRuntimeExecutable } = loadSource("src/platform.ts");
  const resolution = resolveBundledRuntimeExecutable(root);
  assert.equal(validateRuntimeExecutable(resolution).ok, true);
  fs.unlinkSync(path.join(root, helper));
  const validation = validateRuntimeExecutable(resolution);
  assert.equal(validation.ok, false);
  assert.match(validation.message, /Поставка Codex неполная.*codex-code-mode-host/);
  assert.match(validation.message, /MCP/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { verifyLinuxBrowserDependencies, parseLdd, chromiumLauncher } = require("../scripts/linux-browser-dependencies");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable browser "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = "browsers/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell";
  const launcher = path.posix.join(path.posix.dirname(binary), "codex-chromium");
  const files = [];
  const put = (relative, bytes, executable = false) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes, { mode: executable ? 0o755 : 0o644 });
    files.push({ path: relative, size: Buffer.byteLength(bytes), sha256: hash(bytes), executable });
  };
  const elf = Buffer.alloc(64); elf.writeUInt32BE(0x7f454c46); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  put(binary, elf, true); put(launcher, chromiumLauncher("chrome-headless-shell"), true);
  put("linux-deps/lib/libgbm.so.1", elf);
  for (const file of ["fonts.conf", "NOTICE.txt", "fonts/LiberationSans-Regular.ttf"]) put(`linux-deps/${file}`, "fixture");
  const manifest = { schemaVersion: 1, distribution: "ubuntu", version: "24.04", architecture: "amd64", launcherPath: launcher,
    browserBinaryPath: binary, files, packages: [{ name: "libgbm1", version: "fixture" }] };
  const runtime = { platformId: "linux-x64", browserExecutablePath: launcher, linuxDependenciesPath: "linux-deps/manifest.json" };
  const save = () => fs.writeFileSync(path.join(root, runtime.linuxDependenciesPath), JSON.stringify(manifest));
  save(); return { root, runtime, manifest, save, put };
}

test("ldd includes transitive paths and fails closed on unresolved libraries", () => {
  assert.deepEqual(parseLdd("linux-vdso.so.1 (0x1)\n libgbm.so.1 => /lib/x86_64-linux-gnu/libgbm.so.1 (0xabcdef)\n /lib64/ld-linux-x86-64.so.2 (0x2)\n"),
    [{ name: "libgbm.so.1", filename: "/lib/x86_64-linux-gnu/libgbm.so.1" }]);
  assert.throws(() => parseLdd("libgbm.so.1 => not found"), /Missing build-host/);
});
test("legacy and Windows runtimes remain readable; declared dependencies require the Linux platform", t => {
  assert.deepEqual(verifyLinuxBrowserDependencies("unused", { platformId: "win32-x64" }), []);
  const f = fixture(t); f.runtime.platformId = "win32-x64";
  assert.throws(() => verifyLinuxBrowserDependencies(f.root, f.runtime), /platform/);
});
test("inventory verifies actual bytes and returns all required portable files", t => {
  const f = fixture(t);
  const files = verifyLinuxBrowserDependencies(f.root, f.runtime);
  assert(files.includes(f.manifest.browserBinaryPath));
  assert(files.includes("linux-deps/lib/libgbm.so.1"));
  assert.equal(files.length, f.manifest.files.length + 1);
});
for (const mutation of ["missing", "corrupt", "pointer", "architecture", "traversal", "duplicate", "glibc", "fonts", "launcher", "unreadable-manifest"]) {
  test(`portable verification rejects ${mutation}`, t => {
    const f = fixture(t), file = "linux-deps/lib/libgbm.so.1";
    if (mutation === "missing") fs.unlinkSync(path.join(f.root, file));
    if (mutation === "corrupt") fs.writeFileSync(path.join(f.root, file), "changed");
    if (mutation === "pointer") {
      const pointer = "version https://git-lfs.github.com/spec/v1\n";
      fs.writeFileSync(path.join(f.root, file), pointer);
      Object.assign(f.manifest.files.find(r => r.path === file), { size: Buffer.byteLength(pointer), sha256: hash(pointer) });
    }
    if (mutation === "architecture") { const bytes = fs.readFileSync(path.join(f.root, file)); bytes.writeUInt16LE(183, 18); fs.writeFileSync(path.join(f.root, file), bytes); f.manifest.files.find(r => r.path === file).sha256 = hash(bytes); }
    if (mutation === "traversal") f.manifest.files[0].path = "linux-deps/../../outside";
    if (mutation === "duplicate") f.manifest.files.push(f.manifest.files[0]);
    if (mutation === "glibc") f.put("linux-deps/lib/libc.so.6", fs.readFileSync(path.join(f.root, file)));
    if (mutation === "fonts") f.manifest.files = f.manifest.files.filter(r => !r.path.startsWith("linux-deps/fonts/"));
    if (mutation === "launcher") f.runtime.browserExecutablePath = f.manifest.browserBinaryPath;
    f.save();
    if (mutation === "unreadable-manifest") fs.writeFileSync(path.join(f.root, f.runtime.linuxDependenciesPath), "{");
    assert.throws(() => verifyLinuxBrowserDependencies(f.root, f.runtime));
  });
}
test("symbolic links are rejected even when their target is inside the runtime", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), file = path.join(f.root, "linux-deps/lib/libgbm.so.1");
  fs.renameSync(file, `${file}.real`); fs.symlinkSync("libgbm.so.1.real", file);
  assert.throws(() => verifyLinuxBrowserDependencies(f.root, f.runtime), /linked/);
});
test("launcher is relocatable, quotes arguments and confines library/font overrides to its child", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, f.manifest.browserBinaryPath), '#!/bin/sh\nprintf "%s\\n" "$LD_LIBRARY_PATH" "$FONTCONFIG_FILE" "$@"\n', { mode: 0o755 });
  const original = process.env.LD_LIBRARY_PATH;
  const result = spawnSync(path.join(f.root, f.manifest.launcherPath), ["with spaces", "$(do-not-execute)"], { encoding: "utf8", env: { ...process.env, LD_LIBRARY_PATH: "/host/lib" } });
  assert.equal(result.status, 0, result.stderr);
  const realRoot = fs.realpathSync(f.root);
  assert.deepEqual(result.stdout.trim().split("\n"), [`${realRoot}/linux-deps/lib:/host/lib`, `${realRoot}/linux-deps/fonts.conf`, "with spaces", "$(do-not-execute)"]);
  assert.equal(process.env.LD_LIBRARY_PATH, original);
});

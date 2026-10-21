const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

test("Windows release ZIP uses portable paths and preserves hidden files", { skip: process.platform !== "win32" }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zip-check-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const payload = path.join(temp, "codex-plugins");
  const entries = ["package.json", "dist/extension.js", "browser/node_modules/.metadata", "resources/space in name.txt"];
  for (const entry of entries) {
    const file = path.join(payload, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${entry}`);
  }
  const archive = path.join(temp, "release.zip");
  const packaged = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    path.resolve(__dirname, "../scripts/package-windows-zip.ps1"), "-Source", payload, "-Destination", archive], { encoding: "utf8" });
  assert.equal(packaged.status, 0, packaged.stderr);
  const listed = spawnSync("tar.exe", ["-tf", archive], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/).sort(), entries.map(entry => `codex-plugins/${entry}`).sort());
  const extracted = path.join(temp, "extracted");
  fs.mkdirSync(extracted);
  const unpacked = spawnSync("tar.exe", ["-xf", archive, "-C", extracted], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  for (const entry of entries) {
    assert.equal(fs.readFileSync(path.join(extracted, "codex-plugins", entry), "utf8"), `fixture:${entry}`);
  }
});

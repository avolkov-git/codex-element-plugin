const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { EventEmitter, once } = require("node:events");
const { createInterface } = require("node:readline");
const { execFileSync, spawn } = require("node:child_process");
const { test } = require("node:test");
const { root: sourceRoot, loadSource, logger, vscode } = require("./service-test-utils.cjs");

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-service-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function browserFixture(t) {
  const root = temp(t);
  const runtimeRoot = path.join(root, "browser", `${process.platform}-${process.arch}`);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const files = ["node", "launcher.js", "chromium"].map((name) => path.join(runtimeRoot, name));
  for (const file of files) {
    const fd = fs.openSync(file, "w", 0o755);
    fs.writeSync(fd, "valid runtime header");
    fs.ftruncateSync(fd, 300 * 1024 * 1024);
    fs.closeSync(fd);
  }
  const manifest = { schemaVersion: 1, platformId: `${process.platform}-${process.arch}`,
    playwrightMcpVersion: "1", nodeVersion: "22", nodePath: "node", launcherPath: "launcher.js", browserExecutablePath: "chromium" };
  fs.writeFileSync(path.join(runtimeRoot, "runtime.json"), JSON.stringify(manifest));
  const configRoot = path.join(root, "config");
  const settings = {
    getConfigRoot: () => configRoot,
    getBrowserSettingsView: () => ({ enabled: true, baseUrl: "http://project.local/app", allowedOrigins: [], disableSandbox: false }),
  };
  return { root, runtimeRoot, files, configRoot, settings };
}

test("F03: sparse 900 MiB runtime reads at most 384 header bytes, caches checks and invalidates replacement", (t) => {
  const fixture = browserFixture(t);
  let reads = 0;
  let bytes = 0;
  let manifestReads = 0;
  const mockFs = { ...fs,
    readFileSync(file, ...args) {
      assert(!fixture.files.includes(file), "must never read an entire executable");
      manifestReads += 1;
      return fs.readFileSync(file, ...args);
    },
    readSync(fd, buffer, offset, length, position) {
      reads += 1;
      bytes += length;
      assert.equal(length, 128);
      return fs.readSync(fd, buffer, offset, length, position);
    },
  };
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { fs: mockFs, vscode });
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: fixture.root } }, fixture.settings, logger);
  for (let index = 0; index < 100; index += 1) assert.equal(service.getView().status, "ready");
  assert.equal(reads, 3);
  assert.equal(bytes, 384);
  assert.equal(manifestReads, 1);
  const before = fs.statSync(fixture.files[0]);
  const replacement = `${fixture.files[0]}.replacement`;
  const fd = fs.openSync(replacement, "w", 0o755);
  fs.writeSync(fd, "version https://git-lfs.github.com/spec/v1\n");
  fs.ftruncateSync(fd, before.size);
  fs.closeSync(fd);
  fs.utimesSync(replacement, before.atime, before.mtime);
  fs.renameSync(replacement, fixture.files[0]);
  assert.match(service.getView().statusMessage, /LFS pointer/);
  assert.equal(reads, 4);
});

test("browser preparation fails closed without trusted scope; artifacts always follow the current session", (t) => {
  const fixture = browserFixture(t);
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const context = { extensionUri: { fsPath: fixture.root } };
  const unscoped = new BrowserRuntimeService(context, fixture.settings, logger);
  assert.equal(unscoped.getBrowserArtifactsRoot(), undefined);
  assert.throws(() => unscoped.prepareMcpServer(), /область/);
  assert(!fs.existsSync(fixture.configRoot));
  let scope = path.join(fixture.configRoot, "user-a", "project-a", "session-a");
  let persistent = path.join(fixture.configRoot, "user-a", "project-a");
  const scoped = new BrowserRuntimeService(context, fixture.settings, logger, () => scope, () => persistent);
  assert.equal(scoped.getSettingsView().enabled, false, "server-global browser settings must not be inherited");
  scoped.saveSettings(fixture.settings.getBrowserSettingsView());
  const first = scoped.prepareMcpServer();
  const firstConfig = JSON.parse(fs.readFileSync(first.args[2], "utf8"));
  assert.equal(firstConfig.outputDir, scoped.getBrowserArtifactsRoot());
  assert(firstConfig.outputDir.startsWith(`${scope}${path.sep}`));
  if (process.platform !== "win32") assert.equal(fs.statSync(first.args[2]).mode & 0o777, 0o600);
  scope = path.join(fixture.configRoot, "user-b", "project-b", "session-b");
  persistent = path.join(fixture.configRoot, "user-b", "project-b");
  assert.equal(scoped.getSettingsView().enabled, false);
  scoped.saveSettings(fixture.settings.getBrowserSettingsView());
  const second = scoped.prepareMcpServer();
  assert.notEqual(first.args[2], second.args[2]);
  assert.notEqual(firstConfig.outputDir, scoped.getBrowserArtifactsRoot());
  assert(!fs.existsSync(path.join(fixture.configRoot, "browser")));
  for (scope of [undefined, "relative", fixture.configRoot, path.join(fixture.configRoot, "browser")]) {
    assert.equal(scoped.getBrowserArtifactsRoot(), undefined);
    assert.throws(() => scoped.prepareMcpServer());
  }
});

test("browser rejects symlink escapes and oversized manifests without reading them", (t) => {
  const fixture = browserFixture(t);
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: fixture.root } }, fixture.settings, logger);
  const outside = path.join(fixture.root, "outside");
  fs.writeFileSync(outside, "outside", { mode: 0o755 });
  fs.unlinkSync(fixture.files[0]);
  fs.symlinkSync(outside, fixture.files[0]);
  assert.equal(service.getView().status, "error");
  fs.writeFileSync(path.join(fixture.runtimeRoot, "runtime.json"), " ".repeat(65537));
  assert.match(service.getView().statusMessage, /поврежден/);
});

test("native Codex CLI launch overrides replace a saved foreign browser entry and never persist session paths", (t) => {
  const binary = path.join(sourceRoot, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "codex.exe" : "codex");
  if (!fs.existsSync(binary) || fs.statSync(binary).size < 1024) return t.skip("Native bundled Codex executable unavailable");
  const fixture = browserFixture(t);
  const home = path.join(fixture.root, "isolated-codex-home");
  fs.mkdirSync(home);
  const config = path.join(home, "config.toml");
  const previous = '[mcp_servers.codex-element-browser]\ncommand="foreign-browser"\nargs=["--config", "/other/user/project/session/config.json"]\nenv={FOREIGN_SESSION="secret"}\ncwd="/other/project"\n[mcp_servers.unrelated]\ncommand="retained"\n';
  fs.writeFileSync(config, previous);
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  let scope = path.join(fixture.configRoot, "user", "project", "session-a");
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: fixture.root } }, fixture.settings, logger, () => scope,
    () => path.join(fixture.configRoot, "user", "project"));
  service.saveSettings(fixture.settings.getBrowserSettingsView());
  function inspect(launch) {
    const output = execFileSync(binary, ["mcp", "list", "--json", ...launch.args], { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 10000 });
    const records = JSON.parse(output);
    assert(records.some((item) => item.name === "unrelated"));
    assert.equal(fs.readFileSync(config, "utf8"), previous);
    const legacy = records.find((item) => item.name === "codex-element-browser");
    assert.equal(legacy.enabled, false, "legacy entry must be disabled regardless of shared config contents");
    return records.find((item) => item.name === launch.managedServerName) || legacy;
  }
  const first = service.prepareRuntimeLaunch();
  assert.match(first.managedServerName, /^codex-element-browser-[a-f0-9]{32}$/);
  const active = inspect(first);
  assert.equal(active.enabled, true);
  assert.equal(active.transport.command, fixture.files[0]);
  assert.equal(active.transport.env, null);
  assert.equal(active.transport.cwd, null);
  assert(active.transport.args[2].startsWith(`${scope}${path.sep}`));
  scope = path.join(fixture.configRoot, "user", "project-b", "session-b");
  const second = service.prepareRuntimeLaunch();
  assert.notEqual(first.managedServerName, second.managedServerName);
  assert.notEqual(inspect(second).transport.args[2], active.transport.args[2]);
  assert.notEqual(first.artifactsRoot, second.artifactsRoot);
  scope = undefined;
  const disabled = inspect(service.prepareRuntimeLaunch());
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.transport.command, "codex-element-browser-disabled");
  assert.deepEqual(disabled.transport.args, []);
});

test("browser project preferences persist across sessions, fail closed on corruption and never follow server-global defaults", (t) => {
  const fixture = browserFixture(t);
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const context = { extensionUri: { fsPath: fixture.root } };
  const persistent = path.join(fixture.configRoot, "user", "project");
  const first = new BrowserRuntimeService(context, fixture.settings, logger,
    () => path.join(persistent, "sessions", "first"), () => persistent);
  const second = new BrowserRuntimeService(context, fixture.settings, logger,
    () => path.join(persistent, "sessions", "second"), () => persistent);
  assert.equal(first.getSettingsView().enabled, false);
  first.saveSettings(fixture.settings.getBrowserSettingsView());
  assert.equal(second.getSettingsView().enabled, true);
  assert.notEqual(first.getBrowserArtifactsRoot(), second.getBrowserArtifactsRoot());
  const preferences = path.join(persistent, "browser-settings.json");
  fs.writeFileSync(preferences, "{corrupt");
  assert.equal(first.getSettingsView().enabled, false);
  assert(first.prepareRuntimeLaunch().disabledReason);
  assert.equal(fs.readFileSync(preferences, "utf8"), "{corrupt");
  const missingPersistent = new BrowserRuntimeService(context, fixture.settings, logger, () => persistent);
  assert.equal(missingPersistent.getSettingsView().enabled, false);
  assert.throws(() => missingPersistent.saveSettings(fixture.settings.getBrowserSettingsView()));
});

test("native app-server reload keeps the legacy browser disabled after concurrent profile edits", { timeout: 20000 }, async (t) => {
  const binary = path.join(sourceRoot, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "codex.exe" : "codex");
  if (!fs.existsSync(binary) || fs.statSync(binary).size < 1024) return t.skip("Native bundled Codex executable unavailable");
  const fixture = browserFixture(t);
  const home = path.join(fixture.root, "private-home");
  const persistent = path.join(fixture.configRoot, "user", "project");
  fs.mkdirSync(home);
  const configPath = path.join(home, "config.toml");
  const source = '[mcp_servers.codex-element-browser]\nenabled=true\ncommand="foreign-browser"\nargs=["/foreign/artifacts"]\nenv={FOREIGN_SESSION="do-not-inherit"}\n';
  fs.writeFileSync(configPath, source);
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: fixture.root } }, fixture.settings, logger,
    () => path.join(persistent, "sessions", "current"), () => persistent);
  service.saveSettings(fixture.settings.getBrowserSettingsView());
  const launch = service.prepareRuntimeLaunch();
  const child = spawn(binary, ["app-server", ...launch.args], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: "pipe" });
  const closed = once(child, "close");
  const pending = new Map();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (!pending.has(message.id)) return;
    const result = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(result.timer);
    if (message.error) result.reject(new Error(JSON.stringify(message.error)));
    else result.resolve(message.result);
  });
  t.after(async () => {
    for (const request of pending.values()) clearTimeout(request.timer);
    child.kill();
    const escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
    try { await closed; } finally { clearTimeout(escalation); lines.close(); }
  });
  function rpc(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 8000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  await rpc("initialize", { clientInfo: { name: "service-reliability-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const before = await rpc("config/read", { includeLayers: false });
  const activeBefore = before.config.mcp_servers[launch.managedServerName];
  assert.equal(before.config.mcp_servers["codex-element-browser"].enabled, false);
  assert.equal(activeBefore.env, undefined);
  fs.writeFileSync(configPath, `${source}\n[mcp_servers.manual]\ncommand="retained"\n`);
  await rpc("config/mcpServer/reload", null);
  const after = await rpc("config/read", { includeLayers: false });
  assert.equal(after.config.mcp_servers["codex-element-browser"].enabled, false);
  assert.deepEqual(after.config.mcp_servers[launch.managedServerName], activeBefore);
  assert.equal(after.config.mcp_servers.manual.command, "retained");
});

function integrations(home) {
  const { CodexIntegrationsService } = loadSource("src/codexIntegrationsService.ts", {
    vscode, "./platform": {},
  });
  const service = new CodexIntegrationsService({}, {
    listExistingProfileIds: () => [], ensureUserCodexHome: () => home,
  }, { requireProfileId: async () => "verified-user" }, {
    onDidChangeIntegrations: () => ({ dispose() {} }), isBackendRunning: () => false,
  }, logger);
  service.refresh = async () => ({});
  return service;
}

test("MCP failed staged remove/add preserves concurrent live edits without rollback", async (t) => {
  const home = temp(t);
  const config = path.join(home, "config.toml");
  const original = 'model = "keep"\n[mcp_servers.old]\ncommand = "old"\n';
  fs.writeFileSync(config, original);
  const service = integrations(home);
  service.runCli = async (args, stage) => {
    assert.notEqual(stage, home);
    assert(fs.existsSync(path.join(home, ".codex-element-mcp.lock")));
    if (args[1] === "remove") {
      fs.writeFileSync(path.join(stage, "config.toml"), 'model = "keep"\n');
      return {};
    }
    assert.equal(fs.readFileSync(config, "utf8"), original);
    fs.appendFileSync(config, "# concurrent editor\n");
    throw new Error("add failed");
  };
  await assert.rejects(service.saveMcpServer({ originalName: "old", name: "new", transport: "stdio", command: "new" }), /add failed/);
  assert.equal(fs.readFileSync(config, "utf8"), `${original}# concurrent editor\n`);
  assert.deepEqual(fs.readdirSync(home), ["config.toml"]);
});

test("MCP successful staging refuses to replace a concurrently created config", async (t) => {
  const home = temp(t);
  const config = path.join(home, "config.toml");
  const service = integrations(home);
  service.runCli = async (_args, stage) => {
    fs.writeFileSync(path.join(stage, "config.toml"), '[mcp_servers.new]\ncommand = "new"\n');
    fs.writeFileSync(config, 'model = "concurrent"\n');
  };
  await assert.rejects(service.saveMcpServer({ name: "new", transport: "stdio", command: "new" }), /другим процессом/);
  assert.equal(fs.readFileSync(config, "utf8"), 'model = "concurrent"\n');
});

test("MCP mutation lock serializes two service instances and retains both edits", async (t) => {
  const home = temp(t);
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, 'model = "keep"\n');
  let active = 0;
  let maximum = 0;
  const first = integrations(home);
  const second = integrations(home);
  for (const service of [first, second]) {
    service.runCli = async (args, stage) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 70));
      fs.appendFileSync(path.join(stage, "config.toml"), `[mcp_servers.${args[2]}]\ncommand = "tool"\n`);
      active -= 1;
    };
  }
  await Promise.all([first.saveMcpServer({ name: "first", transport: "stdio", command: "tool" }),
    second.saveMcpServer({ name: "second", transport: "stdio", command: "tool", enabled: false })]);
  assert.equal(maximum, 1);
  assert.match(fs.readFileSync(config, "utf8"), /mcp_servers.first/);
  assert.match(fs.readFileSync(config, "utf8"), /mcp_servers.second\]\nenabled = false/);
  await first.setMcpEnabled("first", false);
  const output = fs.readFileSync(config, "utf8");
  assert.match(output, /mcp_servers.first\]\nenabled = false/);
  assert.match(output, /mcp_servers.second\]\nenabled = false/);
});

test("MCP reserved browser paths cannot be persisted or toggled; UI status accepts only trusted current metadata", async (t) => {
  const home = temp(t);
  const service = integrations(home);
  service.runCli = async () => { throw new Error("CLI must not be invoked for reserved mutations"); };
  for (const name of ["codex-element-browser", "codex-element-browser-untrusted-session"]) {
    await assert.rejects(service.saveMcpServer({ name, transport: "stdio", command: "foreign" }), /браузер/);
    await assert.rejects(service.setMcpEnabled(name, true), /браузер/);
  }
  let current = { name: `codex-element-browser-${"a".repeat(32)}`, enabled: true, transport: "stdio", command: "trusted", args: [] };
  service.setManagedBrowserProvider(() => current);
  assert.equal(service.getSnapshot().mcpServers[0].name, current.name);
  assert.equal(service.getSnapshot().mcpServers[0].managed, "browser");
  current = undefined;
  assert.equal(service.getSnapshot().mcpServers.length, 0);
});

function tarArchive(content) {
  const header = Buffer.alloc(512);
  header.write("release/rg");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header[156] = 48;
  return zlib.gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
}

function ripgrepFixture(t, { probeOk = true, switchError = false, saveError = false } = {}) {
  const root = temp(t);
  const version = "14.2.0";
  const toolsRoot = path.join(root, "server", "tools", "ripgrep");
  const finalPath = path.join(toolsRoot, version, `${process.platform}-${process.arch}`, "rg");
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, "previous verified binary", { mode: 0o755 });
  const platform = process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const archive = tarArchive(Buffer.from("new binary"));
  const network = { request(url, _options, callback) {
    const request = new EventEmitter();
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      callback(response);
      const body = String(url).includes("api.github.com") ? Buffer.from(JSON.stringify({
        tag_name: `v${version}`, assets: [{ name: `rg-${arch}-${platform}.tar.gz`, browser_download_url: "https://fixture.invalid/rg" }],
      })) : archive;
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  } };
  let saved = false;
  const mockFs = { ...fs, promises: { ...fs.promises, async rename(from, to) {
    if (switchError && to === finalPath) throw new Error("sharing violation");
    return fs.promises.rename(from, to);
  } } };
  const { RipgrepInstallerService } = loadSource("src/ripgrepInstallerService.ts", {
    fs: mockFs, https: network, "./ripgrepUtils": {
      ripgrepExecutableName: () => "rg",
      probeRipgrepExecutable: async (candidate) => {
        assert.notEqual(candidate, finalPath);
        assert.equal(fs.readFileSync(candidate, "utf8"), "new binary");
        assert.equal(fs.readFileSync(finalPath, "utf8"), "previous verified binary");
        return { ok: probeOk, version, message: "probe rejected" };
      },
    },
  });
  const service = new RipgrepInstallerService({
    getConfigRoot: () => root, getRuntimeProxySettings: async () => ({}),
    saveInstalledRipgrepPath: (candidate) => {
      assert.equal(candidate, finalPath);
      if (saveError) throw new Error("settings write failed");
      saved = true;
    },
  }, logger);
  return { service, finalPath, toolsRoot, wasSaved: () => saved };
}

for (const failure of ["probe", "switch", "settings"]) {
  test(`ripgrep ${failure} failure keeps the previous installation usable`, async (t) => {
    const fixture = ripgrepFixture(t, { probeOk: failure !== "probe", switchError: failure === "switch", saveError: failure === "settings" });
    await assert.rejects(fixture.service.install({}));
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "previous verified binary");
    assert.equal(fixture.wasSaved(), false);
    assert(!fs.readdirSync(fixture.toolsRoot).some((name) => name.startsWith(".tmp-") || name === ".install.lock"));
  });
}

test("ripgrep verifies staging before atomic publication and retains a previous-version backup", async (t) => {
  const fixture = ripgrepFixture(t);
  const result = await fixture.service.install({});
  assert.equal(result.path, fixture.finalPath);
  assert.equal(fixture.wasSaved(), true);
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "new binary");
  assert.equal(fs.readFileSync(`${fixture.finalPath}.backup`, "utf8"), "previous verified binary");
});

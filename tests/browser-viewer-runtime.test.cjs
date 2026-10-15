const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const { test } = require("node:test");
const { loadSource, vscode, logger, root } = require("./service-test-utils.cjs");

test("managed runtime injects a private observer into its own page hook, rotates it and disables it with browser settings", async t => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "codex-view-runtime-"));
  t.after(() => fs.rmSync(scope, { recursive: true, force: true }));
  const events = [];
  let sequence = 0, enabled = true;
  const viewer = { stop() { events.push("stop"); }, startSession(value) {
    assert.equal(value, scope); events.push("start");
    return { socketPath: "private-pipe", token: `token-${++sequence}`, sessionId: `session-${sequence}` };
  } };
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: root } }, {}, logger, () => scope, undefined, undefined, viewer);
  service.resolveScopeRoot = () => scope;
  service.getSettingsView = () => ({ enabled, baseUrl: "http://example.test/applications/test", disableSandbox: false });
  service.resolveRuntime = () => ({ nodePath: "/node", launcherPath: "/mcp.js", browserExecutablePath: "/chrome", manifest: { platformId: "fixture" } });
  const launch = service.prepareRuntimeLaunch();
  assert(launch.managedServerName);
  assert(!JSON.stringify(launch).includes("token-"), "observer token never enters Codex CLI overrides");
  const config = JSON.parse(fs.readFileSync(path.join(scope, "browser/playwright-mcp.config.json"), "utf8"));
  assert.equal(config.browser.launchOptions.headless, true);
  assert(!config.browser.launchOptions.args.some(arg => arg.includes("remote-debugging")));
  const source = fs.readFileSync(config.browser.initPage[0], "utf8");
  assert.match(source, /token-1/);
  if (process.platform !== "win32") assert.equal(fs.statSync(config.browser.initPage[0]).mode & 0o777, 0o600);
  for (const brokenObserver of [false, true]) {
    const pageCalls = [];
    const exports = {};
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(compiled, { exports, console: { error() {} }, require(file) {
      assert.equal(file, pathToFileURL(path.join(root, "dist/browserViewerHook.js")).href);
      if (brokenObserver) throw new Error("observer unavailable");
      return { attachBrowserViewer(page, connection) { assert.equal(connection.sessionId, "session-1"); pageCalls.push("observe"); } };
    } });
    await exports.default({ page: { async setViewportSize() { pageCalls.push("viewport"); }, async goto(url) { pageCalls.push(url); } } });
    assert.deepEqual(pageCalls.slice(0, 2), ["viewport", "http://example.test/applications/test"]);
    assert.equal(pageCalls.includes("observe"), !brokenObserver);
  }
  service.prepareRuntimeLaunch();
  assert.match(fs.readFileSync(config.browser.initPage[0], "utf8"), /token-2/);
  enabled = false;
  assert(service.prepareRuntimeLaunch().disabledReason);
  assert.equal(events.at(-1), "stop");
  assert.equal(sequence, 2);
});

function runtimeFixture(t) {
  const { CodexRuntimeController } = loadSource("src/codexRuntimeController.ts", { vscode });
  const { StateStore } = loadSource("src/stateStore.ts", { vscode });
  let stops = 0;
  const runtime = new CodexRuntimeController({ state: new StateStore(), logger,
    onDidChange() {}, onDidStopRuntime() { stops++; } });
  runtime.processManager = { isRunning: false, pid: undefined, async stop() {}, dispose() {} };
  t.after(async () => { await runtime.stop(); runtime.dispose(); });
  return { runtime, stops: () => stops };
}

test("runtime stops the viewer immediately, before awaiting backend tree termination", async t => {
  const h = runtimeFixture(t);
  let release;
  h.runtime.processManager.stop = () => new Promise(resolve => { release = resolve; });
  const pending = h.runtime.stop();
  assert(h.stops() > 0);
  release(); await pending;
  h.runtime.processManager.stop = async () => {};
});

test("a failed runtime startup releases the viewer and clears the coalesced start", async t => {
  const h = runtimeFixture(t);
  h.runtime.startBackendSession = async () => { throw new Error("fixture start failure"); };
  await assert.rejects(h.runtime.ensureBackendProcess(), /fixture start failure/);
  assert.equal(h.stops(), 1);
  assert.equal(h.runtime.backendStartPromise, undefined);
});

test("runtime exit revokes the viewer even without a user stop", async t => {
  const h = runtimeFixture(t);
  h.runtime.handleExit(1, null);
  assert(h.stops() > 0);
});

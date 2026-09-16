const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { loadSource, vscode, logger } = require("./service-test-utils.cjs");

function harness(options = {}) {
  const events = [];
  const saved = [];
  let scope = "/user/project/session";
  const browser = {
    refreshApplication: async () => {}, getBrowserArtifactsRoot: () => scope,
    saveSettings: input => saved.push(input), getView: () => ({ enabled: false })
  };
  const mockVscode = {
    ...vscode,
    Uri: { ...vscode.Uri, joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
    workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showInputBox: async () => undefined, showWarningMessage: async () => undefined }
  };
  const { SettingsPanelManager } = loadSource("src/settingsPanelManager.ts", { ...options.mocks, vscode: mockVscode });
  const settings = {
    getProxySettingsView: async () => ({}), getDocsSettingsView: () => ({}), getToolsSettingsView: async () => ({}),
    saveDocsSourcePath() {}, saveDocsPaths() {}
  };
  const normalizer = {
    findBundledSourcePath: () => "/docs/help/ru", validateSourcePath: () => "", getDefaultOutputPath: () => "/normalized",
    normalize: async () => { throw new Error("fixture normalization failed"); }
  };
  const baseContext = {};
  const integrations = { onDidChange: () => ({ dispose() {} }), refresh: async () => {}, getSnapshot: () => ({}) };
  const manager = new SettingsPanelManager({ subscriptions: [], extensionUri: { fsPath: options.root || "/fixture-extension" }, extension: { packageJSON: { version: "test" } } }, settings, normalizer, {}, baseContext, integrations, browser, logger, async () => {}, options.experimentalContext);
  const panel = { webview: { postMessage: async event => { events.push(event); } } };
  const send = (command, payload) => manager.handleMessage(panel, { type: "command", command, payload });
  return { browser, saved, events, send, settings, normalizer, baseContext, integrations, mockVscode, manager, panel, changeScope: () => { scope = "/another-user/project/session"; } };
}

test("context settings validate webview input, report errors inline and publish verified state", async () => {
  const saves = [];
  const experimentalContext = {
    onDidChangeExperimentalContext: () => ({ dispose() {} }),
    getExperimentalContextView: () => ({ status: "ready", enabled: true }),
    refreshExperimentalContext: async () => ({ status: "ready" }),
    saveExperimentalContext: async (...args) => saves.push(args)
  };
  const h = harness({ experimentalContext });
  await h.send("settings.experimentalContext.save", { enabled: "true", scopeId: "a", revision: "b" });
  assert.equal(saves.length, 0);
  assert.equal(h.events.at(-1).scope, "experimentalContext");
  assert.equal(h.events.at(-1).event, "settings.error");
  await h.send("settings.experimentalContext.save", { enabled: true, scopeId: "a", revision: "b" });
  assert.deepEqual(saves, [[true, "a", "b"]]);
  assert.equal(h.events.at(-2).snapshot.experimentalContext.enabled, true);
  assert.equal(h.events.at(-1).event, "settings.saved");
  experimentalContext.refreshExperimentalContext = async () => ({ status: "error", message: "Нет подключения." });
  await h.send("settings.experimentalContext.refresh", {});
  assert.equal(h.events.at(-1).event, "settings.error");
  assert.equal(h.events.at(-1).scope, "experimentalContext");
});

test("browser save uses IDE URL without accepting a URL or network allowlist from the webview", async () => {
  const h = harness();
  await h.send("settings.browser.save", { enabled: true, disableSandbox: false, baseUrl: "http://old.example", allowedOrigins: ["http://old.example"] });
  assert.equal(h.saved.length, 1);
  assert.equal(JSON.stringify(h.saved[0]), JSON.stringify({ enabled: true, disableSandbox: false }));
  assert(h.events.some(event => event.event === "settings.saved" && event.scope === "browser"));
});

test("save errors are attributed to their own section, including thrown docs/proxy errors", async () => {
  const h = harness();
  h.browser.saveSettings = () => { throw new Error("Нет приложения IDE."); };
  h.settings.saveDocsNormalizedPath = () => { throw new Error("Нет доступа к каталогу."); };
  await h.send("settings.browser.save", { enabled: true, disableSandbox: false });
  await h.send("settings.docs.save", { normalizedPath: "/docs" });
  await h.send("settings.proxy.save", {});
  const errors = h.events.filter(event => event.event === "settings.error");
  assert.deepEqual(errors.map(event => event.scope), ["browser", "docs", "proxy"]);
  assert.match(errors[0].payload, /Нет приложения/);
});

test("identity change while resolving the application cannot save into the new user's preferences", async () => {
  const h = harness();
  h.browser.refreshApplication = async () => h.changeScope();
  await h.send("settings.browser.save", { enabled: true, disableSandbox: false });
  assert.equal(h.saved.length, 0);
  assert(h.events.some(event => event.event === "settings.error" && event.scope === "browser"));
});

test("browser can be disabled when Console is unavailable", async () => {
  const h = harness();
  h.browser.refreshApplication = async () => { throw new Error("must not request Console when disabling"); };
  await h.send("settings.browser.save", { enabled: false, disableSandbox: false });
  assert.equal(h.saved.length, 1);
  assert(!h.events.some(event => event.event === "settings.error"));
});

for (const scope of ["skills", "mcp"]) {
  test(`integration refresh returns a shared snapshot and completion scoped to ${scope}`, async () => {
    const h = harness();
    const refreshed = [];
    h.integrations.refresh = async force => { refreshed.push(force); };
    h.integrations.getSnapshot = () => ({ skills: ["fixture-skill"], mcpServers: ["fixture-mcp"] });
    await h.send("settings.integrations.refresh", { scope });
    assert.deepEqual(refreshed, [true]);
    assert.equal(h.events.length, 2);
    assert.equal(h.events[0].type, "settings.snapshot");
    assert.equal(h.events[0].scope, undefined, "snapshot shape remains unchanged");
    assert.deepEqual(h.events[0].snapshot.integrations, { skills: ["fixture-skill"], mcpServers: ["fixture-mcp"] });
    assert.equal(h.events[1].type, "event");
    assert.equal(h.events[1].event, "settings.saved");
    assert.equal(h.events[1].scope, scope);
    assert.equal(h.events[1].payload, scope === "skills" ? "Навыки обновлены." : "MCP-серверы обновлены.");
  });

  test(`integration refresh and snapshot failures are attributed to ${scope} without a success event`, async () => {
    for (const stage of ["refresh", "snapshot"]) {
      const h = harness();
      const refreshed = [];
      h.integrations.refresh = async force => {
        refreshed.push(force);
        if (stage === "refresh") throw new Error("Не удалось обновить интеграции.");
      };
      if (stage === "snapshot") h.integrations.getSnapshot = () => { throw new Error("Не удалось получить список интеграций."); };
      await h.send("settings.integrations.refresh", { scope });
      assert.deepEqual(refreshed, [true]);
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0].event, "settings.error");
      assert.equal(h.events[0].scope, scope);
      assert.equal(typeof h.events[0].payload, "string");
    }
  });
}

test("integration refresh restricts scope to skills or mcp and retains the legacy mcp default", async () => {
  const h = harness();
  let calls = 0;
  h.integrations.refresh = async force => { assert.equal(force, true); calls++; };
  const payloads = [undefined, null, {}, "skills", { scope: "docs" }, { scope: "browser" }, { scope: " skills " }, { scope: ["skills"] }, { scope: 1 }];
  for (const payload of payloads) {
    await h.send("settings.integrations.refresh", payload);
    assert.equal(h.events.at(-1).event, "settings.saved");
    assert.equal(h.events.at(-1).scope, "mcp");
  }
  assert.equal(calls, payloads.length);
  h.integrations.refresh = async () => { throw new Error("fixture refresh failure"); };
  await h.send("settings.integrations.refresh", { scope: "docs" });
  assert.equal(h.events.at(-1).event, "settings.error");
  assert.equal(h.events.at(-1).scope, "mcp");
});

test("confirmed MCP deletion emits the deleted name only after removal, retaining the existing success and snapshot", async () => {
  const h = harness();
  const removed = [];
  h.mockVscode.window.showWarningMessage = async (message, options, action) => {
    assert.equal(message, "Удалить MCP-сервер fixture-server?");
    assert.equal(options.modal, true);
    assert.equal(action, "Удалить");
    return action;
  };
  h.integrations.removeMcpServer = async name => {
    await Promise.resolve();
    assert.equal(h.events.length, 0, "no completion before removal settles");
    removed.push(name);
  };
  await h.send("settings.mcp.delete", { name: "fixture-server" });
  assert.deepEqual(removed, ["fixture-server"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.events[0])), {
    type: "event", event: "settings.mcp.deleted", payload: { name: "fixture-server" }
  });
  assert.equal(h.events[1].event, "settings.saved");
  assert.equal(h.events[1].scope, "mcp");
  assert.equal(h.events[2].type, "settings.snapshot");
  assert.equal(h.events.length, 3);
});

test("cancelled native MCP confirmation produces no event, snapshot or deletion", async () => {
  const h = harness();
  h.integrations.removeMcpServer = async () => assert.fail("must not delete after cancellation");
  h.integrations.getSnapshot = () => assert.fail("must not snapshot after cancellation");
  for (const confirmation of [undefined, "Отмена"]) {
    h.mockVscode.window.showWarningMessage = async () => confirmation;
    await h.send("settings.mcp.delete", { name: "fixture-server" });
  }
  assert.equal(h.events.length, 0);
});

test("failed MCP removal never emits deleted or success and keeps the mcp error scope", async () => {
  const h = harness();
  h.mockVscode.window.showWarningMessage = async () => "Удалить";
  h.integrations.removeMcpServer = async () => { throw new Error("Не удалось удалить MCP-сервер."); };
  await h.send("settings.mcp.delete", { name: "fixture-server" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.events)), [{
    type: "event", event: "settings.error", scope: "mcp", payload: "Не удалось удалить MCP-сервер."
  }]);
});

test("documentation snapshot contains exactly the service view, without invented counts", async () => {
  const h = harness();
  const docs = { sourcePath: "/docs/help/ru", normalizedPath: "/normalized", validationMessage: "" };
  h.settings.getDocsSettingsView = () => docs;
  await h.manager.postSnapshot(h.panel);
  assert.deepEqual(h.events[0].snapshot.docs, docs);
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-panel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("snapshot reads the bundled Codex release version, not the extension version or a runtime probe", async t => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "runtime-manifest.json"), JSON.stringify({ version: "0.153.4", files: [] }));
  const h = harness({ root });
  await h.manager.postSnapshot(h.panel);
  const snapshot = h.events[0].snapshot;
  assert.equal(snapshot.extensionVersion, "test");
  assert.equal(snapshot.system.platformId, `${process.platform}-${process.arch}`);
  assert.equal(snapshot.system.codexVersion, "0.153.4");
  assert.deepEqual(Object.keys(snapshot.system).sort(), ["codexVersion", "platformId"]);
  assert(snapshot.docs && snapshot.tools && snapshot.browser && snapshot.integrations);
});

test("missing, invalid, unreadable and oversized release metadata leave a usable snapshot with an empty version", async t => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, "bin"));
  const manifest = path.join(root, "bin", "runtime-manifest.json");
  const h = harness({ root });
  for (const content of [undefined, "{broken", "null", "[]", "{}", '{"version":123}', " ".repeat(65537)]) {
    if (content !== undefined) fs.writeFileSync(manifest, content);
    await h.manager.postSnapshot(h.panel);
    assert.equal(h.events.at(-1).snapshot.system.codexVersion, "");
    assert.equal(h.events.at(-1).snapshot.system.platformId, `${process.platform}-${process.arch}`);
  }
  const denied = harness({ root, mocks: { fs: { promises: { stat: async () => { throw new Error("access denied"); } } } } });
  await denied.manager.postSnapshot(denied.panel);
  assert.equal(denied.events[0].snapshot.system.codexVersion, "");
});

test("browser view exposes only the optional installed manifest Chromium version and handles missing runtime", t => {
  const root = temporaryRoot(t);
  const runtimeRoot = path.join(root, "browser", `${process.platform}-${process.arch}`);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  const service = new BrowserRuntimeService({ extensionUri: { fsPath: root } }, {}, logger);
  assert.equal(service.getView().chromiumVersion, "");
  assert.equal(service.getView().status, "notInstalled");
  for (const file of ["node", "launcher.js", "chromium"]) {
    fs.writeFileSync(path.join(runtimeRoot, file), "fixture runtime header", { mode: 0o755 });
  }
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const manifest = {
    schemaVersion: 1, platformId: `${process.platform}-${process.arch}`, playwrightMcpVersion: "0.0.78", nodeVersion: "v20.20.2",
    nodePath: "node", launcherPath: "launcher.js", browserExecutablePath: "chromium"
  };
  for (const chromiumVersion of [undefined, "151.0.7922.10", 151, null, ""]) {
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, chromiumVersion }));
    const view = service.getView();
    assert.equal(view.status, "ready");
    assert.equal(view.chromiumVersion, typeof chromiumVersion === "string" ? chromiumVersion : "");
  }
  fs.writeFileSync(manifestPath, "{broken");
  assert.equal(service.getView().status, "error");
  assert.equal(service.getView().chromiumVersion, "");
});

test("base context commands use dedicated payloads and never pass a webview path to the service", async () => {
  const h = harness();
  h.baseContext.readBaseContext = async (...args) => {
    assert.equal(args.length, 0);
    return { text: "rules", sourcePath: "/bundled/rules.md", revision: "read-revision" };
  };
  h.baseContext.saveBaseContext = async (...args) => {
    assert.deepEqual(args, ["updated", "read-revision"]);
    return "saved-revision";
  };
  await h.send("settings.docs.baseContext.read", { sourcePath: "/untrusted" });
  await h.send("settings.docs.baseContext.save", { text: "updated", revision: "read-revision", sourcePath: "/untrusted", path: "/ignored" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.events)), [
    { type: "event", event: "settings.docs.baseContext.loaded", payload: { text: "rules", sourcePath: "/bundled/rules.md", revision: "read-revision" } },
    { type: "event", event: "settings.docs.baseContext.saved", payload: { revision: "saved-revision", message: "Базовый контекст сохранен." } }
  ]);
  let opened = false;
  h.baseContext.openBaseContextFile = async () => { opened = true; };
  await h.send("settings.docs.openBaseContext");
  assert(opened);
});

test("invalid base context payloads and service failures settle only the dedicated base context error channel", async () => {
  const h = harness();
  h.baseContext.readBaseContext = async () => { throw new Error("Недостаточно прав для чтения."); };
  h.baseContext.saveBaseContext = async () => { throw new Error("Базовый контекст изменился после загрузки."); };
  await h.send("settings.docs.baseContext.read");
  for (const payload of [undefined, {}, { text: 1, revision: "r" }, { text: "rules" }, { text: "rules", revision: "old" }]) {
    await h.send("settings.docs.baseContext.save", payload);
  }
  assert.equal(h.events.length, 6);
  assert(h.events.every(event => event.type === "event" && event.event === "settings.docs.baseContext.error" && typeof event.payload === "string"));
  assert.match(h.events[0].payload, /Недостаточно прав/);
  assert.match(h.events.at(-1).payload, /изменился/);
});

test("settings icon preload precedes the app in external and executable inline fallback HTML", () => {
  let options;
  const h = harness({ mocks: { "./webviewHtml": { renderWebviewHtml(value) { options = value; return "fixture"; } } } });
  h.panel.webview.onDidReceiveMessage = () => ({ dispose() {} });
  h.panel.onDidDispose = () => ({ dispose() {} });
  h.manager.setupPanel(h.panel);
  assert.deepEqual(Array.from(options.preloadScriptPaths), ["media/settings-icons.js"]);
  const scripts = {
    "settings-icons.js": "window.lucide = { fixture: true };",
    "settings.js": "window.appSawLucide = window.lucide.fixture; window.__codexElementAppReady = true;",
    "settings.css": "body { margin: 0; }"
  };
  const { renderWebviewHtml } = loadSource("src/webviewHtml.ts", {
    vscode: h.mockVscode, fs: { readFileSync: file => scripts[path.basename(file)] }
  });
  const html = renderWebviewHtml({ ...options, webview: { cspSource: "fixture:", asWebviewUri: uri => ({ toString: () => `fixture:${uri.fsPath}` }) } });
  assert(html.indexOf('src="fixture:/fixture-extension/media/settings-icons.js"') < html.indexOf('src="fixture:/fixture-extension/media/settings.js"'));
  const fallback = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const window = { setTimeout() {} };
  vm.runInNewContext(fallback, { window, document: { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } } });
  window.__codexElementRunInlineFallback();
  assert.equal(window.appSawLucide, true);
  assert.equal(window.__codexElementWebviewAssetMode, "inline fallback");
});

test("normalization cancellation resets progress and preserves the existing docs completion scope", async () => {
  const h = harness();
  h.normalizer.findBundledSourcePath = () => undefined;
  h.manager.normalizerProgress = { status: "running", percent: 10, stage: "running", message: "running" };
  await h.send("settings.docs.normalize", {});
  const progress = h.events.find(event => event.event === "settings.docs.normalize.progress").payload;
  assert.equal(progress.status, "idle");
  assert.equal(progress.stage, "cancelled");
  assert.equal(h.events.at(-1).event, "settings.saved");
  assert.equal(h.events.at(-1).scope, "docs");
  assert.match(h.events.at(-1).payload, /отменена/);
  await h.manager.postSnapshot(h.panel);
  assert.equal(h.events.at(-1).snapshot.normalizer.status, "idle");
});

test("successful normalization retains paths, completed progress and the docs-only settings notification", async () => {
  const h = harness();
  const savedPaths = [];
  const changes = [];
  h.settings.saveDocsPaths = (...args) => savedPaths.push(args);
  h.manager.onSettingsChanged = async options => changes.push(options);
  h.normalizer.normalize = async ({ sourcePath, outputPath, onProgress }) => {
    onProgress({ status: "completed", percent: 100, stage: "complete", message: "complete" });
    return { sourcePath, outputPath, pageCount: 7 };
  };
  await h.send("settings.docs.normalize", { normalizedPath: "/custom-normalized" });
  assert.deepEqual(savedPaths, [["/docs/help/ru", "/custom-normalized"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ restartRuntime: false, docsChanged: true }]);
  assert(h.events.some(event => event.event === "settings.saved" && event.scope === "docs" && event.payload.includes("7")));
  assert.equal(h.events.at(-1).snapshot.normalizer.status, "completed");
});

for (const stage of ["discovery", "prompt", "validation", "settings", "worker", "after-progress", "after-completion"]) {
  test(`normalization ${stage} error always clears running progress with the existing docs error scope`, async () => {
    const h = harness();
    const fail = () => { throw new Error("fixture normalization failure"); };
    if (stage === "discovery") h.normalizer.findBundledSourcePath = fail;
    if (stage === "prompt") {
      h.normalizer.findBundledSourcePath = () => undefined;
      h.mockVscode.window.showInputBox = fail;
    }
    if (stage === "validation") h.normalizer.validateSourcePath = () => "Некорректный источник.";
    if (stage === "settings") h.settings.saveDocsSourcePath = fail;
    if (stage === "after-progress") h.normalizer.normalize = async ({ onProgress }) => {
      onProgress({ status: "running", percent: 10, stage: "running", message: "running" });
      fail();
    };
    if (stage === "after-completion") {
      h.normalizer.normalize = async ({ sourcePath, outputPath, onProgress }) => {
        onProgress({ status: "completed", percent: 100, stage: "complete", message: "complete" });
        return { sourcePath, outputPath, pageCount: 7 };
      };
      h.manager.onSettingsChanged = fail;
    }
    await h.send("settings.docs.normalize", {});
    const progress = h.events.filter(event => event.event === "settings.docs.normalize.progress").at(-1).payload;
    assert.equal(progress.status, "error");
    assert.equal(progress.stage, "error");
    assert.equal(h.events.at(-1).event, "settings.error");
    assert.equal(h.events.at(-1).scope, "docs");
    await h.manager.postSnapshot(h.panel);
    assert.equal(h.events.at(-1).snapshot.normalizer.status, "error");
  });
}

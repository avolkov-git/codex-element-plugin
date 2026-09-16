const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, vscode, logger } = require("./service-test-utils.cjs");
const consoleApi = loadSource("src/elementConsoleClient.ts");

function harness(t, options = {}) {
  const connection = { server: "http://internal:9090/console", clientId: "ide-client", clientSecret: "secret", projectId: "project-a", applicationId: "app-a", externalUri: "https://external.example/console" };
  let changed;
  const calls = [];
  const logs = [];
  const vs = { ...vscode, workspace: { onDidChangeConfiguration(fn) { changed = fn; return { dispose() {} }; } } };
  const { ElementApplicationService } = loadSource("src/elementApplicationService.ts", { vscode: vs, "./elementConsoleClient": consoleApi });
  const app = { id: "app-a", name: "demo", uri: "https://external.example/applications/demo", "project-id": "project-a" };
  const request = async (...args) => {
    calls.push(args);
    return options.request ? options.request(...args) : args[1] === "POST" ? { id_token: "test-token" } : { ...app };
  };
  const service = new ElementApplicationService({ info: s => logs.push(s), warn: s => logs.push(s) }, () => connection, request,
    options.page || (async () => "https://external.example:8443/ide/api/v1/current?session=never-forward"));
  t.after(() => service.dispose());
  return { service, connection, calls, app, logs, change: key => changed({ affectsConfiguration: k => k === key }) };
}

test("application uses the bundle Console endpoint and public IDE origin, without MCP or opening a browser", async t => {
  const h = harness(t);
  assert.equal(h.service.getView().status, "idle");
  assert.equal(h.calls.length, 0, "lookup stays lazy");
  const [first, second] = await Promise.all([h.service.resolve(), h.service.resolve()]);
  assert.equal(first.status, "ready");
  assert.equal(first.url, h.app.uri);
  assert.equal(second.url, first.url);
  assert.equal(h.calls.length, 2, "concurrent lookups share token and application requests");
  const [url, method, headers] = h.calls[1];
  assert.equal(url.toString(), "http://internal:9090/console/api/v2/applications/app-a");
  assert.equal(method, "GET");
  assert.equal(headers["X-Forwarded-Host"], "external.example:8443");
  assert.equal(headers["X-Forwarded-Proto"], "https");
  assert.equal(headers.Authorization, "Bearer test-token");
  await h.service.resolve();
  assert.equal(h.calls.length, 2);
  assert(!h.logs.join(" ").includes("secret"));
  assert(!JSON.stringify(headers).includes("never-forward"));
});

test("application changes invalidate the URL even when the history project stays the same", async t => {
  const h = harness(t);
  await h.service.resolve();
  h.connection.applicationId = "app-b";
  assert.equal(h.service.getView().url, "");
  h.app.id = "app-b";
  h.app.uri = "https://external.example/applications/new-deployment";
  assert.equal((await h.service.resolve()).url, h.app.uri);
  h.change("1C.clientSecret");
  assert.equal(h.service.getView().url, "");
});

test("late responses from the previous IDE application cannot become the browser target", async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness(t, { request: async (url, method) => {
    if (method === "POST") return { id_token: "token" };
    if (url.pathname.endsWith("app-a")) { entered(); return new Promise(resolve => { release = resolve; }); }
    return { id: "app-b", uri: "https://example.com/applications/b" };
  } });
  const old = h.service.resolve();
  await started;
  h.connection.applicationId = "app-b";
  h.change("1C.applicationId");
  const current = await h.service.resolve();
  release({ id: "app-a", uri: "https://example.com/applications/a" });
  assert.notEqual((await old).status, "ready");
  assert.equal(h.service.getView().url, current.url);
});

test("missing application, mismatched id/project and invalid URLs are reported without stale fallback", async t => {
  const h = harness(t);
  await h.service.resolve();
  for (const patch of [
    { id: "wrong", uri: h.app.uri },
    { id: "app-a", uri: "javascript:alert(1)" },
    { uri: "https://user:password@example.com/app" },
    { uri: "https://example.com/app", "project-id": "other-project" },
    { uri: "", "project-id": "project-a" }
  ]) {
    Object.assign(h.app, patch);
    assert.equal((await h.service.resolve(true)).status, "error");
    assert.equal(h.service.getView().url, "");
  }
  h.connection.applicationId = "";
  const count = h.calls.length;
  assert.match((await h.service.resolve()).message, /1C.applicationId/);
  assert.equal(h.calls.length, count);
});

test("explicit external URI is used when the bundle page-location command is unavailable", async t => {
  const h = harness(t, { page: async () => { throw new Error("command unavailable"); } });
  assert.equal((await h.service.resolve()).status, "ready");
  assert.equal(h.calls[1][2]["X-Forwarded-Host"], "external.example");
});

test("application lookup refreshes an expired token once; HTTP 403 is not retried", async t => {
  let count = 0;
  const h = harness(t, { request: async (_url, method) => {
    if (method === "POST") return { id_token: "token" };
    if (++count === 1) throw new consoleApi.ElementConsoleError("application", "http_status", "Expired", "", 401);
    return { id: "app-a", uri: "http://example.com/applications/a" };
  } });
  assert.equal((await h.service.resolve()).status, "ready");
  assert.equal(h.calls.length, 4);
  const denied = harness(t, { request: async (_url, method) => {
    if (method === "POST") return { id_token: "token" };
    throw new consoleApi.ElementConsoleError("application", "http_status", "Console: HTTP 403", "", 403);
  } });
  assert.equal((await denied.service.resolve()).status, "error");
  assert.equal(denied.calls.length, 2);
});

test("legacy browser URLs and allowlists are ignored, and missing IDE URL never falls back to them", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-test-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const persistent = path.join(root, "user", "project");
  fs.mkdirSync(persistent, { recursive: true });
  const file = path.join(persistent, "browser-settings.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, baseUrl: "http://stale.example/app", allowedOrigins: ["http://stale.example"], disableSandbox: false }));
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts", { vscode });
  let app = { status: "ready", url: "https://current.example/applications/demo", name: "Demo", message: "" };
  const service = new BrowserRuntimeService({}, { getConfigRoot: () => root }, logger,
    () => path.join(persistent, "sessions", "test"), () => persistent, { getView: () => app });
  assert.equal(service.getSettingsView().baseUrl, app.url);
  assert.equal(service.getSettingsView().allowedOrigins.length, 0);
  app = { status: "error", url: "", name: "", message: "Console не вернула адрес." };
  assert.equal(service.getSettingsView().baseUrl, "");
  assert.throws(() => service.saveSettings({ enabled: true, disableSandbox: false }), /Console/);
  assert.match(service.prepareRuntimeLaunch().disabledReason, /Console/);
  service.saveSettings({ enabled: false, disableSandbox: false });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved, { schemaVersion: 2, enabled: false, disableSandbox: false });
});

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/elementMcpIdeBridgeService.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  fileName: filename,
}).outputText;
const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const APP_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const APP_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ENV = "ELEMENT_IDE_MCP_SESSION_TOKEN";
const SESSION = "x-element-ide-session";
const CONTROL = "x-element-ide-control";
const plain = (value) => JSON.parse(JSON.stringify(value));
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function waitFor(predicate, message = "condition did not become true") {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class FakeClock {
  now = 0;
  timers = new Set();
  setTimeout = (callback, delay) => {
    const timer = { callback, at: this.now + delay, unref() {} };
    this.timers.add(timer);
    return timer;
  };
  clearTimeout = (timer) => this.timers.delete(timer);
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      this.timers.delete(due);
      due.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

async function fixture(t, host = "127.0.0.1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-session-test-"));
  const rootB = path.join(root, "other-workspace");
  fs.mkdirSync(rootB);
  const f = {
    root: await fs.promises.realpath(root), rootB: await fs.promises.realpath(rootB), calls: [], sessions: [], managers: [],
    csrf: "synthetic-csrf-token", version: "0.23.0", createCode: 201, hook: undefined, mutateCreate: (value) => value,
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = { path: req.url, method: req.method, headers: req.headers, body };
    f.calls.push(call);
    if (f.hook?.(call, res)) return;
    if (req.url === "/api/status") return json(res, { server: { state: "running", version: f.version } });
    if (req.url === "/") return res.end(`<meta name="element-mcp-token" content="${f.csrf}">`);
    assert(req.url.startsWith("/api/integrations/ide-sessions"), "must never use global handoff or unbound MCP");
    if (req.headers["x-element-mcp-token"] !== f.csrf) return json(res, { message: "synthetic-client-secret" }, 403);
    if (req.url === "/api/integrations/ide-sessions") {
      assert.equal(req.method, "POST");
      assert.equal(Number(req.headers["content-length"]), Buffer.byteLength(body));
      const payload = JSON.parse(body);
      const scope = {
        status: "ready", session_id: crypto.randomUUID(), project_id: payload.project_id,
        application_id: payload.application_id, workspace_folders: payload.workspace_folders, expires_in_seconds: 180,
      };
      const session = {
        scope, payload, mcp: crypto.randomBytes(32).toString("base64url"),
        control: crypto.randomBytes(32).toString("base64url"), revoked: false,
      };
      f.sessions.push(session);
      return json(res, f.mutateCreate({
        protocol_version: 1, ...scope, mcp_header: "X-Element-IDE-Session", mcp_token: session.mcp,
        control_header: "X-Element-IDE-Control", control_token: session.control,
        lease_seconds: 180, renew_after_seconds: 60,
      }), f.createCode);
    }
    const session = f.sessions.find((item) => req.url.endsWith(`/${item.scope.session_id}`));
    if (!session || session.revoked || req.headers[CONTROL] !== session.control) return json(res, {}, 401);
    assert.equal(req.headers[SESSION], undefined);
    if (req.method === "DELETE") {
      assert.equal(body, "");
      session.revoked = true;
      return json(res, { status: "revoked", session_id: session.scope.session_id });
    }
    assert.equal(req.method, "POST");
    assert.equal(Number(req.headers["content-length"]), Buffer.byteLength(body));
    assert(Object.keys(JSON.parse(body)).every((key) => key === "git_status"));
    json(res, { ...session.scope, lease_seconds: 180, renew_after_seconds: 60 });
  });
  server.listen(0, host);
  await once(server, "listening");
  f.url = `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}/mcp`;
  f.createCalls = () => f.calls.filter((call) => call.path === "/api/integrations/ide-sessions");
  f.renewCalls = () => f.calls.filter((call) => call.method === "POST" && call.path !== "/api/integrations/ide-sessions");
  f.deleteCalls = () => f.calls.filter((call) => call.method === "DELETE");
  t.after(async () => {
    for (const manager of f.managers) await manager.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

function windowManager(f, overrides = {}) {
  const time = new FakeClock();
  const config = {
    server: "https://console.example/console", clientId: "synthetic-client-id", clientSecret: "synthetic-client-secret",
    projectId: PROJECT_A, applicationId: APP_A, ...overrides,
  };
  const settings = { elementMcpUrl: f.url };
  const configChanges = new Emitter(), folderChanges = new Emitter();
  const folders = [{ uri: { scheme: "file", fsPath: f.root } }];
  const logs = [], events = [];
  const state = { targets: [{ name: "element", url: f.url, enabled: true }], stops: 0, targetReads: 0 };
  const vscode = {
    EventEmitter: Emitter,
    workspace: {
      workspaceFolders: folders,
      getConfiguration: (section) => ({
        get: (key, fallback) => (section === "1C" ? config : settings)[key] ?? fallback,
      }),
      onDidChangeConfiguration: configChanges.event, onDidChangeWorkspaceFolders: folderChanges.event,
    },
    commands: { executeCommand: async () => ({ branchName: "main", modified: false, arbitrarySecret: "never-copy" }) },
  };
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: (name) => name === "vscode" ? vscode
      : name === "perf_hooks" ? { performance: { now: () => time.now } } : localRequire(name),
    Buffer, URL, process, Error, Date, console, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
  }, { filename });
  const manager = new module.exports.ElementMcpIdeBridgeService({
    info: (message) => logs.push(message), warn: (message) => logs.push(message),
  });
  manager.configure({
    getTargets: async () => { state.targetReads++; return state.targets; },
    onInvalidate: () => { state.stops++; },
  });
  manager.onDidChange((value) => events.push(value));
  f.managers.push(manager);
  return {
    manager, time, config, settings, folders, logs, events, state, vscode, configChanges, folderChanges,
    prepare: () => manager.prepareRuntimeLaunch(() => true),
  };
}

function toolCaller(session, changes = {}) {
  return async (name, args) => {
    assert.deepEqual(plain(args), {});
    const value = name === "get_managed_actions_status" ? {
      workspace_scope: session.scope, can_prepare: false, migration_required: true,
    } : {
      status: "ready", application: { id: session.scope.application_id },
      ide_project_id: session.scope.project_id, application_project_id: session.scope.project_id,
      matches_ide_project: true,
      connection: { source: "ide_session", project_id: session.scope.project_id, application_id: session.scope.application_id },
    };
    return { structuredContent: { ...value, ...changes[name] } };
  };
}
function disabled(launch, names) {
  assert.deepEqual(plain(launch.env), {});
  assert.deepEqual(plain(launch.args), [
    "-c", `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={"enabled"=false}`).join(",")}}`,
  ]);
  assert.equal(launch.verify, undefined);
}
function assertPrivate(w, f, extra = "") {
  const publicText = JSON.stringify([w.logs, w.events, w.manager.getView(), extra]);
  for (const secret of [w.config.clientId, w.config.clientSecret, w.config.accessToken, f.csrf,
    ...f.sessions.flatMap((session) => [session.mcp, session.control])].filter(Boolean)) {
    assert(!publicText.includes(secret), "secret appeared in a public value");
  }
}

test("no target means no activation traffic, timers, defaults, or command overrides", async (t) => {
  const f = await fixture(t);
  const w = windowManager(f);
  assert.equal(w.time.timers.size, 0);
  for (const targets of [[], [{ ...w.state.targets[0], enabled: false }]]) {
    w.state.targets = targets;
    const launch = await w.prepare();
    assert.deepEqual(plain(launch), { args: [], env: {} });
    await w.time.advance(600_000);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(w.state.stops, 0);
});

test("protocol v1 pins exact URL in one partial root table; only private env contains transport token", async (t) => {
  const f = await fixture(t);
  const w = windowManager(f);
  w.state.targets[0].name = "element-test_name";
  const hostEnvironment = process.env[ENV];
  const launch = await w.prepare();
  const session = f.sessions[0];
  assert.deepEqual(f.calls.map((call) => call.path), ["/api/status", "/", "/api/integrations/ide-sessions"]);
  assert.equal(session.payload.protocol_version, 1);
  assert.equal(session.payload.project_id, PROJECT_A);
  assert.equal(session.payload.application_id, APP_A);
  assert.deepEqual(session.payload.workspace_folders, [f.root]);
  assert.deepEqual(session.payload.git_status, { branchName: "main", modified: false });
  assert.equal(session.payload.verify_tls, true);
  const key = JSON.stringify(w.state.targets[0].name);
  assert.deepEqual(plain(launch.args), [
    "-c", `mcp_servers={${key}={"url"=${JSON.stringify(f.url)},"env_http_headers"={"X-Element-IDE-Session"="${ENV}"}}}`,
    "-c", `shell_environment_policy.set.${ENV}=""`,
  ]);
  assert.deepEqual(plain(launch.env), { [ENV]: session.mcp });
  assert.equal(process.env[ENV], hostEnvironment);
  assert(!launch.args.join(" ").includes(session.mcp));
  assert.equal(w.manager.getView().status, "connecting");
  await launch.verify(toolCaller(session));
  assert.equal(w.manager.getView().status, "ready");
  assert.equal(w.manager.getView().canPrepare, false);
  assert.equal(w.manager.getView().migrationRequired, true);
  assertPrivate(w, f, launch.args);
});

test("independent windows and same-application windows always get independent capabilities", async (t) => {
  const f = await fixture(t);
  const a = windowManager(f);
  const b = windowManager(f, { projectId: PROJECT_B, applicationId: APP_B });
  b.folders[0].uri.fsPath = f.rootB;
  const c = windowManager(f);
  const launches = await Promise.all([a.prepare(), b.prepare(), c.prepare()]);
  assert.equal(new Set(launches.map((launch) => launch.env[ENV])).size, 3);
  for (const [index, w] of [a, b, c].entries()) {
    const session = f.sessions.find((s) => s.mcp === launches[index].env[ENV]);
    await launches[index].verify(toolCaller(session));
    assert.equal(w.manager.getView().applicationId, w.config.applicationId);
    assert.deepEqual(session.scope.workspace_folders, [w.folders[0].uri.fsPath]);
  }
  await a.manager.close();
  assert.equal(f.sessions.filter((session) => session.revoked).length, 1);
  assert.equal(b.manager.getView().status, "ready");
  assert.equal(c.manager.getView().status, "ready");
});

test("runtime restart reuses the live token but must verify scope again; stale verifier cannot stop replacement", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const first = await w.prepare();
  await first.verify(toolCaller(f.sessions[0]));
  const next = await w.prepare();
  assert.equal(next.env[ENV], first.env[ENV]);
  assert.equal(f.createCalls().length, 1);
  assert.equal(w.manager.getView().status, "connecting");
  await assert.rejects(first.verify(async () => assert.fail("stale launch called a tool")), /отменена/);
  assert.equal(w.state.stops, 0);
  await next.verify(toolCaller(f.sessions[0]));
  assert.equal(w.manager.getView().status, "ready");
});

test("duplicate targets and reserved persisted headers fail closed without HTTP", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets.push({ ...w.state.targets[0], name: "duplicate" });
  disabled(await w.prepare(), ["element", "duplicate"]);
  assert.match(w.manager.getView().message, /несколько/);
  w.state.targets.pop();
  w.state.targets[0].sessionHeaderConfigured = true;
  disabled(await w.prepare(), ["element"]);
  assert.match(w.manager.getView().message, /сохранённые/);
  assert.equal(f.calls.length, 0);
  assert.equal(w.state.stops, 0, "failed create must not stop unrelated runtime capabilities");
});

for (const url of [
  "http://example.com:9900/mcp", "ftp://127.0.0.1:9900/mcp", "http://user:secret@127.0.0.1:9900/mcp",
  "http://127.0.0.1:9900/mcp?token=private", "http://127.0.0.1:9900/custom", "http://127.0.0.1:9900/mcp#fragment",
  "http://127.0.0.1:9900/custom/../mcp", "http://127.0.0.1:1/mcp", "not-a-url",
]) {
  test(`reject unsafe or nonmatching endpoint ${url}`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    w.state.targets[0].url = url;
    disabled(await w.prepare(), ["element"]);
    assert.equal(f.calls.length, 0);
    assert.equal(w.manager.getView().status, "error");
    assertPrivate(w, f);
  });
}

test("bracketed IPv6 loopback is accepted, and config endpoint aliases compare canonically", async (t) => {
  const f = await fixture(t, "::1"), w = windowManager(f);
  w.settings.elementMcpUrl = f.url.replace("[::1]", "localhost");
  const launch = await w.prepare();
  assert.equal(launch.env[ENV], f.sessions[0].mcp);
  assert(launch.args.some((arg) => arg.includes(`"url"=${JSON.stringify(f.url)}`)));
});

test("trailing /mcp/ is accepted and pinned exactly, including loopback aliases", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.settings.elementMcpUrl = `${f.url.replace("127.0.0.1", "localhost")}/`;
  w.state.targets[0].url = `${f.url}/`;
  const launch = await w.prepare();
  assert.equal(launch.env[ENV], f.sessions[0].mcp);
  assert(launch.args.some((arg) => arg.includes(`"url"=${JSON.stringify(`${f.url}/`)}`)));
});

test("default port 9900 is enforced without contacting a different configured target", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  delete w.settings.elementMcpUrl;
  disabled(await w.prepare(), ["element"]);
  assert.equal(f.calls.length, 0);
});

for (const missing of ["projectId", "applicationId", "server", "clientId", "clientSecret"]) {
  test(`missing official ${missing} never falls back to folder metadata or global context`, async (t) => {
    const f = await fixture(t), w = windowManager(f, { [missing]: "" });
    disabled(await w.prepare(), ["element"]);
    assert.equal(f.calls.length, 0);
    assert.equal(w.manager.getView().projectId, undefined);
  });
}

test("workspace folders must be local, existing directories; symlinks and duplicates are canonicalized", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const original = w.folders[0];
  for (const folders of [
    [], [{ uri: { scheme: "https", fsPath: f.root } }],
    [{ uri: { scheme: "file", fsPath: path.join(f.root, "missing") } }],
    Array.from({ length: 17 }, () => original),
  ]) {
    w.vscode.workspace.workspaceFolders = folders;
    disabled(await w.prepare(), ["element"]);
  }
  assert.equal(f.calls.length, 0);
  fs.symlinkSync(f.rootB, path.join(f.root, "alias"));
  w.vscode.workspace.workspaceFolders = [
    { uri: { scheme: "file", fsPath: f.rootB } },
    { uri: { scheme: "file", fsPath: path.join(f.root, "alias") } },
  ];
  await w.prepare();
  assert.deepEqual(f.sessions[0].payload.workspace_folders, [f.rootB]);
});

for (const version of ["0.22.99", "0.23.0rc1", "0.23.0-beta", "", null, 23, "future"]) {
  test(`actual unsupported or unknown version ${version} does not create or fall back`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.version = version;
    disabled(await w.prepare(), ["element"]);
    assert.equal(f.calls.length, 1);
    assert.match(w.manager.getView().message, /0.23.0/);
  });
}

for (const code of [200, 202, 204, 301, 400, 401, 403, 404, 413, 426, 502]) {
  test(`create requires exactly 201, not HTTP ${code}; raw error bodies never reach UI`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.createCode = code;
    f.mutateCreate = (value) => ({ ...value, message: `LEAK-MARKER ${value.mcp_token} ${w.config.clientSecret}` });
    disabled(await w.prepare(), ["element"]);
    assert.equal(w.manager.getView().status, "error");
    assertPrivate(w, f);
    assert(!JSON.stringify(w.events).includes("LEAK-MARKER"));
    assert.equal(w.state.stops, 0);
    await w.manager.close();
    if (code !== 204) assert(f.sessions[0].revoked, "allocated session should be revoked even when status is invalid");
  });
}

for (const [message, expected] of [
  ["Workspace folder не существует или недоступен серверу MCP: F:\\private-path\\synthetic-client-secret", /MCP не видит папку workspace/],
  ["Console не подтвердила связь application_id с project_id текущей IDE", /ошибка чтения приложения также/],
  ["Достигнут лимит IDE-сессий; закройте неиспользуемые подключения", /Достигнут лимит/],
  ["Требуется protocol_version=1; обновите плагин", /не принял формат/],
  ["Неизвестные поля IDE-контекста", /не принял формат/],
  ["IDE должна передать корректные project_id и application_id", /не принял идентификаторы/],
  ["IDE должна передать непустой workspace_folders", /не принял список папок/],
  ["workspace_folders должен быть массивом не более 16 путей", /не принял список папок/],
  ["Каждый workspace folder должен быть непустым локальным путём", /не принял список папок/],
  ["Некорректное поле git_status.modified", /не принял сводку/],
  ["git_status контекста IDE должен быть объектом", /не принял сводку/],
  ["Файл CA bundle не найден: F:\\private-path\\synthetic-client-secret.pem", /не нашёл файл сертификатов/],
]) {
  test(`create 400 explains known validation failure without exposing remote data: ${expected}`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.hook = (call, res) => {
      if (call.path !== "/api/integrations/ide-sessions") return false;
      json(res, { status: "invalid", message, extra: "LEAK-MARKER" }, 400);
      return true;
    };
    disabled(await w.prepare(), ["element"]);
    assert.match(w.manager.getView().message, /HTTP 400/);
    assert.match(w.manager.getView().message, expected);
    assert.match(w.logs.join("\n"), expected);
    assertPrivate(w, f);
    assert.doesNotMatch(JSON.stringify([w.logs, w.events]), /private-path|LEAK-MARKER/);
    assert.equal(f.sessions.length, 0);
    await w.time.advance(600_000);
    assert.equal(f.createCalls().length, 1, "a diagnosis must not retry or relax the rejected scope");
  });
}

for (const [code, upstream, expected] of [
  ["console_authentication_failed", 401, /Console отклонила авторизацию MCP/],
  ["console_authentication_failed", 403, /доступ к списку пространств/],
  ["console_authentication_failed", 404, /проверить авторизацию через список пространств/],
  ["console_authentication_failed", 500, /проверить авторизацию через список пространств/],
  ["console_authentication_failed", null, /проверить авторизацию через список пространств/],
  ["console_application_failed", 401, /авторизацию при чтении приложения/],
  ["console_application_failed", 403, /запретила чтение приложения/],
  ["console_application_failed", 404, /не нашла приложение по 1C.applicationId/],
  ["console_application_failed", 429, /прочитать или проверить карточку/],
  ["console_application_failed", 503, /прочитать или проверить карточку/],
  ["console_application_failed", null, /прочитать или проверить карточку/],
  ["application_project_missing", null, /нет ID проекта/],
  ["application_project_invalid", null, /некорректный ID проекта: ожидается UUID/],
  ["application_project_mismatch", null, /не совпадает с 1C.projectId/],
]) {
  test(`MCP 0.23.1 explains ${code} / ${upstream} without changing scope`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.version = "0.23.1";
    const status = code.startsWith("application_") ? 400 : [401, 403].includes(upstream) ? upstream : 502;
    f.hook = (call, res) => {
      if (call.path !== "/api/integrations/ide-sessions") return false;
      json(res, { status: status === 400 ? "invalid" : "rejected", code, http_status: upstream,
        message: "LEAK-MARKER synthetic-client-secret F:\\private-path <script>alert(1)</script>" }, status);
      return true;
    };
    disabled(await w.prepare(), ["element"]);
    const view = w.manager.getView();
    assert.equal(view.status, "error");
    assert.match(view.message, new RegExp(`HTTP ${status}`));
    assert.match(view.message, expected);
    assert.match(w.logs.join("\n"), expected);
    assert(w.events.some(event => event.message === view.message), "diagnosis is published to the settings UI");
    if (upstream) assert.match(view.message, new RegExp(`Console HTTP ${upstream}`));
    if (upstream === 404) assert.doesNotMatch(view.message, /Протокол IDE-сессий v1 недоступен|Обновите Element MCP/);
    assertPrivate(w, f);
    assert.doesNotMatch(JSON.stringify([view, w.logs, w.events]), /LEAK-MARKER|private-path|<script>/);
    assert.equal(f.sessions.length, 0);
    await w.time.advance(600_000);
    assert.equal(f.createCalls().length, 1, "registration errors must not silently retry or use a different scope");
  });
}

for (const upstream of ["404 LEAK-MARKER", 404.5, 0, 399, 600, { secret: "LEAK-MARKER" }, [404], 401]) {
  test(`invalid or inconsistent Console status is not rendered: ${JSON.stringify(upstream)}`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.hook = (call, res) => {
      if (call.path !== "/api/integrations/ide-sessions") return false;
      json(res, { status: "rejected", code: "console_application_failed", http_status: upstream,
        message: { secret: "LEAK-MARKER" } }, 502);
      return true;
    };
    disabled(await w.prepare(), ["element"]);
    assert.match(w.manager.getView().message, /прочитать или проверить карточку/);
    assert.doesNotMatch(w.manager.getView().message, /Console HTTP/);
    assert.doesNotMatch(JSON.stringify([w.logs, w.events]), /LEAK-MARKER/);
    assertPrivate(w, f);
  });
}

for (const [status, payload] of [
  [400, { status: "invalid", code: "LEAK-MARKER", message: "Неизвестные поля IDE-контекста" }],
  [400, { status: "invalid", code: null, message: "Неизвестные поля IDE-контекста" }],
  [400, { status: "rejected", code: "application_project_missing" }],
  [400, { status: "invalid", code: "console_application_failed", http_status: 404 }],
  [401, { status: "rejected", code: "application_project_mismatch" }],
  [403, { status: "invalid", code: "console_authentication_failed", http_status: 403 }],
  [502, { status: "rejected", code: "LEAK-MARKER", http_status: 404 }],
  [502, { status: "rejected", code: ["console_application_failed"], http_status: 404 }],
  [502, { status: "unknown", code: "console_application_failed", http_status: 404 }],
  [404, { status: "rejected", code: "console_application_failed", http_status: 404 }],
]) {
  test(`unknown or inconsistent structured rejection stays generic: ${status} ${JSON.stringify(payload)}`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.hook = (call, res) => {
      if (call.path !== "/api/integrations/ide-sessions") return false;
      json(res, payload, status); return true;
    };
    disabled(await w.prepare(), ["element"]);
    const message = w.manager.getView().message;
    if (status === 400) assert.match(message, /Причина отказа не распознана/);
    if ([401, 403].includes(status)) assert.match(message, /Проверьте контекст IDE и переподключитесь/);
    if (status === 502) assert.equal(message, "Запрос IDE-сессии Element MCP завершился ошибкой (HTTP 502).");
    if (status === 404) assert.match(message, /Протокол IDE-сессий v1 недоступен/);
    assertPrivate(w, f);
    assert.doesNotMatch(JSON.stringify([w.logs, w.events]), /LEAK-MARKER/);
  });
}

test("explicit retry after a structured rejection can verify the corrected IDE session", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  f.version = "0.23.1";
  f.hook = (call, res) => {
    if (call.path !== "/api/integrations/ide-sessions") return false;
    json(res, { status: "invalid", code: "application_project_mismatch", http_status: null }, 400);
    return true;
  };
  disabled(await w.prepare(), ["element"]);
  assert.match(w.manager.getView().message, /не совпадает с 1C.projectId/);
  f.hook = undefined;
  const launch = await w.prepare();
  await launch.verify(toolCaller(f.sessions[0]));
  assert.equal(w.manager.getView().status, "ready");
  assert.doesNotMatch(w.manager.getView().message, /не совпадает/);
  assert.equal(f.createCalls().length, 2);
  assertPrivate(w, f);
});

for (const value of [
  { status: "invalid", message: "LEAK-MARKER synthetic-client-secret" },
  { status: "invalid", message: "Console не подтвердила связь application_id с project_id текущей IDE LEAK-MARKER" },
  { status: "invalid", message: { reason: "LEAK-MARKER" } },
  { status: "invalid", message: "Workspace folder не существует или недоступен серверу MCP: " + "x".repeat(8192) },
  { status: "unknown", message: "Неизвестные поля IDE-контекста" },
  ["LEAK-MARKER"],
  null,
]) {
  test("unrecognized 400 payload remains private and requests MCP diagnostics", async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.hook = (call, res) => {
      if (call.path !== "/api/integrations/ide-sessions") return false;
      json(res, value, 400); return true;
    };
    disabled(await w.prepare(), ["element"]);
    assert.match(w.manager.getView().message, /Причина отказа не распознана/);
    assert.doesNotMatch(JSON.stringify([w.logs, w.events]), /LEAK-MARKER/);
    assertPrivate(w, f);
  });
}

test("renew 400 reports known rejection and still invalidates without a retry", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const launch = await w.prepare();
  await launch.verify(toolCaller(f.sessions[0]));
  f.hook = (call, res) => {
    if (call.method !== "POST" || call.path === "/api/integrations/ide-sessions") return false;
    json(res, { status: "invalid", message: "Некорректное поле git_status.modified" }, 400);
    return true;
  };
  await w.time.advance(60_000);
  await waitFor(() => w.manager.getView().status === "error");
  assert.match(w.manager.getView().message, /не принял сводку/);
  assert.equal(w.state.stops, 1);
  await w.time.advance(600_000);
  assert.equal(f.renewCalls().length, 1);
  assert.equal(f.createCalls().length, 1);
  assertPrivate(w, f);
});

test("verification accepts a Console-confirmed child project of the IDE group", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const launch = await w.prepare();
  await launch.verify(toolCaller(f.sessions[0], { get_current_application: {
    application_project_id: PROJECT_B, project_match_kind: "group", application_project_group_id: PROJECT_A,
  } }));
  assert.equal(w.manager.getView().status, "ready");
  assert.equal(w.manager.getView().projectId, PROJECT_A);
  assert.equal(w.state.stops, 0);
});

for (const change of [
  { protocol_version: 2 }, { protocol_version: true }, { mcp_header: "Authorization" },
  { control_header: "Cookie" }, { mcp_token: "short" }, { project_id: PROJECT_B }, { application_id: APP_B },
  { workspace_folders: [] }, { status: "unknown" }, { expires_in_seconds: 0 },
  { expires_in_seconds: "180" }, { lease_seconds: 999 }, { renew_after_seconds: 180 },
]) {
  test(`invalid create shape ${JSON.stringify(change)} is not activated`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    f.mutateCreate = (value) => ({ ...value, ...change });
    disabled(await w.prepare(), ["element"]);
    await w.manager.close();
    assert(f.sessions[0].revoked);
    assertPrivate(w, f);
  });
}

test("invalidation during create revokes the late capability, stops synchronously, and never publishes it", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  let response, payload;
  f.hook = (call, res) => {
    if (call.path !== "/api/integrations/ide-sessions") return false;
    response = res; payload = JSON.parse(call.body); return true;
  };
  const pending = w.prepare();
  const rejected = assert.rejects(pending, /отменена/);
  await waitFor(() => response);
  const before = w.state.stops;
  w.configChanges.fire({ affectsConfiguration: (key) => key === "1C.applicationId" });
  assert.equal(w.state.stops, before + 1);
  assert.equal(w.manager.getView().status, "disconnected");
  const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString("base64url");
  const control = crypto.randomBytes(32).toString("base64url");
  json(response, {
    protocol_version: 1, status: "ready", session_id: id, project_id: payload.project_id, application_id: payload.application_id,
    workspace_folders: payload.workspace_folders, expires_in_seconds: 180, lease_seconds: 180, renew_after_seconds: 60,
    mcp_header: "X-Element-IDE-Session", mcp_token: token, control_header: "X-Element-IDE-Control", control_token: control,
  }, 201);
  await rejected;
  await waitFor(() => f.deleteCalls().length === 1);
  assert.equal(f.deleteCalls()[0].headers[CONTROL], control);
  assert.equal(w.manager.sanitize(`${token}:${control}`), "[REDACTED]:[REDACTED]");
  assert.equal(w.time.timers.size, 0);
  assertPrivate(w, f);
});

test("changing caller generation during create also revokes the late response", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  let current = true;
  f.mutateCreate = (value) => { current = false; return value; };
  await assert.rejects(w.manager.prepareRuntimeLaunch(() => current), /отменена/);
  await waitFor(() => f.sessions[0].revoked);
  assert.equal(w.manager.getView().status, "disconnected");
  assert(!w.events.some((value) => value.status === "ready"));
});

test("unchanged identity renews every heartbeat, extends TTL, and never overlaps renew", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const launch = await w.prepare();
  await launch.verify(toolCaller(f.sessions[0]));
  for (let index = 1; index <= 4; index++) {
    await w.time.advance(60_000);
    await waitFor(() => f.renewCalls().length === index && w.manager.getView().status === "ready");
  }
  assert.equal(f.createCalls().length, 1);
  assert.equal(w.state.targetReads, 5);
  assert.equal(w.state.stops, 0);
  assert.equal((await w.prepare()).env[ENV], launch.env[ENV]);
  assert(f.renewCalls().every((call) => call.headers[CONTROL] === f.sessions[0].control));
});

test("bounded retry recovers a transient renew failure with the same token", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await (await w.prepare()).verify(toolCaller(f.sessions[0]));
  f.hook = (call, res) => {
    if (call.method !== "POST" || !call.path.endsWith(f.sessions[0].scope.session_id)) return false;
    if (f.renewCalls().length < 3) { json(res, { message: "private-body" }, 502); return true; }
    return false;
  };
  await w.time.advance(60_000);
  await waitFor(() => [...w.time.timers].some((timer) => timer.at === 61_000));
  await w.time.advance(1_000);
  await waitFor(() => [...w.time.timers].some((timer) => timer.at === 63_000));
  await w.time.advance(2_000);
  await waitFor(() => w.manager.getView().status === "ready");
  assert.equal(f.renewCalls().length, 3);
  assert.equal(f.createCalls().length, 1);
  assert.equal(w.state.stops, 0);
});

test("repeated transient renew failures exhaust three retries and invalidate", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await (await w.prepare()).verify(toolCaller(f.sessions[0]));
  f.hook = (call, res) => {
    if (call.method === "POST") { json(res, { message: "private-body" }, 502); return true; }
    return false;
  };
  await w.time.advance(60_000);
  for (const [delay, at] of [[1000, 61_000], [2000, 63_000], [4000, 67_000]]) {
    await waitFor(() => [...w.time.timers].some((timer) => timer.at === at));
    await w.time.advance(delay);
  }
  await waitFor(() => w.manager.getView().status === "error");
  assert.equal(f.renewCalls().length, 4);
  assert.equal(w.state.stops, 1);
  assert.equal(w.manager.getView().canPrepare, undefined);
  await w.manager.close();
  assert(f.sessions[0].revoked);
});

test("server restart refreshes CSRF once then invalidates unknown session; no automatic create or fallback", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await (await w.prepare()).verify(toolCaller(f.sessions[0]));
  const previousCsrf = f.csrf;
  f.csrf = "replacement-csrf-token";
  f.sessions[0].revoked = true;
  await w.time.advance(60_000);
  await waitFor(() => [...w.time.timers].some((timer) => timer.at === 60_000));
  await w.time.advance(0);
  await waitFor(() => w.manager.getView().status === "error");
  assert.equal(f.renewCalls().length, 2);
  assert.equal(f.createCalls().length, 1);
  assert.equal(f.calls.filter((call) => call.path === "/").length, 2);
  assert.equal(w.manager.sanitize(`${previousCsrf} ${f.csrf}`), "[REDACTED] [REDACTED]");
});

for (const field of ["targets", "clientSecret", "applicationId", "folders", "elementMcpUrl", "verifyTls"]) {
  test(`heartbeat detects silent shared ${field} changes before renewing`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    await (await w.prepare()).verify(toolCaller(f.sessions[0]));
    if (field === "targets") w.state.targets[0].url = f.url.replace("/mcp", "/different");
    else if (field === "folders") w.folders[0].uri.fsPath = f.rootB;
    else if (field === "elementMcpUrl") w.settings.elementMcpUrl = "http://127.0.0.1:1/mcp";
    else w.config[field] = field === "verifyTls" ? false : field === "applicationId" ? APP_B : "new-client-secret";
    await w.time.advance(60_000);
    await waitFor(() => w.manager.getView().status === "error");
    assert.equal(f.renewCalls().length, 0);
    assert.equal(w.state.stops, 1);
    assert.equal(f.createCalls().length, 1);
  });
}

test("workspace and configuration listeners only invalidate, and revoked capabilities remain redacted", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await w.prepare();
  const old = f.sessions[0];
  w.folderChanges.fire({});
  assert.equal(w.state.stops, 1);
  w.config.clientSecret = "new-client-secret.+*";
  w.configChanges.fire({ affectsConfiguration: (key) => key === "1C.clientSecret" });
  assert.equal(w.state.stops, 2);
  await waitFor(() => old.revoked);
  await w.time.advance(600_000);
  assert.equal(f.createCalls().length, 1);
  const next = await w.prepare();
  assert.notEqual(next.env[ENV], old.mcp);
  const secrets = [old.mcp, old.control, f.csrf, "synthetic-client-secret", "new-client-secret.+*"];
  const text = secrets.concat(secrets).join("::");
  assert.equal(w.manager.sanitize(text), Array(10).fill("[REDACTED]").join("::"));
  await w.manager.close();
  assert.equal(w.manager.sanitize(old.mcp), "[REDACTED]");
});

test("late renewal response after invalidation cannot revive a token or overwrite the new window scope", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await (await w.prepare()).verify(toolCaller(f.sessions[0]));
  let held;
  f.hook = (call, res) => {
    if (call.method === "POST" && call.path.endsWith(f.sessions[0].scope.session_id)) { held = res; return true; }
    return false;
  };
  await w.time.advance(60_000);
  await waitFor(() => held);
  w.manager.invalidate();
  w.config.applicationId = APP_B;
  const replacement = await w.prepare();
  await replacement.verify(toolCaller(f.sessions[1]));
  json(held, { ...f.sessions[0].scope, lease_seconds: 180, renew_after_seconds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(w.manager.getView().applicationId, APP_B);
  assert.equal(w.manager.getView().status, "ready");
  assert.equal(w.state.stops, 1);
});

test("expiry watchdog invalidates during an unresolved renewal dependency", async (t) => {
  const f = await fixture(t);
  const never = new Promise(() => {});
  const short = windowManager(f);
  f.mutateCreate = (value) => ({ ...value, expires_in_seconds: 2 });
  const launch = await short.prepare();
  await launch.verify(toolCaller(f.sessions[0]));
  short.vscode.commands.executeCommand = () => never;
  await short.time.advance(1_000);
  await waitFor(() => short.state.targetReads === 2);
  await short.time.advance(1_000);
  assert.equal(short.manager.getView().status, "expired");
  assert.equal(short.manager.getView().serverName, "element");
  assert.equal(short.state.stops, 1);
  await short.time.advance(10_000);
  assert.equal(f.renewCalls().length, 0);
});

for (const change of [
  { workspace_scope: { status: "missing" } },
  { scope: { session_id: crypto.randomUUID() } },
  { scope: { project_id: PROJECT_B } },
  { scope: { application_id: APP_B } },
  { scope: { workspace_folders: ["/not-this-window"] } },
  { app: { application: { id: APP_B } } },
  { app: { application_project_id: PROJECT_B } },
  { app: { application_project_id: PROJECT_B, project_match_kind: "group" } },
  { app: { application_project_id: PROJECT_B, application_project_group_id: PROJECT_A } },
  { app: { application_project_id: PROJECT_B, project_match_kind: "group", application_project_group_id: PROJECT_B } },
  { app: { application_project_id: "invalid", project_match_kind: "group", application_project_group_id: PROJECT_A } },
  { app: { matches_ide_project: false } },
  { app: { connection: { source: "global" } } },
]) {
  test(`verification mismatch ${JSON.stringify(change)} revokes and clears policy/status`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    const launch = await w.prepare(), session = f.sessions[0];
    const changes = {
      get_managed_actions_status: change.workspace_scope ? change : change.scope ? { workspace_scope: { ...session.scope, ...change.scope } } : {},
      get_current_application: change.app || {},
    };
    await assert.rejects(launch.verify(toolCaller(session, changes)), /ошибкой/);
    assert.equal(w.state.stops, 1);
    assert.equal(w.manager.getView().status, "error");
    assert.equal(w.manager.getView().serverName, "element");
    assert.equal(w.manager.getView().applicationId, undefined);
    assert.equal(w.manager.getView().canPrepare, undefined);
    await w.manager.close();
    assert(session.revoked);
    assertPrivate(w, f);
  });
}

test("tool errors, non-JSON text, and raw exceptions are generic; text JSON result is supported", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  for (const result of [
    { isError: true, content: [{ type: "text", text: "synthetic-client-secret" }] },
    { content: [{ type: "text", text: "private-body-not-json" }] },
    new Error("LEAK-MARKER synthetic-client-secret"),
  ]) {
    const launch = await w.prepare();
    await assert.rejects(launch.verify(async () => {
      if (result instanceof Error) throw result;
      return result;
    }), (error) => {
      assert(!error.message.includes("LEAK-MARKER"));
      assertPrivate(w, f, error.stack);
      return true;
    });
  }
  const launch = await w.prepare(), selected = f.sessions.at(-1), read = toolCaller(selected);
  await launch.verify(async (...args) => ({ content: [{ type: "text", text: JSON.stringify((await read(...args)).structuredContent) }] }));
  assert.equal(w.manager.getView().status, "ready");
});

test("invalidation during verification never calls the second tool or marks ready", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  const launch = await w.prepare(), result = deferred();
  let calls = 0;
  const verifying = launch.verify(async () => { calls++; return result.promise; });
  const rejected = assert.rejects(verifying, /отменена/);
  w.manager.invalidate();
  result.resolve({ structuredContent: { workspace_scope: f.sessions[0].scope } });
  await rejected;
  assert.equal(calls, 1);
  assert.equal(w.manager.getView().status, "disconnected");
});

test("malformed, oversized, interrupted, and stalled HTTP responses stay bounded and private", async (t) => {
  const f = await fixture(t);
  for (const kind of ["malformed", "oversized", "interrupted", "stalled"]) {
    const w = windowManager(f);
    let reached = false;
    f.hook = (call, res) => {
      if (call.path !== "/api/status") return false;
      reached = true;
      if (kind === "malformed") res.end("private-body: synthetic-client-secret");
      else if (kind === "oversized") res.end("private-body".repeat(20_000));
      else if (kind === "interrupted") {
        res.writeHead(200, { "Content-Length": "4096" }); res.write("private-body"); setImmediate(() => res.destroy());
      } else res.write("private");
      return true;
    };
    const preparing = w.prepare();
    await waitFor(() => reached);
    if (kind === "stalled") await w.time.advance(5_000);
    disabled(await preparing, ["element"]);
    assertPrivate(w, f);
    assert(!JSON.stringify(w.events).includes("private-body"));
  }
});

test("oversized outbound context cannot send credentials in an unbounded request", async (t) => {
  const f = await fixture(t), w = windowManager(f, { clientSecret: "s".repeat(70_000) });
  disabled(await w.prepare(), ["element"]);
  assert.equal(f.createCalls().length, 0);
  assert.match(w.manager.getView().message, /размер/);
});

test("close is idempotent and awaits a bounded best-effort revoke without claiming write cancellation", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  await w.prepare();
  f.hook = (call) => call.method === "DELETE";
  const closing = w.manager.close();
  assert.equal(w.manager.close(), closing);
  assert.equal(w.state.stops, 1);
  await waitFor(() => f.deleteCalls().length === 1);
  await w.time.advance(5_000);
  await closing;
  assert(w.logs.some((line) => line.includes("may still complete")));
  await assert.rejects(w.prepare(), /отменена/);
  assertPrivate(w, f);
});

test("failure state retains target identity for transport-ready guards; disabled target clears it", async (t) => {
  const f = await fixture(t), w = windowManager(f, { applicationId: "" });
  disabled(await w.prepare(), ["element"]);
  assert.equal(w.manager.getView().serverName, "element");
  w.manager.invalidate();
  assert.equal(w.manager.getView().serverName, "element");
  w.state.targets[0].enabled = false;
  await w.prepare();
  assert.equal(w.manager.getView().serverName, undefined);
  assert.equal(f.calls.length, 0);
});

test("readiness explains disabled and migrated policies without writing policy settings", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  for (const [canPrepare, migrationRequired] of [[false, false], [false, true], [true, false]]) {
    const launch = await w.prepare();
    await launch.verify(toolCaller(f.sessions[0], {
      get_managed_actions_status: { can_prepare: canPrepare, migration_required: migrationRequired },
    }));
    const view = w.manager.getView();
    assert.equal(view.canPrepare, canPrepare);
    assert.equal(view.migrationRequired, migrationRequired);
    if (!canPrepare) assert.match(view.message, /Управляемые действия отключены в MCP/);
    if (migrationRequired) assert.match(view.message, /повторное сохранение политики оператором/);
    if (canPrepare) assert(!view.message.includes("отключены"));
  }
  assert.equal(f.createCalls().length, 1);
  assert.equal(f.calls.length, 3, "verification must not change MCP policy");
});

test("raw and JSON-escaped credentials remain redacted after rotation, including overlaps", async (t) => {
  const f = await fixture(t);
  const original = 'credential"with\\slashes\nand\tcontrols';
  const w = windowManager(f, { clientId: "abc", clientSecret: original });
  await w.prepare();
  w.manager.invalidate();
  w.config.clientSecret = "bcde";
  await w.prepare();
  const escaped = JSON.stringify(original).slice(1, -1);
  assert.equal(w.manager.sanitize(`${original} ${escaped} abcde`), "[REDACTED] [REDACTED] [REDACTED]");
  await w.manager.close();
  assert.equal(w.manager.sanitize(escaped), "[REDACTED]");
});

test("all public status and SessionError messages use Russian, not remote body text", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  assert.match(w.manager.getView().message, /[А-Яа-яЁё]/);
  const launch = await w.prepare();
  await launch.verify(toolCaller(f.sessions[0]));
  w.manager.invalidate();
  await assert.rejects(launch.verify(async () => undefined), (error) => /[А-Яа-яЁё]/.test(error.message));
  for (const view of w.events) assert.match(view.message, /[А-Яа-яЁё]/);
});

test("create 404 with non-JSON body has an explicit version-upgrade message", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  f.hook = (call, res) => {
    if (call.path !== "/api/integrations/ide-sessions") return false;
    res.writeHead(404); res.end("<html>synthetic-client-secret</html>"); return true;
  };
  disabled(await w.prepare(), ["element"]);
  assert.match(w.manager.getView().message, /0.23.0/);
  assertPrivate(w, f);
});

test("stdio MCP processes get explicit empty token env without replacing existing environment policies", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets[0].stdioServerNames = ["browser", "stdio-forwarded"];
  const launch = await w.prepare();
  assert(launch.args[1].includes(`"browser"={"env"={"${ENV}"=""}}`));
  assert(launch.args[1].includes(`"stdio-forwarded"={"env"={"${ENV}"=""}}`));
  assert.equal(launch.args.filter((arg) => arg.startsWith("mcp_servers=")).length, 1);
  assert(!launch.args.some((arg) => arg.includes(".exclude") || arg.includes(".env_vars") || arg.includes(".filters")));
  assertPrivate(w, f, launch.args);
});

test("another HTTP MCP referencing the reserved token variable prevents issuing any capability", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets[0].sessionTokenUsedElsewhere = true;
  disabled(await w.prepare(), ["element"]);
  assert.equal(f.calls.length, 0);
  assert.match(w.manager.getView().message, /другим HTTP MCP/);
});

test("manual dotted, quoted, and special target names are literal keys in the partial table", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  for (const name of ["element.with.dots", 'element."quoted"', "element name", "__proto__", "имя\\сервера", "line\nbreak"]) {
    w.state.targets[0].name = name;
    const launch = await w.prepare();
    assert.deepEqual(plain(launch.args), [
      "-c", `mcp_servers={${JSON.stringify(name)}={"url"=${JSON.stringify(f.url)},"env_http_headers"={"X-Element-IDE-Session"="${ENV}"}}}`,
      "-c", `shell_environment_policy.set.${ENV}=""`,
    ]);
    assert.equal(launch.env[ENV], f.sessions.at(-1).mcp);
    assert.equal(w.manager.getView().serverName, name);
    await launch.verify(toolCaller(f.sessions.at(-1)));
    w.manager.invalidate();
  }
  assert.equal(f.createCalls().length, 6);
});

test("dotted stdio names and quoted names share the same partial table without copying existing values", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets[0].stdioServerNames = ["stdio.with.dots", 'stdio."quoted"', "__proto__"];
  const launch = await w.prepare();
  for (const name of w.state.targets[0].stdioServerNames) {
    assert(launch.args[1].includes(`${JSON.stringify(name)}={"env"={"${ENV}"=""}}`));
  }
  assert.equal(launch.args.filter((arg) => arg.startsWith("mcp_servers=")).length, 1);
  assertPrivate(w, f, launch.args);
});

test("duplicate dotted targets are disabled in one partial table without issuing a token", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets[0].name = 'element."one"';
  w.state.targets.push({ ...w.state.targets[0], name: "element.two" });
  disabled(await w.prepare(), ['element."one"', "element.two"]);
  assert.equal(f.calls.length, 0);
});

test("a dotted target create failure disables the original literal server name", async (t) => {
  const f = await fixture(t), w = windowManager(f);
  w.state.targets[0].name = "element.quoted";
  f.createCode = 400;
  disabled(await w.prepare(), ["element.quoted"]);
  assert.equal(w.manager.getView().serverName, "element.quoted");
  assertPrivate(w, f);
});

for (const changed of ["stdioServerNames", "sessionTokenUsedElsewhere"]) {
  test(`heartbeat invalidates when ${changed} changes, including an in-place array update`, async (t) => {
    const f = await fixture(t), w = windowManager(f);
    w.state.targets[0].stdioServerNames = ["browser"];
    await (await w.prepare()).verify(toolCaller(f.sessions[0]));
    if (changed === "stdioServerNames") w.state.targets[0].stdioServerNames.push("another-stdio");
    else w.state.targets[0].sessionTokenUsedElsewhere = true;
    await w.time.advance(60_000);
    await waitFor(() => w.manager.getView().status === "error");
    assert.equal(f.renewCalls().length, 0);
    assert.equal(w.state.stops, 1);
  });
}

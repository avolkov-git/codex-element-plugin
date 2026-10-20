const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, logger, vscode } = require("./service-test-utils.cjs");

const { elementMcpEndpointKey } = loadSource("src/elementMcpEndpoint.ts");
const record = (name, url, extra = {}) => ({ name, enabled: true, transport: { type: "streamable_http", url, ...extra } });

function harness(t, records = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-element-session-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "config.toml"), '[mcp_servers.element]\nurl="http://127.0.0.1:9900/mcp"\n');
  const runtime = { onDidChangeIntegrations: () => ({ dispose() {} }), isBackendRunning: () => false };
  const { CodexIntegrationsService } = loadSource("src/codexIntegrationsService.ts", { vscode });
  const service = new CodexIntegrationsService({}, {}, {}, runtime, logger);
  const calls = [], events = [];
  service.getCodexHome = async () => home;
  service.runCli = async (args, staged) => {
    calls.push({ args, staged });
    if (args[1] === "list") return { stdout: JSON.stringify(records), stderr: "" };
    events.push("edit");
    if (args[1] === "add") fs.writeFileSync(path.join(staged, "config.toml"), `[mcp_servers.${args[2]}]\nurl="${args[4]}"\n`);
    return { stdout: "", stderr: "" };
  };
  service.refresh = async () => service.getSnapshot();
  service.setElementSessionProvider(() => ({ status: "ready", message: "Приложение текущего workspace подключено", serverName: "element" }),
    async () => { events.push("invalidate"); });
  return { service, home, calls, events, runtime };
}

test("loopback endpoint comparison accepts aliases, rejects remote or credential-bearing addresses", () => {
  const expected = elementMcpEndpointKey("http://127.0.0.1:9900");
  for (const url of ["http://localhost:9900/mcp", "http://[::1]:9900/mcp/"]) {
    assert.equal(elementMcpEndpointKey(url, true), expected);
  }
  for (const url of ["http://server:9900/mcp", "http://127.0.0.1.evil:9900/mcp", "http://user:secret@localhost:9900/mcp",
    "http://localhost:9900/mcp?token=secret", "http://localhost:9900/mcp#fragment", "http://localhost:9900/other", "file:///mcp"]) {
    assert.equal(elementMcpEndpointKey(url, true), undefined);
  }
  assert.notEqual(elementMcpEndpointKey("http://localhost:9901/mcp", true), expected);
  assert.notEqual(elementMcpEndpointKey("https://localhost:9900/mcp", true), expected);
});

test("only configured Element endpoint is selected, with persisted session/control headers flagged", async t => {
  const h = harness(t, [
    record("element", "http://localhost:9900/mcp", { env_http_headers: { "x-ElEmEnT-iDe-SeSsIoN": "OLD_VAR" } }),
    record("control", "http://[::1]:9900/mcp", { http_headers: { "X-Element-IDE-Control": "secret-control" } }),
    { ...record("disabled", "http://127.0.0.1:9900/mcp"), enabled: false },
    record("elsewhere", "http://127.0.0.1:9901/mcp"),
    record("remote", "https://external.example/mcp"),
    { name: "stdio", transport: { type: "stdio", command: "example" } }
  ]);
  const targets = await h.service.getElementMcpTargets();
  assert.deepEqual(Array.from(targets, t => [t.name, t.enabled, t.sessionHeaderConfigured]),
    [["element", true, true], ["control", true, true], ["disabled", false, false]]);
  assert(!JSON.stringify(targets).includes("secret-control"));
});

test("no configured Element MCP means no target and no automatic server addition", async t => {
  const h = harness(t, [record("docs", "https://docs.example/mcp")]);
  assert.equal((await h.service.getElementMcpTargets()).length, 0);
  assert(h.calls.every(call => call.args[1] === "list"));
});

test("private runtime environment is guarded for all stdio clients and conflicting HTTP consumers", async t => {
  const h = harness(t, [
    record("element", "http://127.0.0.1:9900/mcp"),
    { name: "local-tool", transport: { type: "stdio", command: "node", env_vars: ["ELEMENT_IDE_MCP_SESSION_TOKEN"] } },
    { name: "disabled-tool", enabled: false, transport: { type: "stdio", command: "node" } },
    record("external", "https://other.example/mcp", { env_http_headers: { "X-Token": "ELEMENT_IDE_MCP_SESSION_TOKEN" } })
  ]);
  const [target] = await h.service.getElementMcpTargets();
  assert.deepEqual(Array.from(target.stdioServerNames), ["local-tool"]);
  assert.equal(target.sessionTokenUsedElsewhere, true);
  assert(!JSON.stringify(target).includes("other.example"));
});

test("reserved env references are case-insensitive, including existing bearer auth on the bound target", async t => {
  const h = harness(t, [
    record("element", "http://127.0.0.1:9900/mcp", { bearer_token_env_var: "element_ide_mcp_session_token" }),
    record("external", "https://other.example/mcp", { env_http_headers: { "X-Token": "Element_Ide_Mcp_Session_Token" } })
  ]);
  const [target] = await h.service.getElementMcpTargets();
  assert.equal(target.sessionHeaderConfigured, true);
  assert.equal(target.sessionTokenUsedElsewhere, true);
  await assert.rejects(h.service.saveMcpServer({
    name: "element", transport: "http", url: "http://127.0.0.1:9900/mcp",
    bearerTokenEnvVar: "element_ide_mcp_session_token"
  }), /не может/);
});

test("UI cannot add the same endpoint under a second name or enable a second alias", async t => {
  const h = harness(t, [record("element", "http://127.0.0.1:9900/mcp"),
    { ...record("duplicate", "http://localhost:9900/mcp"), enabled: false }]);
  await assert.rejects(h.service.saveMcpServer({ name: "another", transport: "http", url: "http://[::1]:9900/mcp" }), /уже подключён/);
  await assert.rejects(h.service.setMcpEnabled("duplicate", true), /другим именем/);
  assert.deepEqual(h.events, []);
});

test("editing the bound server invalidates before persistence and stores no temporary binding", async t => {
  const h = harness(t, [record("element", "http://127.0.0.1:9900/mcp")]);
  await h.service.saveMcpServer({ name: "renamed", originalName: "element", transport: "http", url: "http://127.0.0.1:9900/mcp" });
  assert.deepEqual(h.events, ["invalidate", "edit", "edit", "invalidate"]);
  const config = fs.readFileSync(path.join(h.home, "config.toml"), "utf8");
  assert.match(config, /mcp_servers.renamed/);
  assert.doesNotMatch(config, /ELEMENT_IDE_MCP_SESSION_TOKEN|X-Element-IDE|mcp_token|control_token/);
  assert(h.calls.some(call => call.args[1] === "list" && call.staged), "recheck duplicates under the config lock");
});

test("duplicate added by another window after initial check is caught under the lock", async t => {
  const h = harness(t);
  const run = h.service.runCli;
  h.service.runCli = async (args, staged) => args[1] === "list" && staged
    ? { stdout: JSON.stringify([record("other-window", "http://127.0.0.1:9900/mcp")]), stderr: "" }
    : run(args, staged);
  const before = fs.readFileSync(path.join(h.home, "config.toml"), "utf8");
  await assert.rejects(h.service.saveMcpServer({ name: "element", transport: "http", url: "http://127.0.0.1:9900/mcp" }), /Другой сеанс/);
  assert.equal(fs.readFileSync(path.join(h.home, "config.toml"), "utf8"), before);
});

test("unrelated remote MCP remains editable and session token cannot be saved as bearer auth", async t => {
  const h = harness(t);
  await h.service.saveMcpServer({ name: "docs", transport: "http", url: "https://docs.example/mcp" });
  assert.match(fs.readFileSync(path.join(h.home, "config.toml"), "utf8"), /https:\/\/docs.example/);
  await assert.rejects(h.service.saveMcpServer({ name: "element", transport: "http", url: "http://127.0.0.1:9900/mcp",
    bearerTokenEnvVar: "ELEMENT_IDE_MCP_SESSION_TOKEN" }), /не может/);
});

test("transport ready cannot hide expired IDE scope in connection test", async t => {
  const h = harness(t, [record("element", "http://127.0.0.1:9900/mcp")]);
  h.service.setElementSessionProvider(() => ({ status: "expired", serverName: "element", message: "Сессия истекла. Повторите проверку." }), async () => {});
  h.runtime.loadMcpRuntimeStatuses = async () => [{ name: "element", runtimeStatus: "ready", toolCount: 30 }];
  const result = await h.service.testMcpServer("element");
  assert.equal(result.status, "failed");
  assert.match(result.message, /истекла/);
  h.service.snapshot.mcpServers = [{ name: "element", runtimeStatus: "ready", toolCount: 30 }];
  assert.equal(h.service.getSnapshot().mcpServers[0].runtimeStatus, "failed");
  assert.equal(h.service.getSnapshot().mcpServers[0].toolCount, 0);
});

test("explicit MCP refresh retries a failed binding; passive refresh does not restart runtime", async t => {
  const h = harness(t, [record("element", "http://127.0.0.1:9900/mcp")]);
  delete h.service.refresh;
  h.runtime.loadMcpRuntimeStatuses = async () => { h.events.push("load"); return []; };
  h.runtime.loadSkills = async () => [];
  h.service.setElementSessionProvider(() => ({ status: "error", serverName: "element", message: "Ошибка подключения." }),
    async () => { h.events.push("invalidate"); });
  await h.service.refresh();
  assert.deepEqual(h.events, ["load"]);
  h.events.length = 0;
  await h.service.refresh(true, true);
  assert.deepEqual(h.events, ["invalidate", "load"]);
});

test("independent MCP mutations do not invalidate chats when Element MCP is not connected", async t => {
  const h = harness(t);
  h.service.setElementSessionProvider(() => ({ status: "disconnected", message: "Нет подключения." }),
    async () => { h.events.push("invalidate"); });
  await h.service.saveMcpServer({ name: "docs", transport: "http", url: "https://docs.example/mcp" });
  await h.service.setMcpEnabled("docs", false);
  await h.service.removeMcpServer("docs");
  assert(!h.events.includes("invalidate"));
  await h.service.saveMcpServer({ name: "element", transport: "http", url: "http://127.0.0.1:9900/mcp" });
  assert(h.events.includes("invalidate"), "adding the first Element MCP must rebuild runtime bindings");
});

test("an explicit retry queued behind passive refresh is not lost", async t => {
  const h = harness(t, [record("element", "http://127.0.0.1:9900/mcp")]);
  delete h.service.refresh;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let first = true;
  h.runtime.loadMcpRuntimeStatuses = async () => {
    h.events.push("load");
    if (first) { first = false; await blocked; }
    return [];
  };
  h.runtime.loadSkills = async () => [];
  h.service.setElementSessionProvider(() => ({ status: "expired", serverName: "element", message: "Сессия истекла." }),
    async () => { h.events.push("invalidate"); });
  const passive = h.service.refresh();
  const retry = h.service.refresh(true, true);
  release();
  await Promise.all([passive, retry]);
  assert.deepEqual(h.events, ["load", "invalidate", "load"]);
});

test("first MCP addition cancels a startup that read old config and refreshes after publication", { timeout: 3000 }, async t => {
  const records = [];
  const h = harness(t, records);
  delete h.service.refresh;
  let releaseStartup, passive, invalidations = 0, loads = 0;
  const starting = new Promise(resolve => { releaseStartup = resolve; });
  h.service.setElementSessionProvider(() => ({ status: "disconnected", message: "Нет подключения." }), async () => {
    invalidations++;
    if (invalidations === 2) releaseStartup();
  });
  h.runtime.loadMcpRuntimeStatuses = async () => {
    if (++loads === 1) await starting;
    return [];
  };
  h.runtime.loadSkills = async () => [];
  const runCli = h.service.runCli;
  h.service.runCli = async (args, staged) => {
    if (args[1] === "add") {
      passive = h.service.refresh();
      while (!loads) await new Promise(resolve => setImmediate(resolve));
      records.push(record("element", "http://127.0.0.1:9900/mcp"));
    }
    return runCli(args, staged);
  };
  await h.service.saveMcpServer({ name: "element", transport: "http", url: "http://127.0.0.1:9900/mcp" });
  await passive;
  assert.equal(invalidations, 2, "invalidate both before and after config publication, even when runtime is not ready");
  assert.equal(loads, 2, "the pre-publication refresh cannot substitute for a fresh pass");
  assert(h.service.getSnapshot().mcpServers.some(server => server.name === "element"));
});

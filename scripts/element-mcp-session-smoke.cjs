#!/usr/bin/env node
"use strict";

// Usage: node scripts/element-mcp-session-smoke.cjs <native-codex-binary>
// Requires Node >=18 and ps (Windows: PowerShell/Get-CimInstance).
// Optional fully offline Linux verification:
// docker run --rm --network none --read-only --tmpfs /tmp:rw,exec,size=512m \
//   -v "$PWD:/work:ro" -w /work --entrypoint node <local-node-image> \
//   scripts/element-mcp-session-smoke.cjs bin/linux-arm64/codex
//
// Actual 0.154.0 app-server, isolated loopback MCP and stdio browser-shaped
// fixtures. No account, model turn, production writes, dist/, or npm install.
//
// Chosen binding: a private spawn env + env_http_headers CLI override. Ordinary
// names use unquoted leaf overrides. CLI key paths do NOT parse TOML quoting.
// A minimal partial mcp_servers inline table deep-merges with base TOML without
// copying existing URLs, headers, or credentials into argv. Put it BEFORE other
// CLI mcp_servers.<name> overrides: a later parent assignment replaces earlier
// CLI children. Alternatively combine process-local patches into one partial.
//
// Chosen command-child guard: shell_environment_policy.set.<TOKEN_ENV>="".
// filters.<TOKEN_ENV>="exclude" works but causes legacy exclude arrays to be
// ignored in 0.154.0. The probe demonstrates that conflict as a negative control.
// Empty is not absent; this only guards the tested default command environment.
// Explicit per-command env can override it. It does not hide the runtime's env
// from same-user process inspection, arbitrary local execution, or administrators.
// Stdio MCP uses a separate environment allowlist, not shell_environment_policy.
// Explicit env_vars forwarding can expose the token; per-MCP env.<TOKEN_ENV>=""
// must also be composed for any such child. Both cases are tested below.
// mcpServerStatus/list also sends configured HTTP headers to same-origin OAuth
// metadata discovery paths. This fixture returns 404 there (no OAuth/redirect).
// This is a transport/config compatibility test, not real MCP 0.23 validation,
// plugin lifecycle coverage, a sandbox security test, or cross-platform certification.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");

const TOKEN_ENV = "ELEMENT_IDE_MCP_SESSION_TOKEN";
const HEADER = "X-Element-IDE-Session";
const tokens = [crypto.randomBytes(32).toString("hex"), crypto.randomBytes(32).toString("hex")];
const clean = (text) => tokens.reduce((value, token) => value.split(token).join("[REDACTED]"), String(text));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const noSecrets = (value, label) => check(!tokens.some((token) => String(value).includes(token)), `Secret found in ${label}`);
const tools = [{ name: "context", description: "Read isolated fixture context", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }];
const tokenState = `Object.hasOwn(process.env,${JSON.stringify(TOKEN_ENV)})?(process.env.${TOKEN_ENV}===""?"empty":"present"):"absent"`;
const envProbe = `console.log(JSON.stringify({token:${tokenState},legacy:Object.hasOwn(process.env,"ELEMENT_SMOKE_LEGACY"),glob:Object.hasOwn(process.env,"ELEMENT_SMOKE_OLD_ONE"),keep:process.env.ELEMENT_SMOKE_KEEP,set:process.env.ELEMENT_SMOKE_SET}))`;

// Only fixture-owned, JSON-compatible values are serialized here, not arbitrary
// user TOML. The production config merger is deliberately outside this script.
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stdioFixture() {
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    switch (request.method) {
      case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "browser-shaped-fixture", version: "1" } }; break;
      case "tools/list": result = { tools }; break;
      case "tools/call":
        result = { content: [{ type: "text", text: JSON.stringify({
          target: process.argv[3] || "browser", context: -1,
          token: Object.hasOwn(process.env, TOKEN_ENV) ? (process.env[TOKEN_ENV] === "" ? "empty" : "present") : "absent",
        }) }] };
        break;
      case "resources/list": result = { resources: [] }; break;
      case "resources/templates/list": result = { resourceTemplates: [] }; break;
      case "prompts/list": result = { prompts: [] }; break;
      default: process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } })}\n`); return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
}

function baseEnv(home) {
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: home };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

class Runtime {
  constructor(binary, root, home, overrides, token) {
    this.pending = new Map();
    this.serial = 0;
    this.output = "";
    this.errors = "";
    this.args = ["app-server", ...overrides.flatMap((value) => ["-c", value])];
    noSecrets(JSON.stringify(this.args), "runtime arguments");
    check(!this.args.some((arg) => arg.includes("existing-static-header") || arg.includes("existing-env-header")), "Existing HTTP header value copied to argv");
    this.child = spawn(binary, this.args, {
      cwd: root,
      env: {
        ...baseEnv(home), [TOKEN_ENV]: token,
        ELEMENT_SMOKE_EXISTING_HEADER: "existing-env-header",
        ELEMENT_SMOKE_LEGACY: "legacy-must-be-excluded",
        ELEMENT_SMOKE_OLD_ONE: "glob-must-be-excluded",
        ELEMENT_SMOKE_KEEP: "keep-me",
      },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      this.output += `${line}\n`;
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          this.failure = `Unexpected app-server request: ${message.method}`;
          this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "No interactive requests in smoke" } })}\n`);
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(clean(`${pending.method}: ${JSON.stringify(message.error)}`)));
          else pending.resolve(message.result);
        }
      } catch {
        this.failure = "Invalid app-server JSON output";
      }
    });
    this.child.stderr.on("data", (chunk) => { this.errors += chunk; });
    this.child.on("error", (error) => this.failPending(`Spawn failed: ${error.code}`));
    this.child.on("exit", () => this.failPending(`App-server exited: ${clean(this.errors.slice(-4000))}`));
    this.child.stdin.on("error", () => this.failPending("App-server stdin closed"));
  }

  failPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  request(method, params) {
    const id = ++this.serial;
    const payload = JSON.stringify({ id, method, params });
    noSecrets(payload, `RPC request ${method}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${method}; ${clean(this.errors.slice(-2000))}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "element_mcp_session_smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    check(result.userAgent.includes("0.154.0"), "Expected bundled runtime 0.154.0");
    this.child.stdin.write('{"method":"initialized"}\n');
  }

  async startThread(root) {
    const result = await this.request("thread/start", { cwd: root, ephemeral: true, approvalPolicy: "never", sandbox: "danger-full-access" });
    this.threadId = result.thread.id;
    check(result.thread.ephemeral === true, "Thread was not ephemeral");
  }

  async context(name, expectedContext) {
    const result = await this.request("mcpServer/tool/call", { threadId: this.threadId, server: name, tool: "context", arguments: {} });
    check(!result.isError, `MCP tool returned an error for ${name}`);
    const data = JSON.parse(result.content.find((item) => item.type === "text").text);
    assert.equal(data.target, name);
    assert.equal(data.context, expectedContext, `Wrong context for ${name}`);
    return data;
  }

  async environment(root, expectedToken, legacy, extraEnv, shell = false) {
    const result = await this.request("command/exec", {
      command: shell
        ? ["/bin/sh", "-c", 'exec "$1" -e "$2"', "element-smoke", process.execPath, envProbe]
        : [process.execPath, "-e", envProbe],
      cwd: root,
      timeoutMs: 10000, outputBytesCap: 4096,
      ...(extraEnv ? { env: extraEnv } : {}),
    });
    assert.equal(result.exitCode, 0, "command/exec failed");
    assert.equal(result.stderr, "", "Unexpected command stderr");
    assert.deepEqual(JSON.parse(result.stdout), {
      token: expectedToken, legacy, glob: legacy, keep: "keep-me", set: "existing-set",
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      await this.closed;
      clearTimeout(timer);
    } else {
      await this.closed;
    }
    this.reader.close();
    this.failPending("Runtime stopped");
    noSecrets(this.output, "app-server stdout");
    noSecrets(this.errors, "app-server stderr");
    check(!this.failure, this.failure);
  }
}

function auditFiles(root) {
  let files = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files += auditFiles(file);
    else if (entry.isFile()) {
      noSecrets(fs.readFileSync(file), "temporary common state/config/log files");
      files++;
    }
  }
  return files;
}

async function main() {
  check(process.argv.length === 3, "Usage: node scripts/element-mcp-session-smoke.cjs <native-codex-binary>");
  const binary = path.resolve(process.argv[2]);
  fs.accessSync(binary, fs.constants.X_OK);
  const parentToken = process.env[TOKEN_ENV];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "element-mcp-session-smoke-")));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const runtimes = [];
  const events = [];
  const fixtureErrors = [];
  let modelRequests = 0;
  let authDiscoveryRequests = 0;
  let expectedConfig;
  const unexpectedHttp = [];
  const names = ["element", "element-ide", "element.quoted"];
  const revoked = new Set();
  let rejectedCalls = 0;
  const server = http.createServer(async (req, res) => {
    const respond = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      noSecrets(req.url, "HTTP URL");
      if (/\/\.well-known\/(?:oauth-protected-resource|oauth-authorization-server|openid-configuration)(?:\/|$)/.test(req.url)) {
        const target = decodeURIComponent((req.url.split("/mcp/")[1] || "").split("/")[0]);
        if (!target) {
          check(req.headers[HEADER.toLowerCase()] === undefined || tokens.includes(req.headers[HEADER.toLowerCase()]), "Unexpected root OAuth metadata header");
        } else if (names.includes(target)) {
          check(req.headers[HEADER.toLowerCase()] === undefined || tokens.includes(req.headers[HEADER.toLowerCase()]), "Unexpected bound OAuth metadata header");
        } else {
          check(target === "other-mcp" && req.headers[HEADER.toLowerCase()] === undefined, "OAuth metadata token leaked to unrelated MCP");
        }
        authDiscoveryRequests++;
        respond(404, { error: "No OAuth in isolated fixture" });
        return;
      }
      if (!req.url.startsWith("/mcp/")) {
        modelRequests++;
        unexpectedHttp.push(`${req.method} ${req.url}`);
        respond(500, { error: "No model/network requests are permitted" });
        return;
      }
      const target = decodeURIComponent(req.url.slice("/mcp/".length));
      const bound = names.includes(target);
      check(bound || target === "other-mcp", `Unexpected MCP endpoint: ${req.url}`);
      const context = tokens.indexOf(req.headers[HEADER.toLowerCase()]);
      if (bound) {
        check(context >= 0, "Missing/unknown IDE-session transport header");
        if (revoked.has(context)) {
          rejectedCalls++;
          respond(401, { status: "ide_session_required", message: "Fixture session revoked" });
          return;
        }
        check(req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === HEADER.toLowerCase()).length === 1, "Duplicate IDE-session header");
      } else {
        check(context === -1 && req.headers[HEADER.toLowerCase()] === undefined, "IDE-session header leaked to other MCP");
      }
      check(req.headers["x-existing"] === "existing-static-header", "Existing static header lost");
      check(req.headers["x-existing-env"] === "existing-env-header", "Existing env header lost");
      if (req.method !== "POST") {
        events.push({ target, context, method: `http:${req.method}` });
        res.writeHead(405); res.end(); return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        check(size < 1024 * 1024, "Oversized fixture request");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString();
      noSecrets(raw, "MCP request body");
      const body = JSON.parse(raw);
      events.push({ target, context, method: body.method });
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      switch (body.method) {
        case "initialize":
          result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "isolated-session-fixture", version: "1" } };
          break;
        case "tools/list":
          result = { tools };
          break;
        case "tools/call":
          check(body.params.name === "context", "Unexpected fixture tool");
          result = { content: [{ type: "text", text: JSON.stringify({ target, context }) }], isError: false };
          break;
        case "resources/list": result = { resources: [] }; break;
        case "resources/templates/list": result = { resourceTemplates: [] }; break;
        case "prompts/list": result = { prompts: [] }; break;
        default: throw new Error(`Unexpected MCP method: ${body.method}`);
      }
      respond(200, { jsonrpc: "2.0", id: body.id, result });
    } catch (error) {
      fixtureErrors.push(clean(error.message));
      respond(500, { error: "Isolated MCP fixture rejected request" });
    }
  });
  try {
    const schemaDir = path.join(root, "schema");
    const generated = spawnSync(binary, ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir], {
      cwd: root, env: baseEnv(home), encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024,
    });
    check(generated.status === 0, `Schema generation failed: ${clean(generated.stderr || generated.error?.message)}`);
    const schema = (name) => JSON.parse(fs.readFileSync(path.join(schemaDir, "v2", `${name}.json`), "utf8"));
    assert.deepEqual(schema("McpServerToolCallParams").required, ["server", "threadId", "tool"]);
    check(schema("ThreadStartParams").properties.ephemeral, "Missing ephemeral thread schema");
    assert.deepEqual(schema("CommandExecParams").required, ["command"]);
    check(schema("CommandExecParams").properties.env, "Missing command environment override schema");
    console.log(`PASS native schema: direct MCP call + ephemeral thread + standalone command/exec (${process.platform}/${process.arch})`);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const servers = Object.fromEntries([...names, "other-mcp"].map((name) => [name, {
      url: `${url}/mcp/${encodeURIComponent(name)}`, startup_timeout_sec: 10, tool_timeout_sec: 10,
      http_headers: { "X-Existing": "existing-static-header" },
      env_http_headers: { "X-Existing-Env": "ELEMENT_SMOKE_EXISTING_HEADER" },
    }]));
    const config = [
      'model = "local-smoke"', 'model_provider = "local_smoke"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      `[projects.${toml(root)}]`, 'trust_level = "trusted"',
      '[analytics]', 'enabled = false',
      '[model_providers.local_smoke]', 'name = "No-cloud fixture"', `base_url = "${url}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0',
      '[shell_environment_policy]', 'inherit = "all"', 'ignore_default_excludes = true',
      'exclude = ["ELEMENT_SMOKE_LEGACY", "ELEMENT_SMOKE_OLD_*"]',
      'set = { ELEMENT_SMOKE_SET = "existing-set" }',
      ...Object.entries(servers).flatMap(([name, value]) => [
        `[mcp_servers.${toml(name)}]`,
        ...Object.entries(value).map(([key, item]) => `${key} = ${toml(item)}`),
      ]),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(home, "config.toml"), config, { mode: 0o600 });
    expectedConfig = config;
    const browser = { command: process.execPath, args: [__filename, "--stdio-fixture", "browser"], enabled: true, startup_timeout_sec: 10, tool_timeout_sec: 10 };
    const stdioServers = {
      browser,
      "stdio-forwarded": { ...browser, args: [__filename, "--stdio-fixture", "stdio-forwarded"], env_vars: [TOKEN_ENV] },
      "stdio-cleared": { ...browser, args: [__filename, "--stdio-fixture", "stdio-cleared"], env_vars: [TOKEN_ENV], env: { [TOKEN_ENV]: "" } },
    };
    const quotedPath = `mcp_servers."element".env_http_headers."${HEADER}"="${TOKEN_ENV}"`;
    const quoted = new Runtime(binary, root, home, [quotedPath, `mcp_servers."element".url=${toml(servers.element.url)}`], tokens[0]);
    runtimes.push(quoted);
    await quoted.initialize();
    const quotedConfig = (await quoted.request("config/read", { cwd: root, includeLayers: false })).config;
    check(quotedConfig.mcp_servers.element !== undefined, "Original ordinary server disappeared");
    check(quotedConfig.mcp_servers['"element"']?.env_http_headers?.[`"${HEADER}"`] === TOKEN_ENV, "Quoted CLI path no longer produces literal quote characters");
    await quoted.stop();
    console.log("PASS quoted-path negative control: literal quotes remain in BOTH server name and header name");
    const invalidQuoted = new Runtime(binary, root, home, [quotedPath], tokens[0]);
    runtimes.push(invalidQuoted);
    await assert.rejects(() => invalidQuoted.initialize(), /invalid transport/);
    await invalidQuoted.stop();
    console.log("PASS current quoted binding alone fails config load (new literal-name server has no transport)");
    const partial = `mcp_servers=${toml({ "element.quoted": { env_http_headers: { [HEADER]: TOKEN_ENV } } })}`;
    const browserOverride = `mcp_servers.browser=${toml(browser)}`;
    const parentAfterChild = new Runtime(binary, root, home, [browserOverride, partial], tokens[0]);
    runtimes.push(parentAfterChild);
    await parentAfterChild.initialize();
    const partialConfig = (await parentAfterChild.request("config/read", { cwd: root, includeLayers: false })).config;
    for (const name of [...names, "other-mcp"]) {
      const actual = partialConfig.mcp_servers[name];
      check(actual?.url === servers[name].url, "Partial table lost a base server URL");
      check(actual.http_headers?.["X-Existing"] === "existing-static-header", "Partial table lost a base static header");
      check(actual.env_http_headers?.["X-Existing-Env"] === "ELEMENT_SMOKE_EXISTING_HEADER", "Partial table lost a base env header");
    }
    check(partialConfig.mcp_servers["element.quoted"].env_http_headers[HEADER] === TOKEN_ENV, "Partial dotted-name binding missing");
    check(partialConfig.mcp_servers.browser === undefined, "CLI parent-after-child behavior changed: browser was unexpectedly retained");
    await parentAfterChild.stop();
    console.log("PASS minimal partial deep-merges base servers/URLs/headers without copying existing values to argv");
    console.log("PASS CLI ordering negative control: later mcp_servers partial replaces earlier CLI browser override");
    const bindingPatches = Object.fromEntries(names.map((name) => [name, { env_http_headers: { [HEADER]: TOKEN_ENV } }]));
    const overrides = (context, policy = "set") => [
      ...(context === 0 ? [
        partial,
        ...names.filter((name) => !name.includes(".")).map((name) => `mcp_servers.${name}.env_http_headers.${HEADER}="${TOKEN_ENV}"`),
        browserOverride,
      ] : [`mcp_servers=${toml({ ...bindingPatches, browser })}`]),
      ...Object.entries(stdioServers).filter(([name]) => name !== "browser").map(([name, value]) => `mcp_servers.${name}=${toml(value)}`),
      ...(policy === "set" ? [`shell_environment_policy.set.${TOKEN_ENV}=""`] : []),
      ...(policy === "filters" ? [`shell_environment_policy.filters.${TOKEN_ENV}="exclude"`] : []),
    ];
    for (const policy of ["baseline", "filters"]) {
      const runtime = new Runtime(binary, root, home, overrides(0, policy), tokens[0]);
      runtimes.push(runtime);
      await runtime.initialize();
      await runtime.environment(root, policy === "baseline" ? "present" : "absent", policy === "filters");
      await runtime.stop();
      console.log(policy === "baseline"
        ? "PASS negative control: unguarded command inherits token; legacy exact/glob excludes work"
        : "PASS compatibility probe: filters excludes token BUT disables legacy exact/glob excludes; not selected");
    }
    const windows = [];
    for (let context = 0; context < 2; context++) {
      const runtime = new Runtime(binary, root, home, overrides(context), tokens[context]);
      runtimes.push(runtime);
      windows.push(runtime);
      await runtime.initialize();
      await runtime.startThread(root);
      for (const name of [...names, "other-mcp"]) await runtime.context(name, names.includes(name) ? context : -1);
      const browserContext = await runtime.context("browser", -1);
      assert.equal(browserContext.token, "absent", "Default stdio MCP should not inherit arbitrary env");
      const forwarded = await runtime.context("stdio-forwarded", -1);
      assert.equal(forwarded.token, "present", "Explicit MCP env_vars forwarding negative control failed");
      const cleared = await runtime.context("stdio-cleared", -1);
      assert.equal(cleared.token, "empty", "Per-MCP env override must clear explicitly forwarded token");
      console.log("PASS stdio MCP env: default absent; explicit env_vars bypasses shell policy; per-MCP env override clears");
      console.log(`PASS process ${context}: initialize/tools/list/tools/call carry isolated headers; other MCP/browser override works`);
      await runtime.environment(root, "empty", false);
      if (process.platform !== "win32") await runtime.environment(root, "empty", false, undefined, true);
      await runtime.environment(root, "absent", false, { [TOKEN_ENV]: null });
      const effective = await runtime.request("config/read", { cwd: root, includeLayers: true });
      noSecrets(JSON.stringify(effective), "effective config/read and layers");
      const status = await runtime.request("mcpServerStatus/list", { cursor: null, limit: 100 });
      assert.deepEqual(status.data.map((item) => item.name).sort(), [...names, "other-mcp", ...Object.keys(stdioServers)].sort());
      check(status.data.every((item) => Object.keys(item.tools).length === 1), "MCP tool registration lost");
      const processCommand = process.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${runtime.child.pid}'; if (!$p) { exit 1 }; [Console]::Out.Write($p.CommandLine)`]]
        : ["ps", ["-p", String(runtime.child.pid), "-o", "command="]];
      const inspected = spawnSync(processCommand[0], processCommand[1], {
        // The observer needs the host's OS tooling environment, not the isolated runtime home.
        cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      });
      check(inspected.status === 0 && inspected.stdout?.trim(),
        `Could not inspect actual process argv (requires ps or Windows PowerShell/CIM): ${clean(inspected.error?.message || inspected.stderr || `exit ${inspected.status}`).slice(0, 2000)}`);
      noSecrets(inspected.stdout, "OS process argv");
    }
    console.log("PASS partial-before-browser and combined-process-local-partial variants; base header values absent from argv");
    console.log("PASS chosen child guard: set clears token, preserves legacy exact/glob excludes and unrelated set; command env:null unsets");
    for (let round = 0; round < 6; round++) {
      await Promise.all(windows.map((runtime, context) => runtime.context(names[round % names.length], context)));
    }
    console.log("PASS concurrent direct calls: two live processes, same CODEX_HOME/config/endpoints, distinct contexts");
    for (let context = 0; context < 2; context++) {
      const runtime = windows[context];
      const before = events.length;
      await runtime.request("config/mcpServer/reload", null);
      for (const name of names) await runtime.context(name, context);
      await runtime.startThread(root);
      for (const name of [...names, "other-mcp", ...Object.keys(stdioServers)]) await runtime.context(name, names.includes(name) ? context : -1);
      for (const name of names) for (const method of ["initialize", "tools/list", "tools/call"]) {
        check(events.slice(before).some((event) => event.target === name && event.context === context && event.method === method), `Reload missing ${method} for ${name}`);
      }
    }
    console.log("PASS config/mcpServer/reload: existing and fresh ephemeral threads retain both contexts and all MCPs");
    revoked.add(0);
    let refused = false;
    try { await windows[0].context(names[0], 0); } catch { refused = true; }
    check(refused && rejectedCalls > 0, "Revoked fixture session was not refused");
    await windows[1].context(names[0], 1);
    revoked.delete(0);
    console.log("PASS HTTP 401 negative control: revoked context fails, other window remains bound, no unbound retry");
    await windows[0].stop();
    const restarted = new Runtime(binary, root, home, overrides(0), tokens[0]);
    runtimes.push(restarted);
    await restarted.initialize();
    await restarted.startThread(root);
    for (const name of names) {
      await restarted.context(name, 0);
      await windows[1].context(name, 1);
    }
    await restarted.environment(root, "empty", false);
    console.log("PASS app-server restart: process-local binding restored while second process stays isolated");
    for (const name of names) for (let context = 0; context < 2; context++) {
      for (const method of ["initialize", "tools/list", "tools/call"]) {
        check(events.some((event) => event.target === name && event.context === context && event.method === method), `Missing ${method} for ${name}, context ${context}`);
      }
    }
    assert.deepEqual(fixtureErrors, []);
    check(modelRequests === 0, `Unexpected non-MCP HTTP request: ${unexpectedHttp.join(", ")}`);
    check(fs.readFileSync(path.join(home, "config.toml"), "utf8") === config, "Shared config mutated");
    check(process.env[TOKEN_ENV] === parentToken, "Host process environment mutated");
    console.log(`PASS shared config byte-identical, host environment untouched, zero model requests (${authDiscoveryRequests} loopback OAuth metadata probes)`);
  } finally {
    let cleanupError;
    for (const runtime of runtimes) {
      try { await runtime.stop(); } catch (error) { cleanupError ||= error; }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try {
      if (expectedConfig !== undefined) check(fs.readFileSync(path.join(home, "config.toml"), "utf8") === expectedConfig, "Shared config mutated during shutdown");
      console.log(`PASS secret audit: ${auditFiles(root)} temporary files (including schema, common state, config, logs), plus runtime stdout/stderr`);
    }
    catch (error) { cleanupError ||= error; }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (cleanupError) throw cleanupError;
  }
  console.log(`PASS all app-server 0.154.0 compatibility assertions on ${process.platform}/${process.arch}; fixtures only, real-MCP/IDE lifecycle not certified`);
}

if (process.argv[2] === "--stdio-fixture") stdioFixture();
else main().catch((error) => { console.error(`FAIL ${clean(error.message)}`); process.exitCode = 1; });

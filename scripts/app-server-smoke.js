"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const Module = require("node:module");
const ts = require("typescript");
const Ajv = require("ajv");
const { targetForPlatform, validateRuntimeFile } = require("./runtime-preflight-lib");
// Exercise the current transport without rebuilding or modifying dist.
const rpcFilename = path.resolve(__dirname, "../src/jsonRpcClient.ts");
const rpcModule = new Module(rpcFilename, module);
rpcModule._compile(ts.transpileModule(fs.readFileSync(rpcFilename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, rpcFilename);
const { JsonRpcClient } = rpcModule.exports;
const runtime = path.resolve(process.argv[2]);
const live = process.argv.includes("--live");
const authHomeIndex = process.argv.indexOf("--auth-home");
const contract = require(`./fixtures/app-server/${require("../bin/runtime-manifest.json").version}.json`);
const validators = new Map();
function validate(group, name, value) {
  const key = `${group}:${name}`;
  assert.ok(contract[group][name], `missing contract ${key}`);
  if (!validators.has(key)) validators.set(key, new Ajv({ strict: false, validateFormats: false }).compile({ ...contract[group][name], definitions: contract.definitions }));
  const fn = validators.get(key);
  assert.ok(fn(value), `${key}: ${JSON.stringify(fn.errors)}`);
}

async function main() {
  const target = targetForPlatform(`${process.platform}-${process.arch}`);
  assert.ok(target, "unsupported smoke host");
  assert.deepEqual(validateRuntimeFile(runtime, target, { required: true }).errors, [], "smoke requires a native executable; never run foreign binaries");
  assert.ok(authHomeIndex === -1 || live, "--auth-home is only allowed with explicit --live");
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-element-runtime-smoke-")));
  let child;
  let processClosed;
  let rpc;
  let reader;
  let completionTimer;
  let cleanupTimer;
  const notificationErrors = [];
  try {
    fs.chmodSync(temp, 0o700);
    if (authHomeIndex !== -1) {
      const authPath = path.join(path.resolve(process.argv[authHomeIndex + 1]), "auth.json");
      fs.copyFileSync(authPath, path.join(temp, "auth.json"));
      fs.chmodSync(path.join(temp, "auth.json"), 0o600);
    }
    const env = { ...process.env, CODEX_HOME: temp, HOME: temp, USERPROFILE: temp };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_AUTH_JSON"]) delete env[key];
    let completed;
    let finalText = "";
    let deltaCount = 0;
    const done = new Promise((resolve) => { completed = resolve; });
    async function start(configOverrides = []) {
      child = spawn(runtime, ["app-server", "-c", 'cli_auth_credentials_store="file"', ...configOverrides], { cwd: temp, env, stdio: ["pipe", "pipe", "pipe"] });
      processClosed = new Promise((resolve) => child.once("close", resolve));
      child.stderr.resume();
      rpc = new JsonRpcClient((line) => child.stdin.write(`${line}\n`), (notification) => {
        try {
          if (contract.notifications[notification.method]) validate("notifications", notification.method, notification);
          if (notification.method === "item/agentMessage/delta") deltaCount++;
          if (notification.method === "item/completed" && notification.params.item?.type === "agentMessage") finalText += notification.params.item.text;
          if (notification.method === "turn/completed") completed(notification.params.turn);
        } catch (error) { notificationErrors.push(error.message); }
      }, () => { throw new Error("No tool approvals allowed in smoke test"); });
      reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => rpc.handleLine(line));
      child.on("error", () => rpc.dispose());
      child.on("exit", () => rpc.dispose());
      const initialized = await request("initialize", { clientInfo: { name: "codex_element_smoke", version: "0.1.89" }, capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false, optOutNotificationMethods: null } }, "InitializeResponse");
      assert.ok(initialized.userAgent.includes(`/${contract.version} `), `unexpected runtime: ${initialized.userAgent}`);
      rpc.notify("initialized");
    }
    async function stop() {
      rpc?.dispose();
      reader?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        cleanupTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }
      await processClosed;
      clearTimeout(cleanupTimer);
    }
    async function request(method, params, responseName) {
      if (method === "thread/resume" || method === "thread/fork") assert.equal(params.excludeTurns, true);
      if (!live) assert.notEqual(method, "turn/start", "offline smoke must never generate a paid turn");
      validate("requests", method, { id: 1, method, ...(params === undefined ? {} : { params }) });
      const result = await rpc.request(method, params, 30000);
      if (responseName) validate("responses", responseName, result);
      console.log(`PASS ${method}`);
      return result;
    }
    async function contextFeature(threadId) {
      const features = [];
      const cursors = new Set();
      let cursor = null;
      do {
        assert.ok(!cursors.has(cursor) && cursors.size < 20, "unexpected feature pagination loop");
        cursors.add(cursor);
        const result = await request("experimentalFeature/list", { cursor, limit: 100, ...(threadId ? { threadId } : {}) }, "ExperimentalFeatureListResponse");
        features.push(...result.data);
        cursor = result.nextCursor;
      } while (cursor);
      const feature = features.find((entry) => entry.name === "context_management");
      assert.ok(feature, "context_management is missing from experimentalFeature/list");
      assert.equal(feature.defaultEnabled, false);
      return feature;
    }
    function smallHistoryReply(result) {
      assert.deepEqual(result.thread.turns, [], "excludeTurns must omit the full transcript");
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024, "history reply must remain small");
    }
    await start();
    const models = [];
    let cursor = null;
    do {
      const result = await request("model/list", { cursor, limit: 2, includeHidden: false }, "ModelListResponse");
      models.push(...result.data);
      cursor = result.nextCursor;
      assert.ok(models.length < 200, "unexpected model pagination loop");
    } while (cursor);
    const astra = models.find((item) => item.model === "gpt-6-astra");
    assert.ok(astra && !astra.hidden, "Astra missing from model/list");
    console.log(`Astra visible; default=${astra.isDefault}; efforts=${astra.supportedReasoningEfforts.map((entry) => entry.reasoningEffort).join(",")}`);
    const account = await request("account/read", { refreshToken: false }, "GetAccountResponse");
    console.log(`Account type: ${account.account?.type || "none"}`);
    if (!live) assert.equal(account.account, null, "offline smoke must not load real authentication");
    if (account.account?.type === "chatgpt") await request("account/rateLimits/read", undefined, "GetAccountRateLimitsResponse");
    await request("skills/list", { cwds: [temp], forceReload: true }, "SkillsListResponse");
    await request("mcpServerStatus/list", { cursor: null, limit: 100 }, "ListMcpServerStatusResponse");
    await request("config/mcpServer/reload", null);
    const thread = await request("thread/start", { cwd: temp, model: astra.model, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null, serviceName: "codex_element_smoke", sessionStartSource: "startup" }, "ThreadStartResponse");
    if (live) {
      assert.ok(account.account, "Live test needs --auth-home with an authenticated profile");
      await request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Reply with exactly OK. Do not use tools.", text_elements: [] }], cwd: temp, model: astra.model, effort: "low", serviceTier: null, approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } }, "TurnStartResponse");
      const turn = await Promise.race([done, new Promise((_, reject) => { completionTimer = setTimeout(() => reject(new Error("turn/completed timeout")), 90000); })]);
      assert.equal(turn.status, "completed", JSON.stringify(turn.error));
      assert.match(finalText, /\bOK\b/);
      console.log(`PASS Astra live turn: completed, ${deltaCount} streaming deltas, answer OK`);
      // Empty threads have no persisted rollout until their first turn.
      await request("thread/resume", { threadId: thread.thread.id, excludeTurns: true, cwd: temp, model: astra.model, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null }, "ThreadResumeResponse");
    } else {
      console.log("SKIP live generation (use --live --auth-home for a small authenticated Astra request)");
      const marker = "LARGE_HISTORY_FIXTURE:";
      const restored = await request("thread/resume", {
        threadId: randomUUID(), cwd: temp, excludeTurns: true,
        history: [
          { type: "message", role: "user", content: [{ type: "input_text", text: marker + "x".repeat(9 * 1024 * 1024) }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Stored fixture answer" }] }
        ]
      }, "ThreadResumeResponse");
      // The synthetic seed request can echo its input preview; production resumes use only the ID.
      assert.deepEqual(restored.thread.turns, []);
      const readStoredContext = (rolloutPath = restored.thread.path) => fs.readFileSync(rolloutPath, "utf8").trim().split("\n")
        .map(line => JSON.parse(line)).filter(entry => entry.type === "response_item").map(entry => entry.payload);
      const storedContext = JSON.stringify(readStoredContext());
      assert(storedContext.includes(marker) && Buffer.byteLength(storedContext) > 8 * 1024 * 1024);
      const resumed = await request("thread/resume", { threadId: restored.thread.id, excludeTurns: true }, "ThreadResumeResponse");
      assert.equal(resumed.thread.id, restored.thread.id);
      smallHistoryReply(resumed);
      assert.equal(JSON.stringify(readStoredContext()), storedContext, "resume must preserve stored context");
      console.log("PASS real runtime: >8 MiB saved context retained; excludeTurns accepted without model calls");

      const keyPath = "features.context_management.experimental_mode";
      const readConfig = () => request("config/read", { includeLayers: true, cwd: temp }, "ConfigReadResponse");
      const configuredFlag = (config) => config.features?.context_management?.experimental_mode;
      const userLayer = (result) => result.layers.find((layer) => layer.name.type === "user");
      assert.equal(fs.existsSync(path.join(temp, "config.toml")), false, "test the absent user config file");
      const before = await readConfig();
      assert.ok(Array.isArray(before.layers));
      assert.notEqual(configuredFlag(before.config), true);
      assert.equal((await contextFeature()).enabled, false);
      assert.equal((await contextFeature(restored.thread.id)).enabled, false);
      const layer = userLayer(before);
      // config.toml does not exist yet; canonicalize only its existing parent.
      assert.equal(path.join(fs.realpathSync.native(path.dirname(layer.name.file)), path.basename(layer.name.file)), path.join(temp, "config.toml"));
      assert.deepEqual(layer.config, {});
      assert.equal(layer.version, "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
      const written = await request("config/value/write", {
        keyPath, value: true, mergeStrategy: "upsert", filePath: layer.name.file, expectedVersion: layer.version
      }, "ConfigWriteResponse");
      assert.equal(written.status, "ok");
      assert.equal(fs.realpathSync.native(written.filePath), fs.realpathSync.native(layer.name.file));
      const after = await readConfig();
      assert.equal(configuredFlag(after.config), true);
      assert.equal(configuredFlag(userLayer(after).config), true);
      assert.equal(userLayer(after).version, written.version);
      assert.equal(after.origins[keyPath].name.type, "user");
      assert.equal((await contextFeature()).enabled, true);
      assert.equal((await contextFeature(restored.thread.id)).enabled, true);
      await assert.rejects(request("config/value/write", {
        keyPath, value: false, mergeStrategy: "upsert", filePath: layer.name.file, expectedVersion: layer.version
      }), /version|conflict/i);
      assert.equal(configuredFlag((await readConfig()).config), true, "stale writes must not alter the config");
      const fresh = await request("thread/start", { cwd: temp, model: astra.model, sandbox: "read-only" }, "ThreadStartResponse");
      assert.equal((await contextFeature(fresh.thread.id)).enabled, true);
      console.log("PASS native config write/read: user layer and feature/list update immediately, including a loaded thread; no activation claim without auth/model eligibility");

      const movedCwd = path.join(temp, "moved-project");
      fs.mkdirSync(movedCwd);
      const hot = await request("thread/resume", { threadId: restored.thread.id, cwd: movedCwd, excludeTurns: true }, "ThreadResumeResponse");
      assert.equal(hot.thread.id, restored.thread.id);
      assert.equal(fs.realpathSync.native(hot.cwd), temp, "an already loaded thread ignores cwd overrides on resume");
      smallHistoryReply(hot);
      assert.equal(JSON.stringify(readStoredContext()), storedContext);
      await stop();
      await start();
      assert.equal(configuredFlag((await readConfig()).config), true, "native config must survive process restart");
      const cold = await request("thread/resume", { threadId: restored.thread.id, cwd: movedCwd, excludeTurns: true }, "ThreadResumeResponse");
      assert.equal(cold.thread.id, restored.thread.id);
      assert.equal(fs.realpathSync.native(cold.cwd), fs.realpathSync.native(movedCwd), "cold resume must apply the cwd override");
      assert.equal(fs.realpathSync.native(cold.thread.cwd), temp, "thread metadata retains the original cwd; use response.cwd for the active session");
      smallHistoryReply(cold);
      assert.equal(JSON.stringify(readStoredContext(cold.thread.path)), storedContext, "cold resume must retain every stored response item");
      assert.equal((await contextFeature(cold.thread.id)).enabled, true);
      const fork = await request("thread/fork", { threadId: cold.thread.id, cwd: movedCwd, excludeTurns: true }, "ThreadForkResponse");
      assert.notEqual(fork.thread.id, cold.thread.id);
      assert.equal(fs.realpathSync.native(fork.cwd), fs.realpathSync.native(movedCwd));
      smallHistoryReply(fork);
      // A fork may append its own context message; all original items must remain in order.
      assert.deepEqual(readStoredContext(fork.thread.path).slice(0, readStoredContext().length), readStoredContext());
      assert.equal(JSON.stringify(readStoredContext()), storedContext, "fork must not modify its parent context");
      console.log("PASS loaded resume keeps cwd; restart + resume changes response.cwd, preserves thread ID and >8 MiB history; fork retains context with a small reply");

      await request("config/value/write", { keyPath, value: false, mergeStrategy: "upsert" }, "ConfigWriteResponse");
      assert.equal(configuredFlag((await readConfig()).config), false);
      assert.equal((await contextFeature()).enabled, false);
      assert.equal((await contextFeature(cold.thread.id)).enabled, false);
      await stop();
      await start(["-c", `${keyPath}=true`]);
      assert.equal((await contextFeature()).enabled, true);
      const overridden = await request("config/value/write", { keyPath, value: false, mergeStrategy: "upsert" }, "ConfigWriteResponse");
      assert.equal(overridden.status, "okOverridden");
      assert.equal(overridden.overriddenMetadata.effectiveValue, true);
      assert.equal(overridden.overriddenMetadata.overridingLayer.name.type, "sessionFlags");
      const flaggedConfig = await readConfig();
      assert.equal(configuredFlag(flaggedConfig.config), true);
      assert.equal(configuredFlag(userLayer(flaggedConfig).config), false);
      assert.equal((await contextFeature()).enabled, true);
      await stop();
      await start();
      assert.equal((await contextFeature()).enabled, false);
      console.log("PASS -c context flag is accepted and overrides user writes (okOverridden); removing the CLI override restores the saved value");
      await assert.rejects(request("thread/resume", { threadId: randomUUID(), excludeTurns: true }), /^Error: thread\/resume: no rollout found for thread id/);
      console.log("PASS missing rollout has the explicit error required for history replacement");
      await request("account/logout", undefined, "LogoutAccountResponse");
    }
    assert.deepEqual(notificationErrors, []);
    console.log("Runtime smoke test passed.");
  } finally {
    clearTimeout(completionTimer);
    rpc?.dispose();
    reader?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      cleanupTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }
    await processClosed;
    clearTimeout(cleanupTimer);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

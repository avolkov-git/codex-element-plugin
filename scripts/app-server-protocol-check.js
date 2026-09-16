"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const Ajv = require("ajv");
const manifest = require("../bin/runtime-manifest.json");
if (process.argv[2] === "--generate-fixture") {
  assert.ok(process.argv[3], "Usage: --generate-fixture <native-runtime>");
  generateFixture(path.resolve(process.argv[3]));
  process.exit(0);
}
const contracts = ["0.144.5", "0.153.4", "0.154.0"].map((version) => require(`./fixtures/app-server/${version}.json`));
assert.equal(contracts.at(-1).version, manifest.version, "protocol fixture must cover the shipped runtime");
assert.ok(manifest.files.some((file) => file.sha256 === contracts.at(-1).source.runtimeSha256), "fixture must come from a pinned runtime binary");
const validators = new Map();
const validationFailures = [];
function check(group, name, payload, checkedContracts = contracts) {
  for (const contract of checkedContracts) {
    const key = `${contract.version}:${group}:${name}`;
    if (!validators.has(key)) {
      assert.ok(contract[group][name], `${key} is missing`);
      validators.set(key, new Ajv({ strict: false, validateFormats: false }).compile({ ...contract[group][name], definitions: contract.definitions }));
    }
    const validate = validators.get(key);
    if (!validate(JSON.parse(JSON.stringify(payload)))) validationFailures.push(`${key}: ${JSON.stringify(validate.errors)}`);
    assert.ok(!validate.errors, `${key}: ${JSON.stringify(validate.errors)}`);
  }
}

function generateFixture(runtime) {
  const { targetForPlatform, validateRuntimeFile } = require("./runtime-preflight-lib");
  const target = targetForPlatform(`${process.platform}-${process.arch}`);
  assert.ok(target, "unsupported schema-generation host");
  assert.deepEqual(validateRuntimeFile(runtime, target, { required: true }).errors, [], "schema generation requires a native executable");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-protocol-schema-"));
  try {
    const env = { ...process.env, CODEX_HOME: temp };
    const version = execFileSync(runtime, ["--version"], { encoding: "utf8", env }).trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
    assert.equal(version, manifest.version, "generate from the pinned release");
    const runtimeSha256 = createHash("sha256").update(fs.readFileSync(runtime)).digest("hex");
    assert.ok(manifest.files.some((file) => file.sha256 === runtimeSha256), "runtime checksum is not pinned");
    const out = path.join(temp, "schema");
    execFileSync(runtime, ["app-server", "generate-json-schema", "--experimental", "--out", out], { env });
    const fixture = { version, source: { command: "app-server generate-json-schema --experimental", runtimeSha256 }, definitions: {}, requests: {}, notifications: {}, serverRequests: {}, responses: {} };
    function normalize(value, fieldMap = false) {
      if (Array.isArray(value)) return value.map((entry) => normalize(entry));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => fieldMap || !["$schema", "title", "description", "default", "examples"].includes(key))
        .map(([key, entry]) => [key, normalize(entry, ["properties", "definitions", "patternProperties"].includes(key))]));
    }
    function read(name) {
      const schema = normalize(JSON.parse(fs.readFileSync(path.join(out, `${name}.json`), "utf8")));
      for (const [key, definition] of Object.entries(schema.definitions || {})) {
        if (Object.hasOwn(fixture.definitions, key)) assert.deepEqual(fixture.definitions[key], definition, `conflicting definition ${key}`);
        fixture.definitions[key] = definition;
      }
      delete schema.definitions;
      return schema;
    }
    for (const [group, name] of Object.entries({ requests: "ClientRequest", notifications: "ServerNotification", serverRequests: "ServerRequest" })) {
      for (const entry of read(name).oneOf) fixture[group][entry.properties.method.enum[0]] = entry;
    }
    const responseNames = [...Object.keys(require("./fixtures/app-server/0.153.4.json").responses),
      "ThreadForkResponse", "ToolRequestUserInputResponse", "ConfigReadResponse", "ConfigWriteResponse", "ExperimentalFeatureListResponse"];
    for (const name of responseNames) {
      const relative = [name, `v2/${name}`, `v1/${name}`].find((candidate) => fs.existsSync(path.join(out, `${candidate}.json`)));
      assert.ok(relative, `missing response schema ${name}`);
      fixture.responses[name] = read(relative);
    }
    const target = path.join(__dirname, "fixtures/app-server", `${version}.json`);
    fs.writeFileSync(target, `${JSON.stringify(fixture)}\n`);
    console.log(`Generated ${target} from sha256:${runtimeSha256}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const cwd = process.cwd();
const vscode = {
  EventEmitter: class { event() {} fire() {} dispose() {} },
  workspace: { workspaceFolders: [{ uri: { fsPath: cwd } }] },
  env: { openExternal: async () => true },
  Uri: { parse: (url) => url }
};
// Load current sources in memory; protocol checks must not depend on stale dist or a full build.
const filename = path.resolve(__dirname, "../src/codexRuntimeController.ts");
const runtimeModule = new Module(filename, module);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
const compile = (source, fileName) => ts.transpileModule(source, { fileName,
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
let StateStore, resolveManagedMcpElicitation;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  Module._extensions[".ts"] = (mod, file) => mod._compile(compile(fs.readFileSync(file, "utf8"), file), file);
  runtimeModule._compile(compile(fs.readFileSync(filename, "utf8"), filename) + "\nexports.testHelpers = { normalizeModelOptions, normalizeRateLimitsResult, normalizeDeviceCodeChallenge, normalizeSkillsList, normalizeMcpStatusPage, normalizeApprovalRequest };", filename);
  ({ StateStore } = require("../src/stateStore.ts"));
  ({ resolveManagedMcpElicitation } = require("../src/mcpElicitationPolicy.ts"));
} finally {
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs;
  else delete Module._extensions[".ts"];
}
const { CodexRuntimeController, testHelpers } = runtimeModule.exports;
const model = {
  id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "Fixture",
  hidden: false, isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
  serviceTiers: [{ id: "fast", name: "Fast", description: "Fixture" }]
};
const modelResponse = { data: [model], nextCursor: null };
const rateResponse = {
  rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 } },
  rateLimitsByLimitId: { astra: { limitId: "astra", limitName: "Astra", primary: { usedPercent: 40, windowDurationMins: 1440, resetsAt: 1800000000 }, secondary: null } }
};
const account = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: true };
const challenge = { type: "chatgptDeviceCode", loginId: "fixture-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" };
const turn = { id: "turn-1", items: [], status: "inProgress", error: null };
const seen = new Set();
const turnRequests = [];

async function checkConcurrentStartup() {
  const controller = Object.create(CodexRuntimeController.prototype);
  let running = false;
  let started = 0;
  let initialized;
  controller.processManager = { get isRunning() { return running; } };
  controller.startBackendSession = () => {
    started++;
    running = true;
    return new Promise((resolve) => { initialized = resolve; });
  };
  const first = controller.ensureBackendProcess();
  let secondReady = false;
  const second = controller.ensureBackendProcess().then(() => { secondReady = true; });
  await Promise.resolve();
  assert.equal(started, 1, "opening models during startup must not spawn another process");
  assert.equal(secondReady, false, "spawned is not initialized: requests must wait for initialize");
  initialized();
  await Promise.all([first, second]);
  assert.equal(secondReady, true);
  running = false;
  controller.startBackendSession = async () => { throw new Error("startup fixture failure"); };
  await assert.rejects(controller.ensureBackendProcess(), /startup fixture failure/);
  controller.startBackendSession = async () => { started++; running = true; };
  await controller.ensureBackendProcess();
  assert.equal(started, 2, "failed startup must not block a retry");
}

async function main() {
  await checkConcurrentStartup();
  check("requests", "config/read", { id: 1, method: "config/read", params: { includeLayers: true, cwd } });
  for (const value of [true, false]) {
    check("requests", "config/value/write", { id: 1, method: "config/value/write", params: {
      keyPath: "features.context_management.experimental_mode", value, mergeStrategy: "upsert",
      filePath: path.join(cwd, "config.toml"), expectedVersion: `sha256:${"0".repeat(64)}`
    } });
  }
  for (const threadId of [undefined, "thread-1"]) {
    check("requests", "experimentalFeature/list", { id: 1, method: "experimentalFeature/list", params: { cursor: null, limit: 20, threadId } });
  }
  check("serverRequests", "item/tool/requestUserInput", { id: 8, method: "item/tool/requestUserInput", params: {
    threadId: "thread-1", turnId: turn.id, itemId: "question-1", isBlocking: true,
    questions: [{ id: "environment", header: "Environment", question: "Which environment?", isOther: true, isSecret: false,
      options: [{ label: "Test", description: "Use the test environment." }] }]
  } });
  check("responses", "ToolRequestUserInputResponse", { answers: { environment: { answers: ["Test"] } } }, [contracts.at(-1)]);
  check("responses", "ModelListResponse", modelResponse);
  check("responses", "GetAccountRateLimitsResponse", rateResponse);
  check("responses", "GetAccountResponse", account);
  check("responses", "LoginAccountResponse", challenge);
  const normalized = testHelpers.normalizeModelOptions(modelResponse);
  assert.equal(normalized.find((option) => option.id === null).defaultEffort, "medium");
  assert.deepEqual(normalized.find((option) => option.id === model.id).supportedEfforts.map((entry) => entry.value), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(testHelpers.normalizeDeviceCodeChallenge(challenge).userCode, "TEST-ONLY");
  assert.ok(testHelpers.normalizeRateLimitsResult(rateResponse).rows.some((row) => row.label?.includes("Astra")));

  const state = new StateStore();
  const chat = state.createChat("general");
  const controller = new CodexRuntimeController({
    state, context: { extension: { packageJSON: { version: "0.1.89" } }, globalStorageUri: { fsPath: cwd } },
    logger: { info() {}, warn() {}, error() {} }, onDidChange() {}, onDidChangeChat() {},
    attachments: { resolve: async (items) => items },
    contextOrchestrator: { buildTurnContext: async () => ({ input: [
      { type: "text", text: "Fixture", text_elements: [] },
      { type: "localImage", path: path.join(cwd, "fixture.png"), detail: "auto" },
      { type: "mention", name: "Fixture", path: path.join(cwd, "fixture.txt") },
      { type: "skill", name: "fixture", path: path.join(cwd, "SKILL.md") }
    ], worklog: { entries: [], label: "" } }) }
  });
  controller.ensureBackendProcess = async () => {};
  controller.processManager = { isRunning: true, stop: async () => {}, dispose() {} };
  let rejectResumeOverrides = false;
  const resumePayloads = [];
  controller.rpcClient = {
    request: async (method, params) => {
      check("requests", method, { id: 1, method, ...(params === undefined ? {} : { params }) });
      seen.add(method);
      if (method === "model/list") return modelResponse;
      if (method === "initialize") return { userAgent: "fixture", codexHome: cwd, platformOs: "macos", platformFamily: "unix" };
      if (method === "account/read") return account;
      if (method === "account/rateLimits/read") return rateResponse;
      if (method === "account/login/start") return params.type === "chatgptDeviceCode" ? challenge : { type: "apiKey" };
      if (method === "thread/resume") {
        assert.equal(params.excludeTurns, true, "resume must not return the full server transcript");
        resumePayloads.push(params);
        if (rejectResumeOverrides && Object.hasOwn(params, "cwd")) throw new Error("invalid request: fixture override rejection");
        return { thread: { id: "thread-1" } };
      }
      if (method === "thread/fork") {
        assert.equal(params.excludeTurns, true, "fork must not return the full server transcript");
        return { thread: { id: "thread-fork" } };
      }
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") { turnRequests.push(params); return { turn }; }
      if (method === "turn/steer") return { turnId: turn.id };
      if (method === "skills/list" || method === "mcpServerStatus/list") return { data: [], nextCursor: null };
      if (method === "mcpServer/oauth/login") return { authorizationUrl: "https://example.invalid/oauth" };
      return {};
    },
    notify(method) { assert.equal(method, "initialized"); }, dispose() {}
  };
  await controller.initializeBackendSession();
  await controller.startDeviceCodeLogin();
  await controller.loginWithApiKey("fixture-not-a-real-key");
  await controller.loadModelOptions(true);
  assert.equal(state.getChatSnapshot(chat.id).modelOptionsStatus, "ready");
  await controller.loadSkills(true);
  await controller.setSkillEnabled({ name: "fixture", path: path.join(cwd, "SKILL.md") }, false);
  await controller.loadMcpRuntimeStatuses();
  await controller.reloadMcpServers();
  await controller.startMcpOAuth("fixture");
  for (const accessMode of ["read-only", "workspace-write", "danger-full-access"]) {
    state.updateChat(chat.id, { accessMode });
    await controller.startBackendThread(chat.id);
    await controller.startTurn(chat.id, "Fixture", "normal");
  }
  state.setChatModel(chat.id, model.id, model.displayName);
  state.setChatEffort(chat.id, "ultra");
  state.setChatSpeed(chat.id, "fast");
  await controller.startTurn(chat.id, "Fixture", "planning");
  assert.equal(turnRequests.at(-1).model, "gpt-6-astra");
  assert.equal(turnRequests.at(-1).effort, "ultra");
  assert.equal(turnRequests.at(-1).serviceTier, "fast");
  assert.equal(turnRequests.at(-1).sandboxPolicy.type, "readOnly");
  state.invalidateModelOptions();
  assert.equal(state.getChat(chat.id).effort, "ultra", "catalog invalidation must preserve saved effort");
  assert.equal(state.getChat(chat.id).speed, "fast", "catalog invalidation must preserve saved speed");
  assert.equal(state.getChat(chat.id).modelId, "gpt-6-astra");
  await controller.loadModelOptions(true);
  await controller.resumeBackendThread(chat.id);
  rejectResumeOverrides = true;
  await controller.resumeBackendThread(chat.id);
  assert.deepEqual(resumePayloads.at(-1), { threadId: "thread-1", excludeTurns: true });
  await controller.forkChat(chat.id, "Protocol fixture fork");
  state.updateChat(chat.id, { status: "running", activeTurnId: turn.id });
  await controller.steerTurn(chat.id, "Additional instruction");
  await controller.requestTurnInterrupt("thread-1", turn.id);
  check("requests", "thread/compact/start", { id: 1, method: "thread/compact/start", params: { threadId: "thread-1" } });
  check("requests", "account/logout", { id: 1, method: "account/logout" });

  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    const request = { id: 9, method, params: { threadId: "thread-1", turnId: turn.id, itemId: "tool-1", cwd, startedAtMs: 1800000000000, permissions: { network: { enabled: true } } } };
    check("serverRequests", method, request);
    const approval = testHelpers.normalizeApprovalRequest(request, new Map());
    const responseName = method.includes("commandExecution") ? "CommandExecutionRequestApprovalResponse" : method.includes("fileChange") ? "FileChangeRequestApprovalResponse" : "PermissionsRequestApprovalResponse";
    for (const decision of [true, false]) check("responses", responseName, approval.resolvePayload(decision));
  }
  const elicitation = { id: 10, method: "mcpServer/elicitation/request", params: {
    threadId: "thread-1", turnId: turn.id, serverName: "codex-element-browser", mode: "form", message: "Fixture",
    requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "browser_navigate" }
  } };
  check("serverRequests", elicitation.method, elicitation);
  check("responses", "McpServerElicitationRequestResponse", resolveManagedMcpElicitation(elicitation, { threadId: "thread-1", turnId: turn.id, activeVisibleTurn: true }).response);

  function notify(method, params) {
    check("notifications", method, { method, params });
    controller.handleNotification({ method, params });
  }
  const ids = { threadId: "thread-1", turnId: turn.id };
  notify("turn/started", { threadId: ids.threadId, turn });
  const message = { type: "agentMessage", id: "message-1", text: "", phase: "final_answer" };
  notify("item/started", { ...ids, item: message, startedAtMs: 1800000000000 });
  notify("item/agentMessage/delta", { ...ids, itemId: message.id, delta: "Fixture streamed answer" });
  const command = { type: "commandExecution", id: "command-1", command: "echo fixture", cwd, commandActions: [], status: "inProgress" };
  notify("item/started", { ...ids, item: command, startedAtMs: 1800000000000 });
  notify("item/commandExecution/outputDelta", { ...ids, itemId: command.id, delta: "fixture\n" });
  notify("item/completed", { ...ids, item: { ...command, status: "completed", aggregatedOutput: "fixture\n", exitCode: 0, durationMs: 1 }, completedAtMs: 1800000000001 });
  const compact = { type: "contextCompaction", id: "compact-1" };
  notify("item/started", { ...ids, item: compact, startedAtMs: 1800000000001 });
  notify("item/completed", { ...ids, item: compact, completedAtMs: 1800000000002 });
  const diff = "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n";
  notify("turn/diff/updated", { ...ids, diff });
  notify("turn/plan/updated", { ...ids, plan: [{ step: "Fixture", status: "completed" }], explanation: null });
  notify("item/completed", { ...ids, item: { ...message, text: "Fixture streamed answer" }, completedAtMs: 1800000000003 });
  const question = { type: "agentMessage", id: "question-1", text: "Which environment?\n- Test\n- Production", phase: "final_answer", delivery: "async", questions: [
    { title: "Which environment?", options: ["Test", "Production"] }, { title: "Details?", options: null }, { title: "Additional context?" }
  ] };
  notify("item/started", { ...ids, item: question, startedAtMs: 1800000000004 });
  notify("item/completed", { ...ids, item: question, completedAtMs: 1800000000004 });
  assert.equal(state.getChat(chat.id).status, "running", "async question must not complete or pause the turn");
  const structured = state.exportChatHistory().transcripts[chat.id].find(item => item.backendItemId === question.id);
  assert.deepEqual(structured.questions.map(item => item.options), [["Test", "Production"], null, null]);
  assert.equal(structured.backendThreadId, ids.threadId);
  assert.equal(new Set(structured.questions.map(item => item.id)).size, 3);
  assert.equal((await controller.respondToQuestion(chat.id, structured.id, structured.questions[0].id, "Custom environment")).accepted, true);
  notify("item/completed", { ...ids, item: { ...question, questions: null }, completedAtMs: 1800000000004 });
  assert.equal(state.getChatQuestion(chat.id, structured.id, structured.questions[0].id).answer, "Custom environment");
  assert.equal((await controller.respondToQuestion(chat.id, structured.id, structured.questions[0].id, "duplicate")).accepted, false);
  const continuation = { type: "agentMessage", id: "message-2", text: "", phase: "final_answer" };
  notify("item/started", { ...ids, item: continuation, startedAtMs: 1800000000005 });
  notify("item/agentMessage/delta", { ...ids, itemId: continuation.id, delta: "Fixture final answer" });
  notify("item/completed", { ...ids, item: { ...continuation, text: "Fixture final answer" }, completedAtMs: 1800000000006 });
  notify("account/rateLimits/updated", { rateLimits: rateResponse.rateLimitsByLimitId.astra });
  const usage = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 0 };
  notify("thread/tokenUsage/updated", { ...ids, tokenUsage: { total: usage, last: usage, modelContextWindow: 1050000 } });
  controller.maybeStartDiagnosticsAutoFix = async () => {};
  let nextQueued = false;
  controller.startNextQueuedPrompt = () => { nextQueued = true; return false; };
  notify("turn/completed", { threadId: ids.threadId, turn: { ...turn, status: "completed" } });
  const transcript = state.getChatSnapshot(chat.id).transcriptWindow.items;
  assert.ok(transcript.some((item) => item.kind === "message" && item.text?.includes("Fixture streamed answer")));
  assert.ok(transcript.some((item) => item.kind === "message" && item.text === question.text), "async question must remain visible after subsequent text");
  assert.ok(transcript.some((item) => item.kind === "message" && item.text === "Fixture final answer"));
  assert.ok(transcript.some((item) => item.kind === "diff"));
  assert.ok(transcript.some((item) => item.kind === "worklog" && item.operationKind === "command"));
  assert.equal(state.getChat(chat.id).status, "idle");
  assert.equal(nextQueued, true, "completed turn must still advance the local queue");
  controller.dispose();
  assert.deepEqual(validationFailures, [], "production catch handlers must not hide contract violations");
  for (const method of ["initialize", "account/read", "account/rateLimits/read", "account/login/start", "model/list", "skills/list", "skills/config/write",
    "mcpServerStatus/list", "config/mcpServer/reload", "mcpServer/oauth/login", "thread/start", "thread/resume", "thread/fork", "turn/start", "turn/steer", "turn/interrupt"]) {
    assert.ok(seen.has(method), `production request was not exercised: ${method}`);
  }
  console.log(`App-server protocol checks passed against ${contracts.map((contract) => contract.version).join(", ")}: ${seen.size} production request methods, native context config requests, excludeTurns on resume/fork, structured async questions/answers, model metadata, account, limits, approvals and MCP elicitation.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

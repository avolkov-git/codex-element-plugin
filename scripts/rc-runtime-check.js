"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const cp = require("node:child_process");
const ts = require("typescript");
const Ajv = require("ajv");
const root = path.resolve(__dirname, "..");
const fixture = path.join(__dirname, "fixtures/rc-runtime-child.js");
const contract = require("./fixtures/app-server/0.153.4.json");
const responseSchema = require("./fixtures/app-server/rc-native-input-response.json");
const ajv = new Ajv({ strict: false, validateFormats: false });
const validateInput = ajv.compile({ ...contract.serverRequests["item/tool/requestUserInput"], definitions: contract.definitions });
const validateResponse = ajv.compile(responseSchema);
const validateFork = ajv.compile({ ...contract.requests["thread/fork"], definitions: contract.definitions });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-runtime-check-"));
const vscode = {
  EventEmitter: class { event() {} fire() {} dispose() {} },
  workspace: { workspaceFolders: [{ uri: { fsPath: temp } }] },
  env: { openExternal: async () => true }, Uri: { parse: (value) => value }
};
function compile(source, filename) {
  return ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
}
// Run actual TypeScript sources in memory. Never build or read a stale dist.
const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
let CodexRuntimeController, StateStore, RuntimeProcessManager;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  Module._extensions[".ts"] = (mod, filename) => mod._compile(compile(fs.readFileSync(filename, "utf8"), filename), filename);
  ({ CodexRuntimeController } = require(path.join(root, "src/codexRuntimeController.ts")));
  ({ StateStore } = require(path.join(root, "src/stateStore.ts")));
  ({ RuntimeProcessManager } = require(path.join(root, "src/runtimeProcessManager.ts")));
} finally {
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs;
  else delete Module._extensions[".ts"];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, `Timed out: ${label}`);
    await sleep(5);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function isLive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "win32") return true;
    const status = cp.execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    return !status.startsWith("Z");
  } catch { return false; }
}
const managers = new Set();
const ownedPids = new Set();
async function spawnFixture(mode, extra = {}) {
  const manager = new RuntimeProcessManager();
  managers.add(manager);
  const messages = [], errors = [], exits = [];
  const pid = manager.start({ command: process.execPath, args: [fixture, mode], cwd: temp, env: { ...process.env },
    onStdout(line) { const value = JSON.parse(line); messages.push(value); if (value.pid) ownedPids.add(value.pid); },
    onStderr() {}, onError(error) { errors.push(error); }, onExit(...args) { exits.push(args); }, ...extra });
  ownedPids.add(pid);
  await until(() => messages.some((item) => item.ready === mode), `fixture ${mode} startup`);
  return { manager, pid, messages, errors, exits };
}

async function checkLifecycle() {
  for (const mode of ["tree", "graceful-root"]) {
    const { manager, pid, messages, exits } = await spawnFixture(mode);
    await until(() => messages.some((item) => item.ready === "leaf"), "descendant startup");
    const childPid = messages.find((item) => item.ready === "leaf").pid;
    const oldChild = manager.current.child;
    const stopping = manager.stop(80);
    assert.strictEqual(manager.stop(1), stopping, "concurrent stops share completion");
    assert.equal(manager.isRunning, true, "signalling is not exit");
    assert.throws(() => manager.start({}), /running|stopping/);
    await stopping;
    assert.equal(manager.isRunning, false);
    assert.equal(manager.pid, null);
    assert.equal(isLive(pid), false);
    assert.equal(isLive(childPid), false, "owned descendant must also exit");
    assert.equal(exits.length, 1);
    const ready = deferred();
    const replacement = manager.start({ command: process.execPath, args: [fixture, "leaf"], cwd: temp, env: process.env,
      onStdout() { ready.resolve(); }, onStderr() {}, onExit() {} });
    ownedPids.add(replacement);
    await ready.promise;
    oldChild.emit("exit", 42, null);
    oldChild.emit("error", new Error("late previous-generation event"));
    assert.equal(manager.pid, replacement, "old callbacks cannot clear new child");
    await manager.stop(0);
  }
  if (process.platform !== "win32") {
    const { manager, messages } = await spawnFixture("natural-root");
    await until(() => messages.some((item) => item.ready === "leaf"), "natural-exit child");
    await manager.stop(0);
    assert.equal(isLive(messages.find((item) => item.ready === "leaf").pid), false);
  }
  const { manager, errors } = await spawnFixture("oversized", { maxLineBytes: 256 });
  await until(() => errors.length > 0, "line bound error");
  assert.match(errors[0].message, /exceeds/);
  await manager.stop(0);
  const blocked = await spawnFixture("no-read", { maxLineBytes: 2048, maxPendingWriteBytes: 4096 });
  let pressure;
  for (let i = 0; i < 10_000 && !pressure; i++) {
    try { blocked.manager.writeLine("x".repeat(1024)); } catch (error) { pressure = error; }
  }
  assert.match(pressure?.message ?? "", /backpressure/);
  assert.ok(blocked.manager.current.child.stdin.writableLength <= 4096);
  await blocked.manager.stop(0);
  const failed = new RuntimeProcessManager();
  managers.add(failed);
  let spawnErrors = 0, spawnExits = 0;
  failed.start({ command: path.join(temp, "not-an-executable"), args: [], cwd: temp, env: {}, onStdout() {}, onStderr() {}, onError() { spawnErrors++; }, onExit() { spawnExits++; } });
  await until(() => spawnErrors > 0, "spawn failure");
  await failed.stop(0);
  assert.equal(spawnExits, 1);
}

async function checkWindowsAndStreams() {
  const children = [], kills = [];
  const module = { exports: {} };
  const file = path.join(root, "src/runtimeProcessManager.ts");
  const processStub = { platform: "win32", env: { SystemRoot: "C:\\Test Windows" } };
  vm.runInNewContext(compile(fs.readFileSync(file, "utf8"), file) + "\nexports.wireLineStream = wireLineStream;", {
    exports: module.exports, module, process: processStub, Buffer, setTimeout, clearTimeout, setImmediate,
    require(name) {
      if (name === "path") return path;
      if (name !== "child_process") throw new Error(name);
      return {
        spawn(command, args, options) {
          assert.equal(options.detached, false);
          const child = new EventEmitter();
          Object.assign(child, { pid: 987654, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
          children.push(child);
          return child;
        },
        execFile(command, args, options, callback) {
          kills.push({ command, args: Array.from(args), options });
          setImmediate(() => { children.at(-1).emit("exit", 1, null); children.at(-1).emit("close"); callback(null); });
        }
      };
    }
  });
  const manager = new module.exports.RuntimeProcessManager();
  let exited = 0;
  manager.start({ command: "fixture.exe", args: [], cwd: temp, env: {}, onStdout() {}, onStderr() {}, onExit() { exited++; } });
  const stop = manager.stop(1);
  assert.strictEqual(manager.stop(), stop);
  await stop;
  assert.equal(exited, 1);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].command, "C:\\Test Windows\\System32\\taskkill.exe");
  assert.deepEqual(kills[0].args, ["/PID", "987654", "/T", "/F"]);
  assert.equal(kills[0].options.windowsHide, true);
  const stream = new PassThrough();
  const lines = [], errors = [];
  let active = 0, peak = 0;
  module.exports.wireLineStream(stream, async (line) => {
    active++; peak = Math.max(peak, active); await sleep(1); lines.push(line); active--;
  }, (error) => errors.push(error), 32);
  stream.write(Buffer.from([0xe2, 0x82]));
  stream.write(Buffer.from([0xac, 0x0d]));
  stream.end("\none\ntwo");
  await until(() => lines.length === 3, "line drain");
  assert.deepEqual(lines, ["\u20ac", "one", "two"]);
  assert.equal(peak, 1, "slow async consumer must backpressure readable stream");
  assert.equal(errors.length, 0);
  const oversized = new PassThrough();
  module.exports.wireLineStream(oversized, () => assert.fail("overlong line delivered"), (error) => errors.push(error), 4);
  oversized.end("\u20ac\u20ac");
  await until(() => errors.length === 1, "UTF-8 byte limit");
}

function harness() {
  const state = new StateStore();
  const changes = [], logs = [];
  const options = {
    state, context: { extension: { packageJSON: { version: "test" } }, extensionUri: { fsPath: root }, globalStorageUri: { fsPath: temp } },
    logger: Object.fromEntries(["info", "warn", "error", "runtime"].map((level) => [level, (...args) => logs.push(args.join(" "))])),
    onDidChange() { changes.push("global"); }, onDidChangeChat(id) { changes.push(id); },
    attachments: { resolve: async (items) => items },
    contextOrchestrator: { buildTurnContext: async ({ prompt }) => ({ input: [{ type: "text", text: prompt, text_elements: [] }], worklog: { entries: [], label: "" } }) }
  };
  const runtime = new CodexRuntimeController(options);
  const chat = state.createChat("general");
  state.updateChat(chat.id, { backendThreadId: "thread-a", activeTurnId: "turn-a", status: "running" });
  state.setAuth({ status: "authenticated" });
  runtime.activeThreadChatId.set("thread-a", chat.id);
  runtime.activeTurnChatId.set("turn-a", chat.id);
  runtime.loadedThreadIds.add("thread-a");
  runtime.ensureBackendProcess = async () => {};
  runtime.maybeStartDiagnosticsAutoFix = async () => {};
  runtime.scheduleThinking = () => {};
  runtime.processManager = { isRunning: true, stop: async () => {}, dispose() {} };
  return { state, runtime, chat, options, changes, logs };
}

async function checkQuestions() {
  const h = harness(), sent = [];
  let callbacks;
  h.runtime.processManager = { isRunning: true, start(options) { callbacks = options; return 12345; }, writeLine(line) { sent.push(JSON.parse(line)); }, stop: async () => {}, dispose() {} };
  const managedServerName = "codex-element-browser-0123456789abcdef0123456789abcdef";
  await h.runtime.startBackendProcessAttempt({ runtimePath: process.execPath, args: [], cwd: temp, env: {}, mode: "normal", managedServerName });
  const elicitation = (id, serverName, extra = {}) => ({ id, method: "mcpServer/elicitation/request", params: {
    threadId: "thread-a", turnId: "turn-a", serverName, mode: "form", message: "test",
    requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "browser_navigate" }, ...extra
  } });
  for (const name of ["codex-element-browser", "codex-element-browser-foreign", managedServerName + "-suffix", "other-mcp"]) {
    const result = h.runtime.handleMcpElicitationRequest(elicitation(100, name));
    assert.equal(result.action, "decline", `untrusted MCP name ${name} must never autoapprove`);
  }
  assert.equal(h.runtime.handleMcpElicitationRequest(elicitation(101, managedServerName)).action, "accept");
  assert.equal(h.runtime.handleMcpElicitationRequest(elicitation(102, managedServerName, { turnId: "old-turn" })).action, "decline");
  assert.equal(h.runtime.handleMcpElicitationRequest(elicitation(103, managedServerName, { requestedSchema: { type: "object", properties: { password: { type: "string" } } } })).action, "decline");
  const request = (id, params = {}) => ({ id, method: "item/tool/requestUserInput", params: {
    threadId: "thread-a", turnId: "turn-a", itemId: `item-${id}`, isBlocking: true,
    questions: [{ id: "pick", header: "Scope", question: "Select scope", isOther: true, options: [{ label: "Test", description: "Test scope" }] }, { id: "secret", header: "Secret", question: "Value", isSecret: true, options: null }], ...params
  } });
  const send = (payload) => callbacks.onStdout(JSON.stringify(payload));
  const q1 = request(0), q2 = request("0");
  assert.ok(validateInput(q1), JSON.stringify(validateInput.errors));
  send(q1); send(q2);
  assert.equal(sent.length, 0, "questions must wait for answers");
  const snapshot = h.state.getChatSnapshot(h.chat.id);
  assert.equal(snapshot.pendingUserInputs.length, 2);
  assert.notEqual(snapshot.pendingUserInputs[0].id, snapshot.pendingUserInputs[1].id);
  assert.equal(snapshot.pendingUserInput.isBlocking, true);
  assert.equal(h.state.exportChatHistory().chats[0].pendingUserInput, null);
  assert.equal(h.runtime.resolveUserInput("wrong-chat", snapshot.pendingUserInput.id, null), false);
  assert.throws(() => h.runtime.resolveUserInput(h.chat.id, snapshot.pendingUserInput.id, { answers: {} }), /every/);
  const answer = { answers: { pick: { answers: ["Other choice"] }, secret: { answers: ["secret-never-persist"] } } };
  assert.equal(h.runtime.resolveUserInput(h.chat.id, snapshot.pendingUserInput.id, answer), true);
  await until(() => sent.length === 1, "native answer reply");
  assert.equal(sent[0].id, 0);
  assert.deepEqual(sent[0].result, answer);
  assert.ok(validateResponse(sent[0].result), JSON.stringify(validateResponse.errors));
  assert.equal(h.runtime.resolveUserInput(h.chat.id, snapshot.pendingUserInput.id, answer), false);
  assert.equal(JSON.stringify(h.state.exportChatHistory()).includes("secret-never-persist"), false);
  assert.equal(h.logs.join("\n").includes("secret-never-persist"), false);
  send({ method: "serverRequest/resolved", params: { requestId: "0", threadId: "wrong-thread" } });
  assert.equal(h.state.getChatSnapshot(h.chat.id).pendingUserInputs.length, 1);
  send({ method: "serverRequest/resolved", params: { requestId: "0", threadId: "thread-a" } });
  await sleep(1);
  assert.equal(sent.length, 1, "already-resolved server request must not receive another response");
  assert.equal(h.state.getChatSnapshot(h.chat.id).pendingUserInput, null);
  send(request(2));
  h.runtime.resolveUserInput(h.chat.id, h.state.getChatSnapshot(h.chat.id).pendingUserInput.id, null);
  await until(() => sent.some((reply) => reply.id === 2), "cancel reply");
  assert.ok(sent.find((reply) => reply.id === 2).error);
  send(request(3, { autoResolutionMs: 5 }));
  await until(() => sent.some((reply) => reply.id === 3), "timeout reply");
  assert.match(sent.find((reply) => reply.id === 3).error.message, /timed out/);
  send(request(4, { threadId: "stale-thread" }));
  send({ id: 5, method: "future/requiredRequest", params: { secret: "do-not-log" } });
  send(request(6, { questions: [{ id: "x" }] }));
  await until(() => sent.some((reply) => reply.id === 6), "malformed reply");
  for (const id of [4, 5, 6]) assert.ok(sent.find((reply) => reply.id === id).error, `request ${id} must fail explicitly`);
  assert.equal(h.logs.join("\n").includes("do-not-log"), false);
  send(request(7));
  h.runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed", error: null } } });
  assert.equal(h.state.getChatSnapshot(h.chat.id).pendingUserInput, null);
  await h.runtime.stopForIdentityChange();
  assert.equal(h.runtime.managedBrowserServerName, null, "trusted server identity must end with process epoch");
  assert.equal(h.runtime.activeThreadChatId.size, 0);
  assert.equal(h.state.getChat(h.chat.id).backendThreadId, "thread-a", "identity stop must not erase persisted conversation IDs");
  h.runtime.dispose();
}

async function checkQueueAndScoping() {
  const h = harness();
  h.state.updateChat(h.chat.id, { status: "idle", activeTurnId: null });
  const queue = h.state.enqueueChatMessage(h.chat.id, "Durable prompt", "normal");
  const barrier = deferred();
  h.options.beforeQueuedDispatch = () => barrier.promise;
  let attempts = 0;
  h.runtime.rpcClient = { request: async (method) => { assert.equal(method, "turn/start"); attempts++; throw new Error("synthetic dispatch failure"); }, dispose() {} };
  assert.equal(h.runtime.startNextQueuedPrompt(h.chat.id), true);
  assert.equal(h.runtime.startNextQueuedPrompt(h.chat.id), false);
  assert.equal(h.state.getChat(h.chat.id).queuedMessages[0].dispatchState, "dispatching");
  assert.equal(h.state.removeQueuedChatMessage(h.chat.id, queue.id), false);
  await sleep(10);
  assert.equal(attempts, 0, "dispatch must await durability barrier");
  const dispatch = h.runtime.queuedDispatches.get(h.chat.id);
  barrier.resolve();
  await dispatch;
  const failed = h.state.getChat(h.chat.id).queuedMessages[0];
  assert.equal(failed.id, queue.id);
  assert.equal(failed.text, "Durable prompt");
  assert.equal(failed.dispatchState, "failed");
  assert.match(failed.dispatchError, /synthetic/);
  assert.equal(h.runtime.startNextQueuedPrompt(h.chat.id), false, "no automatic retry storm");
  const restored = new StateStore();
  restored.replaceChatHistory(h.state.exportChatHistory());
  assert.equal(restored.getChat(h.chat.id).queuedMessages[0].dispatchState, "failed");
  h.runtime.rpcClient.request = async () => ({ turn: { id: "accepted-1" } });
  assert.equal(h.runtime.retryQueuedPrompt(h.chat.id, queue.id), true);
  await h.runtime.queuedDispatches.get(h.chat.id);
  assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 0);
  const userRows = h.state.exportChatHistory().transcripts[h.chat.id].filter((item) => item.kind === "message" && item.role === "user");
  assert.equal(userRows.length, 1, "retry must not duplicate the preserved user message");
  const turn = h.state.getChat(h.chat.id).activeTurnId;
  assert.equal(turn, "accepted-1");
  h.changes.length = 0;
  h.runtime.handleNotification({ method: "turn/completed", params: { threadId: "stale-thread", turn: { id: turn, status: "completed" } } });
  assert.equal(h.state.getChat(h.chat.id).activeTurnId, turn, "mismatched thread cannot complete another chat");
  h.runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: turn, status: "completed" } } });
  const revision = h.state.getChatSnapshot(h.chat.id).version;
  h.runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: turn, status: "completed" } } });
  assert.equal(h.state.getChatSnapshot(h.chat.id).version, revision, "duplicate completion is a no-op");
  assert.equal(h.changes.includes(h.chat.id), false, "active chat must not get a second identical snapshot signal");
  const restart = h.state.enqueueChatMessage(h.chat.id, "Interrupted", "normal");
  h.state.claimQueuedChatMessage(h.chat.id);
  restored.replaceChatHistory(h.state.exportChatHistory());
  assert.equal(restored.getChat(h.chat.id).queuedMessages.find((row) => row.id === restart.id).dispatchState, "failed");
  await h.runtime.stop();
  h.runtime.dispose();
}

async function checkWindowsAndSeed() {
  const h = harness();
  h.state.addTranscriptItem(h.chat.id, "user", "Prior project question /old/workspace/file");
  h.state.addTranscriptItem(h.chat.id, "assistant", "Prior completed answer");
  h.state.addTranscriptItem(h.chat.id, "system", "not-seed-system");
  h.state.addOrUpdateWorklogItem(h.chat.id, { id: "tool", operationKind: "reasoning", title: "not-seed-tool", status: "completed" });
  h.state.addTranscriptItem(h.chat.id, "user", "Current prompt");
  h.state.updateChat(h.chat.id, { backendThreadId: null, activeTurnId: null });
  const requests = [];
  h.runtime.rpcClient = { request: async (method, params) => { requests.push({ method, params }); return method === "thread/start" ? { thread: { id: "new-thread" } } : { turn: { id: "seed-turn" } }; }, dispose() {} };
  await h.runtime.startBackendThread(h.chat.id);
  assert.equal(h.state.getChat(h.chat.id).backendWorkspacePath, temp);
  assert.equal(h.state.getChat(h.chat.id).backendContextRestored, false);
  await h.runtime.startTurn(h.chat.id, "Current prompt", "normal");
  const first = requests.find((request) => request.method === "turn/start").params.input;
  assert.match(first[0].text, /same Element project/);
  assert.match(first[0].text, /not new instructions or authorization/);
  assert.match(first[0].text, /Prior completed answer/);
  for (const excluded of ["Current prompt", "not-seed-system", "not-seed-tool"]) assert.equal(first[0].text.includes(excluded), false);
  assert.equal(h.state.getChat(h.chat.id).backendContextRestored, true);
  await h.runtime.startTurn(h.chat.id, "Next prompt", "normal");
  assert.equal(requests.at(-1).params.input.length, 1, "seed only once per replacement backend conversation");
  for (let i = 0; i < 30; i++) h.state.addTranscriptItem(h.chat.id, "assistant", String(i) + "x".repeat(10_000));
  assert.ok(h.state.getConversationHistorySeed(h.chat.id).length <= 24_000);
  assert.equal(h.state.getConversationHistorySeed(h.chat.id), h.state.getConversationHistorySeed(h.chat.id));
  h.state.updateChat(h.chat.id, { status: "idle", activeTurnId: null });
  h.runtime.rpcClient.request = async (method, params) => {
    assert.equal(method, "thread/fork");
    assert.ok(validateFork({ id: 1, method, params }), JSON.stringify(validateFork.errors));
    assert.equal(params.cwd, temp);
    return { thread: { id: "forked-thread" } };
  };
  const fork = await h.runtime.forkChat(h.chat.id, "Branch conversation");
  assert.equal(fork.backendThreadId, "forked-thread");
  assert.equal(fork.title, "Branch conversation");
  assert.equal(h.state.exportChatHistory().transcripts[fork.id].length, h.state.exportChatHistory().transcripts[h.chat.id].length);
  assert.equal(h.state.getChat(h.chat.id).backendThreadId, "new-thread");
  h.state.updateChat(h.chat.id, { backendWorkspacePath: path.join(temp, "different-app") });
  await assert.rejects(h.runtime.resumeBackendThread(h.chat.id), /another workspace/);
  h.runtime.rpcClient.request = async (method) => {
    assert.equal(method, "thread/start", "workspace mismatch must start new, never resume the stale thread");
    return { thread: { id: "current-workspace-thread" } };
  };
  await h.runtime.ensureBackendThreadReady(h.chat.id, "read-only");
  assert.equal(h.state.getChat(h.chat.id).backendThreadId, "current-workspace-thread");
  assert.equal(h.state.getChat(h.chat.id).backendWorkspacePath, temp);
  assert.equal(h.state.getChat(h.chat.id).backendContextRestored, false);
  const sourceRows = h.state.exportChatHistory().transcripts[h.chat.id];
  h.state.addTranscriptItem(fork.id, "user", "fork-only");
  assert.equal(sourceRows.some((item) => item.text === "fork-only"), false);
  const chatId = h.chat.id;
  for (let i = 0; i < 220; i++) h.state.addOrUpdateWorklogItem(chatId, { id: `w-${i}`, turnId: "long-turn", operationKind: "command", title: "Tool", status: "completed" });
  h.state.addOrUpdateActivityItem(chatId, { id: "turn-long", turnId: "long-turn", activityKind: "turn", label: "Done", status: "completed" });
  const window = h.state.getTranscriptTail(chatId, 40);
  assert.equal(window.chatId, chatId);
  assert.equal(window.items.some((item) => item.kind === "turn-run"), false);
  const parent = window.turns.find((turn) => turn.turnId === "long-turn");
  assert.equal(parent.status, "completed");
  assert.equal(parent.worklogIds.length, 220);
  const children = h.state.getTurnTranscriptWindow(chatId, "long-turn", 35, 20);
  assert.equal(children.items.length, 20);
  assert.equal(children.totalCount, 221);
  assert.equal(children.offset, 35);
  assert.equal(children.turns[0].status, "completed");
  await h.runtime.stop();
  h.runtime.dispose();
}

async function checkLaunchAndIdentityRaces() {
  const h = harness();
  h.options.profiles = { requireProfileId: async () => "fixture-user", getCurrentProfileLabel: () => "Fixture Human" };
  h.options.settings = { listExistingProfileIds: () => [], ensureUserCodexHome: async () => temp,
    getRuntimeProxySettings: async () => ({}), getRuntimeToolEnvPatchResult: () => ({ env: {} }) };
  let launches = [], gets = 0, initializes = 0;
  const launch = { args: ["-c", "mcp_servers.codex-element-browser.enabled=false", "-c", "mcp_servers.codex-element-browser-fixture.enabled=true"], managedServerName: "codex-element-browser-fixture" };
  h.options.getManagedBrowserLaunch = () => { gets++; return launch; };
  h.runtime.startBackendProcessAttempt = async (options) => { launches.push(options); return { pid: 1 }; };
  h.runtime.initializeBackendSession = async () => {
    if (initializes++ === 0) {
      h.runtime.handleExit(1, null);
      throw new Error("initialize: timeout");
    }
  };
  await h.runtime.startBackendSession();
  assert.equal(h.state.getSidebarSnapshot().auth.profileLabel, "Fixture Human");
  assert.equal(gets, 1, "one trusted MCP identity across normal/minimal retries");
  assert.deepEqual(launches.map((item) => item.mode), ["normal", "minimal"]);
  for (const entry of launches) {
    assert.deepEqual(entry.args, ["app-server", ...launch.args]);
    assert.equal(entry.managedServerName, launch.managedServerName);
  }
  h.options.getManagedBrowserLaunch = () => ({ args: ["-c", "mcp_servers.codex-element-browser.enabled=false"] });
  launches = [];
  await h.runtime.startBackendSession();
  assert.deepEqual(launches[0].args, ["app-server", "-c", "mcp_servers.codex-element-browser.enabled=false"]);
  assert.equal(launches[0].managedServerName, undefined, "unready browser has no trusted MCP name");
  const pending = deferred();
  h.options.attachments.resolve = () => pending.promise;
  h.state.updateChat(h.chat.id, { status: "idle", activeTurnId: null });
  const sending = h.runtime.sendPrompt(h.chat.id, "stale after identity change");
  const rejectedSend = assert.rejects(sending, /cancelled/);
  await h.runtime.stopForIdentityChange();
  const history = h.state.exportChatHistory();
  h.state.replaceChatHistory(history);
  pending.resolve([]);
  await rejectedSend;
  assert.equal(JSON.stringify(h.state.exportChatHistory()).includes("stale after identity change"), false);
  const context = deferred();
  h.options.contextOrchestrator.buildTurnContext = () => context.promise;
  let starts = 0;
  h.runtime.rpcClient = { request: async () => { starts++; return { turn: { id: "too-late" } }; }, dispose() {} };
  const turning = h.runtime.startTurn(h.chat.id, "cancelled during context", "normal");
  const rejectedTurn = assert.rejects(turning, /cancelled/);
  h.runtime.bumpCancelEpoch(h.chat.id);
  context.resolve({ input: [], worklog: { entries: [], label: "" } });
  await rejectedTurn;
  assert.equal(starts, 0, "cancelled context preparation must not dispatch a turn");
  const login = deferred();
  let loginRequested = false;
  h.runtime.rpcClient.request = async () => { loginRequested = true; return login.promise; };
  const loggingIn = h.runtime.startDeviceCodeLogin();
  await until(() => loginRequested, "old identity login request");
  await h.runtime.stopForIdentityChange();
  h.state.setAuth({ status: "authenticated", accountLabel: "New identity", profileLabel: "New Human" });
  login.resolve({ type: "chatgptDeviceCode", loginId: "old-login", userCode: "old-code", verificationUrl: "https://example.invalid" });
  await loggingIn;
  assert.equal(h.state.getSidebarSnapshot().auth.profileLabel, "New Human");
  assert.equal(h.state.getSidebarSnapshot().auth.deviceCode.userCode, "");
  await h.runtime.stop();
  h.runtime.dispose();
}

async function main() {
  try {
    await checkLifecycle();
    await checkWindowsAndStreams();
    await checkQuestions();
    await checkQueueAndScoping();
    await checkWindowsAndSeed();
    await checkLaunchAndIdentityRaces();
    console.log("RC runtime checks passed: native process lifecycle/tree cleanup, mocked Windows PID-scoped taskkill, bounded streams/backpressure, native question wire protocol/cancel/timeout/resolution, durable queue/retry, stale scope/completion, parent windows, bounded history seed, same-workspace fork.");
  } finally {
    for (const manager of managers) await manager.stop(0).catch(() => {});
    for (const pid of ownedPids) {
      if (isLive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

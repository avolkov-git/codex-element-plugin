const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const Ajv = require("ajv");
const { loadSource, vscode, root } = require("./service-test-utils.cjs");
const schema = require("../scripts/fixtures/app-server/0.154.0.json");

const mockVscode = { ...vscode, workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } };
const platform = loadSource("src/platform.ts");
const { CodexRuntimeController } = loadSource("src/codexRuntimeController.ts", {
  vscode: mockVscode,
  "./platform": {
    ...platform,
    resolveBundledRuntimeExecutable: () => ({
      path: process.execPath, candidates: [process.execPath], platformId: "fixture", executableName: "node", legacy: false
    }),
    validateRuntimeExecutable: () => ({ ok: true })
  }
});
const { StateStore } = loadSource("src/stateStore.ts", { vscode: mockVscode });
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(condition) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Runtime fixture did not reach the expected boundary.");
}
function binding(token = "opaque-session-secret") {
  return {
    args: ["-c", 'mcp_servers.element.env_http_headers={"X-Element-IDE-Session"="ELEMENT_IDE_MCP_SESSION_TOKEN"}'],
    env: { ELEMENT_IDE_MCP_SESSION_TOKEN: token },
    serverName: "element",
    async verify(callTool) {
      assert.equal((await callTool("get_managed_actions_status", {})).isError, false);
      assert.equal((await callTool("get_current_application", {})).isError, false);
    }
  };
}

function fixture(t, overrides = {}) {
  const state = new StateStore();
  const calls = [], starts = [], logs = [], replies = [];
  let stops = 0;
  const options = {
    state,
    logger: Object.fromEntries(["info", "warn", "error", "runtime"].map(level => [level, (...args) => logs.push([level, ...args])])),
    context: { extensionUri: { fsPath: root }, globalStorageUri: { fsPath: root }, extension: { packageJSON: { version: "fixture" } } },
    settings: {
      listExistingProfileIds: () => ["fixture"],
      ensureUserCodexHome: async () => root,
      getRuntimeProxySettings: async () => ({ enabled: false }),
      getRuntimeToolEnvPatchResult: () => ({ env: { TOOL_ENV: "tool-env" } })
    },
    profiles: { requireProfileId: async () => "fixture", getCurrentProfileLabel: () => "fixture" },
    attachments: { resolve: async items => items },
    onDidChange() {}, onDidChangeChat() {},
    ...overrides
  };
  const runtime = new CodexRuntimeController(options);
  const h = { runtime, state, options, starts, calls, logs, replies, stopGate: undefined, respond: undefined };
  const manager = {
    isRunning: false, pid: undefined,
    start(input) {
      starts.push(input);
      manager.isRunning = true;
      manager.pid = 100 + starts.length;
      return manager.pid;
    },
    writeLine(line) {
      const input = starts.at(-1), payload = JSON.parse(line);
      if (!payload.method) { replies.push(payload); return; }
      calls.push(payload);
      if (!("id" in payload)) return;
      Promise.resolve().then(async () => {
        if (h.respond) {
          const response = await h.respond(payload, starts.length);
          if (response !== undefined) return response;
        }
        switch (payload.method) {
          case "initialize": return { userAgent: "fixture" };
          case "account/read": return { account: null };
          case "thread/start": return { thread: { id: `verify-${starts.length}` } };
          case "mcpServer/tool/call": return { content: [{ type: "text", text: "{}" }], isError: false };
          case "thread/unsubscribe": return {};
          case "mcpServerStatus/list": return { data: [], nextCursor: null };
          case "skills/list": return { data: [] };
          case "config/mcpServer/reload": return {};
          default: throw new Error(`Unexpected RPC ${payload.method}`);
        }
      }).then(
        result => input.onStdout(JSON.stringify({ id: payload.id, result })),
        error => input.onStdout(JSON.stringify({ id: payload.id, error: { code: -32000, message: error.message } }))
      );
    },
    async stop() {
      stops++;
      if (h.stopGate) await h.stopGate.promise;
      manager.isRunning = false;
      manager.pid = undefined;
    },
    dispose() {}
  };
  runtime.processManager = manager;
  h.manager = manager;
  h.stops = () => stops;
  h.emit = payload => starts.at(-1).onStdout(JSON.stringify(payload));
  t.after(async () => {
    h.stopGate?.resolve();
    await runtime.stop();
    runtime.dispose();
    await runtime.backendStopPromise;
  });
  return h;
}

for (const provider of [undefined, async () => ({ args: [], env: {} })]) {
  test(`absent MCP (${provider ? "empty provider" : "no provider"}) preserves startup and in-place reload`, async t => {
    const h = fixture(t, { getElementMcpLaunch: provider, getManagedBrowserLaunch: () => ({ args: ["-c", "browser=true"] }) });
    await h.runtime.ensureBackendProcess();
    assert(h.runtime.isBackendRunning());
    assert.deepEqual(plain(h.starts[0].args), ["app-server", "-c", "browser=true"]);
    assert.equal(h.calls.filter(call => call.method === "thread/start").length, 0);
    await h.runtime.reloadMcpServers();
    assert.equal(h.starts.length, 1);
    assert.equal(h.calls.at(-1).method, "config/mcpServer/reload");
  });
}

test("normal and minimal attempts obtain fresh launches and merge browser args and private env", async t => {
  let browserCalls = 0, elementCalls = 0;
  const environment = { ...process.env };
  const h = fixture(t, {
    getManagedBrowserLaunch: current => {
      assert(current());
      return { args: ["-c", `browser=${++browserCalls}`], managedServerName: `browser-${browserCalls}` };
    },
    getElementMcpLaunch: async current => {
      assert(current());
      const launch = binding(`secret-${++elementCalls}`);
      launch.env.TOOL_ENV = "session-override";
      return launch;
    }
  });
  h.respond = ({ method }, attempt) => {
    if (method === "initialize" && attempt === 1) throw new Error("initialize: timeout");
  };
  await h.runtime.ensureBackendProcess();
  assert.equal(h.starts.length, 2);
  assert.equal(elementCalls, 2);
  assert.equal(browserCalls, 2);
  for (const [i, start] of h.starts.entries()) {
    assert.deepEqual(plain(start.args), ["app-server", ...binding().args, "-c", `browser=${i + 1}`]);
    assert.equal(start.env.ELEMENT_IDE_MCP_SESSION_TOKEN, `secret-${i + 1}`);
    assert.equal(start.env.TOOL_ENV, "session-override");
    assert.equal(start.env.CODEX_HOME, root);
    assert(!JSON.stringify(start.args).includes("secret-"));
  }
  assert.deepEqual({ ...process.env }, environment);
  assert.equal(h.runtime.managedBrowserServerName, "browser-2");
  assert.equal(h.calls.filter(call => call.method === "mcpServer/tool/call").length, 2);
});

test("verification uses schema-valid ephemeral RPCs only, and gates status/account/skills reads", async t => {
  const waiting = deferred();
  const h = fixture(t, { getElementMcpLaunch: async () => binding() });
  const ajv = new Ajv({ strict: false });
  const validators = Object.fromEntries(["ThreadStartParams", "McpServerToolCallParams", "ThreadUnsubscribeParams"]
    .map(name => [name, ajv.compile({ ...schema.definitions[name], definitions: schema.definitions })]));
  h.respond = async ({ method, params }) => {
    if (method === "mcpServer/tool/call" && params.tool === "get_managed_actions_status") await waiting.promise;
  };
  const startup = h.runtime.ensureBackendProcess();
  await until(() => h.calls.some(call => call.method === "mcpServer/tool/call"));
  assert(h.manager.isRunning);
  assert.equal(h.runtime.isBackendRunning(), false);
  assert.equal(h.state.getSidebarSnapshot().runtime.status, "starting");
  let readsComplete = false;
  const reads = Promise.all([h.runtime.loadMcpRuntimeStatuses(), h.runtime.readAccount(), h.runtime.loadSkills()])
    .then(() => { readsComplete = true; });
  await tick();
  assert.equal(readsComplete, false);
  assert(!h.calls.some(call => ["account/read", "skills/list", "mcpServerStatus/list"].includes(call.method)));
  waiting.resolve();
  await Promise.all([startup, reads]);
  assert(h.runtime.isBackendRunning());
  const start = h.calls.find(call => call.method === "thread/start");
  assert(validators.ThreadStartParams(start.params), JSON.stringify(validators.ThreadStartParams.errors));
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.sandbox, "read-only");
  assert(!("model" in start.params));
  assert(!("baseInstructions" in start.params));
  assert(!("developerInstructions" in start.params));
  for (const call of h.calls.filter(call => call.method === "mcpServer/tool/call")) {
    assert(validators.McpServerToolCallParams(call.params));
    assert.deepEqual(Object.keys(call.params).sort(), ["arguments", "server", "threadId", "tool"]);
    assert.equal(call.params.threadId, "verify-1");
    assert.equal(call.params.server, "element");
    assert.deepEqual(call.params.arguments, {});
  }
  const cleanup = h.calls.find(call => call.method === "thread/unsubscribe");
  assert(validators.ThreadUnsubscribeParams(cleanup.params));
  assert(!h.calls.some(call => call.method === "turn/start" || call.method === "thread/archive"));
  assert.equal(h.state.exportChatHistory().chats.length, 0);
  assert.equal(h.runtime.loadedThreadIds.size, 0);
});

for (const minimal of [false, true]) {
  test(`scope verification failure closes transport, never retries/replays (${minimal ? "minimal" : "normal"})`, async t => {
    const token = "opaque-failure-secret";
    let launches = 0;
    const h = fixture(t, {
      sanitizeRuntimeOutput: value => value.replaceAll(token, "[REDACTED]"),
      getElementMcpLaunch: async () => {
        launches++;
        return { ...binding(token), verify: async () => { throw new Error(`initialize: timeout scope mismatch ${token}`); } };
      }
    });
    if (minimal) h.respond = ({ method }, attempt) => {
      if (method === "initialize" && attempt === 1) throw new Error("initialize: timeout");
    };
    const chat = h.state.createChat("general");
    h.state.enqueueChatMessage(chat.id, "Do not replay", "normal");
    await assert.rejects(h.runtime.ensureBackendProcess(), error => {
      assert.match(error.message, /Проверка привязки Element MCP не пройдена/);
      assert(!error.message.includes(token));
      return true;
    });
    assert.equal(launches, minimal ? 2 : 1);
    assert.equal(h.manager.isRunning, false);
    assert.equal(h.runtime.rpcClient, undefined);
    assert.equal(h.runtime.backendStartPromise, undefined);
    assert.equal(h.state.getChat(chat.id).queuedMessages[0].dispatchState, "failed");
    assert.equal(h.runtime.startNextQueuedPrompt(chat.id), false);
    assert.equal(h.calls.filter(call => call.method === "thread/unsubscribe").length, 1);
    assert(!JSON.stringify([h.logs, h.state.getSidebarSnapshot()]).includes(token));
    assert(!h.calls.some(call => call.method === "turn/start"));
  });
}

test("startup errors and launch provider failures close transport and sanitize returned/UI errors", async t => {
  const token = "secret-from-startup";
  for (const failure of ["provider", "initialize"]) {
    const h = fixture(t, {
      sanitizeRuntimeOutput: value => value.replaceAll(token, "[REDACTED]"),
      getElementMcpLaunch: async () => {
        if (failure === "provider") throw new Error(token);
        return binding(token);
      }
    });
    h.respond = ({ method }) => { if (method === "initialize") throw new Error(token); };
    await assert.rejects(h.runtime.ensureBackendProcess(), /\[REDACTED\]/);
    assert.equal(h.manager.isRunning, false);
    assert.equal(h.runtime.rpcClient, undefined);
    assert(!JSON.stringify([h.logs, h.state.getSidebarSnapshot()]).includes(token));
  }
});

test("sanitizes stdout before parsing RPC responses, errors, transcripts and approvals, plus stderr", async t => {
  const token = "opaque-runtime-secret";
  const h = fixture(t, {
    sanitizeRuntimeOutput: value => value.replaceAll(token, "[REDACTED]"),
    getElementMcpLaunch: async () => binding(token)
  });
  await h.runtime.ensureBackendProcess();
  h.respond = ({ method }) => {
    if (method === "test/result") return { text: token };
    if (method === "test/error") throw new Error(token);
  };
  assert.deepEqual(plain(await h.runtime.rpcClient.request("test/result")), { text: "[REDACTED]" });
  await assert.rejects(h.runtime.rpcClient.request("test/error"), /\[REDACTED\]/);
  const chat = h.state.createChat("general");
  h.state.updateChat(chat.id, { backendThreadId: "user-thread", activeTurnId: "user-turn", status: "running" });
  h.runtime.activeThreadChatId.set("user-thread", chat.id);
  h.runtime.activeTurnChatId.set("user-turn", chat.id);
  h.emit({ method: "item/completed", params: {
    threadId: "user-thread", turnId: "user-turn",
    item: { id: "answer", type: "agentMessage", text: token }
  } });
  h.emit({ id: 990, method: "item/commandExecution/requestApproval", params: {
    threadId: "user-thread", turnId: "user-turn", itemId: "command", command: `echo ${token}`, cwd: root
  } });
  h.starts[0].onStdout(`not-json ${token}`);
  h.starts[0].onStderr(`stderr ${token}`);
  h.starts[0].onError(new Error(`transport ${token}`));
  assert.equal(h.runtime.pendingApprovals.size, 1);
  assert(!JSON.stringify([h.logs, h.state.getSidebarSnapshot(), h.state.exportChatHistory(),
    [...h.runtime.pendingApprovals.values()], [...h.runtime.itemPayloads.values()]]).includes(token));
  assert(JSON.stringify(h.state.exportChatHistory()).includes("[REDACTED]"));
  assert(h.logs.some(row => row.join(" ").includes("stderr [REDACTED]")));
});

test("stale launch cannot spawn after invalidation, and cannot stop a replacement startup", async t => {
  const waiting = deferred();
  let isCurrent, launches = 0;
  const h = fixture(t, { getElementMcpLaunch: async current => {
    if (++launches === 1) { isCurrent = current; await waiting.promise; }
    return binding();
  } });
  const oldStartup = h.runtime.ensureBackendProcess();
  const oldFailure = assert.rejects(oldStartup, /cancelled/);
  await until(() => isCurrent);
  assert(isCurrent());
  const epoch = h.runtime.lifecycleEpoch;
  const stopping = h.runtime.stopForMcpSessionChange();
  assert(h.runtime.lifecycleEpoch > epoch);
  assert.equal(isCurrent(), false);
  await stopping;
  await h.runtime.ensureBackendProcess();
  waiting.resolve();
  await oldFailure;
  assert.equal(h.starts.length, 1);
  assert(h.runtime.isBackendRunning());
});

test("late verification responses never publish ready or use the replacement transport", async t => {
  const waiting = deferred();
  let launches = 0, oldCall;
  const h = fixture(t, { getElementMcpLaunch: async () => ({
    ...binding(),
    verify: ++launches === 1 ? async call => { oldCall = call; await waiting.promise; await call("get_current_application", {}); } : binding().verify
  }) });
  const oldStartup = h.runtime.ensureBackendProcess();
  const oldFailure = assert.rejects(oldStartup, /cancelled/);
  await until(() => oldCall);
  await h.runtime.stopForMcpSessionChange();
  await h.runtime.ensureBackendProcess();
  const count = h.calls.length;
  waiting.resolve();
  await oldFailure;
  assert.equal(h.calls.length, count);
  assert(h.runtime.isBackendRunning());
  assert(!h.calls.some(call => call.method === "thread/unsubscribe" && call.params.threadId === "verify-1"));
});

test("reload restarts with fresh browser/session overrides, verifies again and preserves chat history", async t => {
  let launches = 0;
  const h = fixture(t, {
    getManagedBrowserLaunch: () => ({ args: ["-c", "browser=true"] }),
    getElementMcpLaunch: async () => binding(`secret-${++launches}`)
  });
  const chat = h.state.createChat("general");
  h.state.addTranscriptItem(chat.id, "user", "Keep this chat", "immediate");
  const history = plain(h.state.exportChatHistory());
  await h.runtime.ensureBackendProcess();
  await h.runtime.reloadMcpServers();
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].env.ELEMENT_IDE_MCP_SESSION_TOKEN, "secret-2");
  assert.deepEqual(plain(h.starts[1].args), ["app-server", ...binding().args, "-c", "browser=true"]);
  assert.equal(h.calls.filter(call => call.method === "mcpServer/tool/call").length, 4);
  assert(!h.calls.some(call => call.method === "config/mcpServer/reload"));
  assert.deepEqual(plain(h.state.exportChatHistory()), history);
});

for (const method of ["stop", "stopForIdentityChange", "stopForMcpSessionChange"]) {
  test(`${method} synchronously declines approvals and blocks late queued dispatch without deleting history`, async t => {
    const h = fixture(t);
    await h.runtime.ensureBackendProcess();
    const chat = h.state.createChat("general");
    h.state.addTranscriptItem(chat.id, "user", "Saved prompt", "immediate");
    h.state.updateChat(chat.id, { backendThreadId: "user-thread", activeTurnId: "user-turn", status: "running" });
    h.runtime.activeThreadChatId.set("user-thread", chat.id);
    h.emit({ id: 990, method: "item/commandExecution/requestApproval", params: {
      threadId: "user-thread", turnId: "user-turn", itemId: "command", command: "write something", cwd: root
    } });
    assert.equal(h.runtime.pendingApprovals.size, 1);
    const decisions = [];
    h.runtime.pendingApprovals.set("orphan", { chatId: "removed-chat", requestId: "orphan", resolve: value => decisions.push(value) });
    h.state.enqueueChatMessage(chat.id, "Keep queued text", "normal");
    h.state.updateChat(chat.id, { status: "idle" });
    const dispatchGate = deferred();
    h.runtime.validateQueuedSkills = () => dispatchGate.promise;
    assert(h.runtime.startNextQueuedPrompt(chat.id));
    await tick();
    h.stopGate = deferred();
    const epoch = h.runtime.runtimeEpoch;
    const stopping = h.runtime[method]();
    assert(h.runtime.runtimeEpoch > epoch);
    assert.equal(h.runtime.pendingApprovals.size, 0);
    assert.deepEqual(decisions, [false]);
    assert.equal(h.state.getChat(chat.id).pendingApproval, null);
    assert.equal(h.state.getChat(chat.id).queuedMessages[0].dispatchState, "failed");
    h.runtime.resolveApproval(chat.id, "990", true);
    dispatchGate.resolve([]);
    await tick();
    h.stopGate.resolve();
    await stopping;
    assert.equal(h.runtime.startNextQueuedPrompt(chat.id), false);
    assert(!h.calls.some(call => call.method === "turn/start"));
    assert.equal(h.replies.length, 0, "late approval replies must not write to a stopped transport");
    assert.equal(h.state.getChat(chat.id).queuedMessages[0].text, "Keep queued text");
    assert(JSON.stringify(h.state.exportChatHistory()).includes("Saved prompt"));
  });
}

test("session invalidation marks even undispatched queue entries as explicit-retry only", async t => {
  const h = fixture(t);
  const chat = h.state.createChat("general");
  h.state.enqueueChatMessage(chat.id, "First pending prompt", "normal");
  h.state.enqueueChatMessage(chat.id, "Second pending prompt", "normal");
  await h.runtime.stopForMcpSessionChange();
  assert(h.state.getChat(chat.id).queuedMessages.every(message => message.dispatchState === "failed"));
  assert.equal(h.runtime.startNextQueuedPrompt(chat.id), false);
  assert.equal(h.starts.length, 0);
});

test("verification failure cancels an awaiting user prompt and safely rejects notification-triggered reads", async t => {
  const waiting = deferred();
  let verifying = false;
  const h = fixture(t, { getElementMcpLaunch: async () => ({
    ...binding(),
    async verify() {
      verifying = true;
      h.emit({ method: "account/updated", params: {} });
      await waiting.promise;
      throw new Error("Wrong application");
    }
  }) });
  const chat = h.state.createChat("general");
  h.state.enqueueChatMessage(chat.id, "Never auto-replay", "normal");
  const sending = h.runtime.sendPrompt(chat.id, "User's original prompt");
  await until(() => verifying);
  assert.equal(h.state.getChat(chat.id).status, "running");
  waiting.resolve();
  await sending;
  await tick();
  assert.equal(h.state.getChat(chat.id).status, "idle");
  assert.equal(h.state.getChat(chat.id).activeTurnId, null);
  assert.equal(h.state.getChat(chat.id).queuedMessages[0].dispatchState, "failed");
  assert.equal(h.runtime.startNextQueuedPrompt(chat.id), false);
  assert.equal(h.state.getSidebarSnapshot().runtime.status, "error");
  assert(JSON.stringify(h.state.exportChatHistory()).includes("User's original prompt"));
  assert(!h.calls.some(call => call.method === "turn/start"));
});

test("teardown failures cannot make an unverified process ready for later reads", async t => {
  const token = "teardown-session-secret";
  const h = fixture(t, {
    sanitizeRuntimeOutput: value => value.replaceAll(token, "[REDACTED]"),
    getElementMcpLaunch: async () => ({ ...binding(), async verify() { throw new Error("scope mismatch"); } })
  });
  const stop = h.manager.stop;
  h.manager.stop = async () => { throw new Error(`Cannot stop ${token}`); };
  try {
    await assert.rejects(h.runtime.ensureBackendProcess(), /Cannot stop \[REDACTED\]/);
    assert(h.manager.isRunning);
    assert.equal(h.runtime.isBackendRunning(), false);
    await assert.rejects(h.runtime.readAccount(), /Cannot stop \[REDACTED\]/);
    await assert.rejects(h.runtime.loadMcpRuntimeStatuses(), /Cannot stop \[REDACTED\]/);
    assert(!h.calls.some(call => ["account/read", "mcpServerStatus/list"].includes(call.method)));
    assert.equal(h.starts.length, 1);
  } finally {
    h.manager.stop = stop;
  }
});

test("ephemeral cleanup failure is nonretryable even when its message resembles a transport retry", async t => {
  const h = fixture(t, { getElementMcpLaunch: async () => binding() });
  h.respond = ({ method }) => { if (method === "thread/unsubscribe") throw new Error("JSON-RPC client disposed"); };
  await assert.rejects(h.runtime.ensureBackendProcess(), /Не удалось закрыть проверочный диалог Element MCP/);
  assert.equal(h.starts.length, 1);
  assert.equal(h.runtime.isBackendRunning(), false);
  assert.equal(h.manager.isRunning, false);
  assert.equal(h.runtime.rpcClient, undefined);
});

test("an in-flight tool response from an invalidated runtime cannot finish verification", async t => {
  const waiting = deferred();
  const h = fixture(t, { getElementMcpLaunch: async () => binding() });
  h.respond = async ({ method }, attempt) => {
    if (method === "mcpServer/tool/call" && attempt === 1) await waiting.promise;
  };
  const startup = h.runtime.ensureBackendProcess();
  const failure = assert.rejects(startup, /cancelled/);
  await until(() => h.calls.some(call => call.method === "mcpServer/tool/call"));
  const oldTransport = h.starts[0];
  await h.runtime.stopForMcpSessionChange();
  await failure;
  await h.runtime.ensureBackendProcess();
  const count = h.calls.length;
  waiting.resolve();
  oldTransport.onStderr("Stale stderr must be ignored");
  oldTransport.onError(new Error("Stale transport failure must be ignored"));
  await tick();
  assert.equal(h.calls.length, count);
  assert(h.runtime.isBackendRunning());
  assert(!JSON.stringify(h.logs).includes("Stale"));
});

test("sanitizer failure never exposes its exception or leaves startup transport owned", async t => {
  const h = fixture(t, {
    getElementMcpLaunch: async () => { throw new Error("opaque-private-session"); },
    sanitizeRuntimeOutput: () => { throw new Error("opaque-private-session"); }
  });
  await assert.rejects(h.runtime.ensureBackendProcess(), /^Error: Не удалось безопасно обработать вывод Codex\.$/);
  assert.equal(h.runtime.rpcClient, undefined);
  assert.equal(h.runtime.isBackendRunning(), false);
  assert(!JSON.stringify([h.logs, h.state.getSidebarSnapshot()]).includes("opaque-private-session"));
});

test("every coalesced startup caller receives a sanitized error only after teardown", async t => {
  const token = "coalesced-startup-secret";
  const waiting = deferred();
  let preparing = false;
  const h = fixture(t, {
    sanitizeRuntimeOutput: value => value.replaceAll(token, "[REDACTED]"),
    getElementMcpLaunch: async () => {
      preparing = true;
      await waiting.promise;
      throw new Error(token);
    }
  });
  const results = [];
  const capture = promise => promise.then(
    () => assert.fail("Startup must fail"),
    error => { results.push(error.message); }
  );
  const calls = [capture(h.runtime.ensureBackendProcess())];
  await until(() => preparing);
  calls.push(capture(h.runtime.readAccount()), capture(h.runtime.loadMcpRuntimeStatuses()));
  h.stopGate = deferred();
  waiting.resolve();
  await until(() => h.stops() > 0);
  await tick();
  assert.deepEqual(results, []);
  h.stopGate.resolve();
  await Promise.all(calls);
  assert.deepEqual(results, ["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
  assert.equal(h.runtime.backendStartPromise, undefined);
});

test("invalidation during orphan process cleanup cannot restart from a stale read", async t => {
  const h = fixture(t);
  h.manager.isRunning = true;
  h.manager.pid = 99;
  h.stopGate = deferred();
  const reading = h.runtime.readAccount();
  const failure = assert.rejects(reading, /cancelled/);
  await until(() => h.stops() > 0);
  const stopping = h.runtime.stopForMcpSessionChange();
  h.stopGate.resolve();
  await stopping;
  await failure;
  assert.equal(h.starts.length, 0);
});

for (const provider of [undefined, async () => ({ args: [], env: {} })]) {
  test(`account/updated during startup without MCP (${provider ? "empty provider" : "no provider"}) cannot deadlock`,
    { timeout: 5000 }, async t => {
      const waiting = deferred();
      const h = fixture(t, { getElementMcpLaunch: provider });
      t.after(() => waiting.resolve());
      h.respond = async ({ method }) => {
        if (method === "initialize") h.emit({ method: "account/updated", params: {} });
        if (method === "account/read") {
          h.emit({ method: "account/updated", params: {} });
          await waiting.promise;
        }
      };
      const startup = h.runtime.ensureBackendProcess();
      const read = h.runtime.readAccount();
      await until(() => h.calls.some(call => call.method === "account/read"));
      assert.equal(h.runtime.isBackendRunning(), false);
      waiting.resolve();
      await Promise.all([startup, read]);
      await tick();
      assert(h.runtime.isBackendRunning());
      assert.equal(h.calls.filter(call => call.method === "initialize").length, 1);
      assert.equal(h.calls.filter(call => call.method === "account/read").length, 1);
      assert.equal(h.calls.filter(call => call.method === "thread/start").length, 0);
      assert.equal(h.runtime.backendStartPromise, undefined);
    });
}

test("account/updated during failed no-MCP startup does not leak a rejected promise", async t => {
  const h = fixture(t);
  h.respond = ({ method }) => {
    if (method === "initialize") {
      h.emit({ method: "account/updated", params: {} });
      throw new Error("Unsupported initialize");
    }
  };
  await assert.rejects(h.runtime.ensureBackendProcess(), /Unsupported initialize/);
  await tick();
  assert.equal(h.runtime.isBackendRunning(), false);
  assert.equal(h.runtime.rpcClient, undefined);
  assert(h.logs.some(row => row.join(" ").includes("Account refresh failed")));
});

test("full MCP-table and empty env overrides preserve browser args in normal/minimal launches, including native CLI precedence",
  { timeout: 10000 }, async t => {
    const tokenKey = "ELEMENT_IDE_MCP_SESSION_TOKEN";
    const elementArgs = Object.freeze([
      "-c", 'mcp_servers={"element.with.dot"={url="http://127.0.0.1:9900/mcp",env_http_headers={"X-Element-IDE-Session"="ELEMENT_IDE_MCP_SESSION_TOKEN"}},stdio={command="fixture-stdio",env_vars=["ELEMENT_IDE_MCP_SESSION_TOKEN"],env={ELEMENT_IDE_MCP_SESSION_TOKEN=""}},codex-element-browser={command="foreign-browser",enabled=true}}',
      "-c", `shell_environment_policy.set.${tokenKey}=""`
    ]);
    const browserArgs = Object.freeze([
      "-c", 'mcp_servers.codex-element-browser={command="disabled-browser",args=[],enabled=false}',
      "-c", 'mcp_servers.codex-element-browser-private={command="fixture-browser",args=["--config","/private session/browser.json"],enabled=true}'
    ]);
    const h = fixture(t, {
      getManagedBrowserLaunch: () => ({ args: browserArgs, managedServerName: "codex-element-browser-private" }),
      getElementMcpLaunch: async () => ({ ...binding(), serverName: "element.with.dot", args: elementArgs })
    });
    h.respond = ({ method }, attempt) => {
      if (method === "initialize" && attempt === 1) throw new Error("initialize: timeout");
    };
    await h.runtime.ensureBackendProcess();
    for (const start of h.starts) {
      assert.deepEqual(plain(start.args), ["app-server", ...elementArgs, ...browserArgs]);
      assert.equal(start.env[tokenKey], "opaque-session-secret");
    }
    assert.equal(h.starts.length, 2);
    assert.equal(h.runtime.managedBrowserServerName, "codex-element-browser-private");
    const binary = path.join(root, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "codex.exe" : "codex");
    if (!fs.existsSync(binary) || fs.statSync(binary).size < 1024) {
      t.diagnostic("Native bundled executable unavailable; argument composition verified without CLI precedence smoke.");
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "element-mcp-args-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    for (const start of h.starts) {
      const records = JSON.parse(execFileSync(binary, ["mcp", "list", "--json", ...start.args.slice(1)], {
        cwd: home, env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 3000
      }));
      const browser = records.find(record => record.name === "codex-element-browser-private");
      assert.equal(browser.enabled, true);
      assert.equal(browser.transport.command, "fixture-browser");
      assert.deepEqual(browser.transport.args, ["--config", "/private session/browser.json"]);
      assert.equal(records.find(record => record.name === "codex-element-browser").enabled, false);
      assert.equal(records.find(record => record.name === "element.with.dot").transport.url, "http://127.0.0.1:9900/mcp");
      assert.equal(records.find(record => record.name === "stdio").transport.env[tokenKey], "");
      assert(!fs.existsSync(path.join(home, "config.toml")), "CLI overrides must never be persisted");
    }
  });

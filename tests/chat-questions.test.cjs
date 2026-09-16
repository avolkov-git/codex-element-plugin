const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, vscode, logger, root } = require("./service-test-utils.cjs");

const mockVscode = { ...vscode, workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } };
const mocks = { vscode: mockVscode };
const { StateStore } = loadSource("src/stateStore.ts", mocks);
const { CodexRuntimeController } = loadSource("src/codexRuntimeController.ts", mocks);
const { ChatPanelManager } = loadSource("src/chatPanelManager.ts", mocks);
const { normalizeHistory } = loadSource("src/chatHistoryService.ts", mocks);
const { ProjectHistoryStore, validateHistory } = loadSource("src/projectHistoryStore.ts", mocks);
const { identityFromConsole } = loadSource("src/elementIdentityService.ts", mocks);
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness(t, running = true) {
  const state = new StateStore();
  const chat = state.createChat("general");
  const requests = [];
  state.updateChat(chat.id, { backendThreadId: "thread-a", backendWorkspacePath: root, activeTurnId: running ? "turn-a" : null, status: running ? "running" : "idle" });
  state.setAuth({ status: "authenticated" });
  const options = {
    state, logger, context: { extensionUri: { fsPath: root }, extension: { packageJSON: { version: "test" } } },
    onDidChange() {}, onDidChangeChat() {}, attachments: { resolve: async items => items },
    contextOrchestrator: { buildTurnContext: async ({ prompt }) => ({ input: [{ type: "text", text: prompt, text_elements: [] }], worklog: { entries: [], label: "" } }) }
  };
  const runtime = new CodexRuntimeController(options);
  runtime.activeThreadChatId.set("thread-a", chat.id);
  if (running) runtime.activeTurnChatId.set("turn-a", chat.id);
  runtime.loadedThreadIds.add("thread-a");
  runtime.processManager = { isRunning: true, stop: async () => {}, dispose() {} };
  runtime.ensureBackendProcess = async () => {};
  runtime.maybeStartDiagnosticsAutoFix = async () => {};
  runtime.scheduleThinking = () => {};
  runtime.rpcClient = { request: async (method, params) => {
    requests.push({ method, params: plain(params) });
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    if (method === "turn/start") return { turn: { id: "turn-answer", status: "inProgress" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    throw new Error(`Unexpected RPC: ${method}`);
  }, dispose() {} };
  t.after(() => runtime.dispose());
  const items = () => state.exportChatHistory().transcripts[chat.id];
  const emit = (item, extra = {}) => runtime.handleNotification({ method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item, ...extra } });
  const question = (questions = [{ title: "Which environment?", options: ["Test", "Production"] }], overrides = {}) => {
    const item = { type: "agentMessage", id: "question-item", text: "Question text", delivery: "async", questions, ...overrides };
    emit(item);
    return items().find(entry => entry.backendItemId === item.id);
  };
  const complete = (turnId = "turn-a") => runtime.handleNotification({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: turnId, status: "completed" } } });
  const answer = (item, value, index = 0) => runtime.respondToQuestion(chat.id, item.id, item.kind === "clarification" ? item.id : item.questions[index].id, value);
  return { state, chat, runtime, options, requests, items, emit, question, complete, answer };
}

test("async structured questions keep stable IDs and raw Markdown, including empty text and multiple free questions", t => {
  const h = harness(t);
  const item = h.question([{ title: "Select", options: ["A", "B"] }, { title: "Explain", options: null }, { title: "Anything else?" }], { text: "" });
  assert.equal(item.text, "");
  assert.equal(item.backendThreadId, "thread-a");
  assert.equal(item.backendItemId, "question-item");
  assert.deepEqual(plain(item.questions.map(q => q.options)), [["A", "B"], null, null]);
  assert.equal(new Set(item.questions.map(q => q.id)).size, 3);
  h.question([{ title: "Select", options: ["A", "B"] }]);
  assert.equal(h.items().filter(entry => entry.id === item.id).length, 1);
  assert.deepEqual(plain(h.items().find(entry => entry.id === item.id).questions), plain(item.questions));
  const other = harness(t).question([{ title: "Select", options: ["A", "B"] }]);
  assert.equal(other.id, item.id, "backend identity, not a timestamp or local chat ID");
  assert.equal(other.questions[0].id, item.questions[0].id);
  assert.equal(h.state.getChat(h.chat.id).status, "running");
});

test("ordinary Markdown and lists never become questions; a non-streamed completion cannot overwrite an async item", t => {
  const h = harness(t);
  h.emit({ type: "agentMessage", id: "plain", text: "Which?\n- A\n- B", questions: [{ title: "ignored" }] });
  assert.equal(h.items().find(item => item.text === "Which?\n- A\n- B").questions, undefined);
  const question = h.question();
  h.emit({ type: "agentMessage", id: "final", text: "# Final\n- ordinary list" });
  assert.equal(h.items().find(item => item.id === question.id).text, question.text);
  assert(h.items().some(item => item.text === "# Final\n- ordinary list" && item.questions === undefined));
});

test("malformed and oversized question metadata does not invent controls or discard message text", t => {
  const h = harness(t);
  const invalid = [[{ title: "" }], [{ title: "Q", options: "A" }], [{ title: "Q", options: [1] }], Array(33).fill({ title: "Q" }), [{ title: "x".repeat(16385) }]];
  invalid.forEach((questions, index) => {
    const item = h.question(questions, { id: `bad-${index}`, text: "Visible raw text" });
    assert.equal(item.questions, undefined);
    assert.equal(item.text, "Visible raw text");
  });
});

test("running answers use steer, allow free text for options, acknowledge after runtime acceptance and retain accepted duplicates", async t => {
  const h = harness(t);
  const item = h.question();
  const wait = deferred();
  const request = h.runtime.rpcClient.request;
  h.runtime.rpcClient.request = async (...args) => { await wait.promise; return request(...args); };
  const pending = h.answer(item, "  Custom environment  ");
  await Promise.resolve();
  assert.equal(h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id).answer, undefined);
  const duplicate = await h.answer(item, "duplicate");
  assert.equal(duplicate.accepted, false);
  wait.resolve();
  assert.equal((await pending).accepted, true);
  assert.deepEqual(h.requests.map(r => r.method), ["turn/steer"]);
  assert.equal(h.requests[0].params.threadId, "thread-a");
  assert.equal(h.requests[0].params.expectedTurnId, "turn-a");
  assert.match(h.requests[0].params.input[0].text, /Вопрос: Which environment\?\nОтвет: Custom environment/);
  assert.equal(h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id).answer, "Custom environment");
  h.question(undefined, { questions: null });
  assert.equal(h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id).answer, "Custom environment");
  assert.equal((await h.answer(item, "again")).accepted, false);
  assert.equal(h.requests.length, 1);
});

test("idle multiple questions each send a normal turn after acceptance without using swallowing sendPrompt", async t => {
  const h = harness(t, false);
  const item = h.question([{ title: "One", options: null }, { title: "Two", options: [] }]);
  h.runtime.sendPrompt = async () => assert.fail("do not use the error-swallowing public sender");
  assert.equal((await h.answer(item, "first")).accepted, true);
  h.state.updateChat(h.chat.id, { status: "idle", activeTurnId: null });
  assert.equal((await h.answer(item, "second", 1)).accepted, true);
  assert.deepEqual(h.requests.map(r => r.method), ["turn/start", "turn/start"]);
  assert.deepEqual(plain(h.items().find(entry => entry.id === item.id).questions.map(q => q.answer)), ["first", "second"]);
});

test("turn completion before steer dispatch falls back once to start on the same thread, without interrupt", async t => {
  const h = harness(t);
  const item = h.question();
  h.options.attachments.resolve = async items => { h.complete(); return items; };
  assert.equal((await h.answer(item, "answer")).accepted, true);
  assert.deepEqual(h.requests.map(r => r.method), ["turn/start"]);
  assert.equal(h.requests[0].params.threadId, "thread-a");
});

test("accepted steer racing with completion remains accepted without a second send or resurrected turn", async t => {
  const h = harness(t);
  const item = h.question();
  h.runtime.rpcClient.request = async (method, params) => {
    h.requests.push({ method, params });
    h.complete();
    return { turnId: "turn-a" };
  };
  assert.equal((await h.answer(item, "answer")).accepted, true);
  assert.deepEqual(h.requests.map(r => r.method), ["turn/steer"]);
  assert.equal(h.state.getChat(h.chat.id).status, "idle");
  assert.equal(h.state.getChat(h.chat.id).activeTurnId, null);
});

test("start completed before its RPC response does not resurrect the finished turn", async t => {
  const h = harness(t, false);
  const item = h.question();
  h.runtime.rpcClient.request = async () => { h.complete("turn-answer"); return { turn: { id: "turn-answer" } }; };
  assert.equal((await h.answer(item, "answer")).accepted, true);
  assert.equal(h.state.getChat(h.chat.id).status, "idle");
  assert.equal(h.state.getChat(h.chat.id).activeTurnId, null);
});

for (const running of [true, false]) {
  test(`${running ? "steer" : "start"} errors and missing or wrong acknowledgements keep the question open`, async t => {
    for (const failure of ["reject", "missing", "wrong-turn"]) {
      const h = harness(t, running);
      const item = h.question();
      let calls = 0;
      h.runtime.rpcClient.request = async () => {
        calls++;
        if (failure === "reject") { h.complete(); throw new Error("fixture dispatch failure"); }
        return failure === "wrong-turn" && running ? { turnId: "foreign-turn" } : {};
      };
      const result = await h.answer(item, "answer");
      assert.equal(result.accepted, false);
      assert.equal(typeof result.error, "string");
      assert.equal(h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id).answer, undefined);
      assert.equal(calls, 1, "a rejected or ambiguous RPC must not be retried automatically");
      assert(!h.items().some(item => item.kind === "message" && item.role === "user"));
    }
  });
}

test("wrong chat, item, thread, archived chat, unbound history and cancelled questions never dispatch", async t => {
  for (const mode of ["chat", "item", "thread", "archive", "unbound", "cancelled", "owner"]) {
    const h = harness(t);
    const item = h.question();
    let chatId = h.chat.id;
    let messageId = item.id;
    if (mode === "chat") chatId = h.state.createChat("general").id;
    if (mode === "item") messageId = "foreign-item";
    if (mode === "thread") h.state.updateChat(chatId, { backendThreadId: "thread-b" });
    if (mode === "archive") h.state.updateChat(chatId, { archivedAt: new Date().toISOString() });
    if (mode === "unbound") delete item.backendThreadId;
    if (mode === "cancelled") h.runtime.cancelledTurnIds.add("turn-a");
    if (mode === "owner") h.runtime.activeThreadChatId.set("thread-a", "foreign-chat");
    const result = await h.runtime.respondToQuestion(chatId, messageId, item.questions[0].id, "answer");
    assert.equal(result.accepted, false, mode);
    assert.equal(h.requests.length, 0, mode);
  }
});

test("blank and oversized answers fail before dispatch; the 16 KiB UTF-8 boundary succeeds", async t => {
  const h = harness(t);
  const item = h.question();
  for (const answer of ["", " \n ", "x".repeat(16385), "я".repeat(8193), null]) {
    assert.equal((await h.answer(item, answer)).accepted, false);
  }
  assert.equal(h.requests.length, 0);
  assert.equal((await h.answer(item, "я".repeat(8192))).accepted, true);
});

test("history or thread changes while building context cannot dispatch to old or new owners", async t => {
  for (const mode of ["thread", "history", "runtime", "archive", "turn"]) {
    const h = harness(t, false);
    const item = h.question();
    h.options.contextOrchestrator.buildTurnContext = async () => {
      if (mode === "thread") h.state.updateChat(h.chat.id, { backendThreadId: "thread-b" });
      if (mode === "history") h.state.replaceChatHistory(plain(h.state.exportChatHistory()));
      if (mode === "runtime") h.runtime.runtimeEpoch++;
      if (mode === "archive") h.state.updateChat(h.chat.id, { archivedAt: new Date().toISOString() });
      if (mode === "turn") h.state.updateChat(h.chat.id, { status: "running", activeTurnId: "another-turn" });
      return { input: [], worklog: { entries: [], label: "" } };
    };
    assert.equal((await h.answer(item, "answer")).accepted, false, mode);
    assert.equal(h.requests.length, 0, mode);
  }
});

test("thread changes while a runtime acknowledgement is pending cannot mark a question answered in the replacement scope", async t => {
  const h = harness(t);
  const item = h.question();
  h.runtime.rpcClient.request = async () => { h.state.updateChat(h.chat.id, { backendThreadId: "thread-b" }); return { turnId: "turn-a" }; };
  assert.equal((await h.answer(item, "answer")).accepted, false);
  assert.equal(h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id).answer, undefined);
});

test("unloaded question threads resume their original identity; failed resume never creates a replacement", async t => {
  for (const fail of [false, true]) {
    const h = harness(t, false);
    const item = h.question();
    h.runtime.loadedThreadIds.clear();
    const request = h.runtime.rpcClient.request;
    h.runtime.rpcClient.request = async (...args) => {
      if (fail && args[0] === "thread/resume") throw new Error("thread no longer exists");
      return request(...args);
    };
    assert.equal((await h.answer(item, "answer")).accepted, !fail);
    assert.deepEqual(h.requests.map(r => r.method), fail ? [] : ["thread/resume", "turn/start"]);
    assert.equal(h.state.getChat(h.chat.id).backendThreadId, "thread-a");
  }
});

test("legacy clarification uses the same response command and persists item.answer, including empty options", async t => {
  const h = harness(t, false);
  h.state.updateChat(h.chat.id, { accessMode: "danger-full-access" });
  let runMode;
  const build = h.options.contextOrchestrator.buildTurnContext;
  h.options.contextOrchestrator.buildTurnContext = async options => { runMode = options.runMode; return build(options); };
  const legacy = { type: "agentMessage", id: "legacy-item", text: '<codex_clarification>{"question":"Explain?","options":[]}</codex_clarification>' };
  h.emit(legacy);
  const item = h.items().find(item => item.kind === "clarification");
  assert.equal(item.backendThreadId, "thread-a");
  assert.equal((await h.answer(item, "Legacy free answer")).accepted, true);
  assert.equal(runMode, "planning", "answering a planner clarification must not start execution");
  assert.equal(h.state.getChat(h.chat.id).activeRunMode, "planning");
  assert.equal(h.requests[0].params.sandboxPolicy.type, "readOnly");
  h.emit(legacy);
  const restored = normalizeHistory(plain(h.state.exportChatHistory())).transcripts[h.chat.id].find(value => value.id === item.id);
  assert.equal(restored.answer, "Legacy free answer");
  assert.equal((await h.answer(item, "duplicate")).accepted, false);
});

test("planner clarification completion before start acknowledgement still observes planning mode", async t => {
  const h = harness(t, false);
  h.state.updateChat(h.chat.id, { accessMode: "danger-full-access" });
  h.emit({ type: "agentMessage", id: "planner-clarification", text: '<codex_clarification>{"question":"Scope?","options":[]}</codex_clarification>' });
  const item = h.items().find(item => item.kind === "clarification");
  h.runtime.activeThreadChatId.clear();
  let mode;
  h.runtime.rpcClient.request = async () => {
    mode = h.state.getChat(h.chat.id).activeRunMode;
    h.complete("turn-answer");
    return { turn: { id: "turn-answer" } };
  };
  assert.equal((await h.answer(item, "Plan only")).accepted, true);
  assert.equal(mode, "planning");
  assert.equal(h.state.getChat(h.chat.id).status, "idle");
  assert.equal(h.state.getChat(h.chat.id).activeRunMode, null);
});

test("different legacy backend items in one turn retain independent answered states", async t => {
  const h = harness(t, false);
  const question = id => ({ type: "agentMessage", id, text: `<codex_clarification>${JSON.stringify({ question: id, options: [] })}</codex_clarification>` });
  h.emit(question("first"));
  const first = h.items().find(item => item.kind === "clarification");
  h.emit(question("second"));
  assert.equal((await h.answer(first, "First answer")).accepted, true);
  const all = h.items().filter(item => item.kind === "clarification");
  assert.equal(all.length, 2);
  assert.equal(all[0].answer, "First answer");
  assert.equal(all[1].answer, undefined);
  assert.notEqual(all[0].id, all[1].id);
});

function savedLegacy(h) {
  h.state.addOrUpdateClarificationItem(h.chat.id, "turn-a", "Old planning question?", []);
  h.state.replaceChatHistory(normalizeHistory(plain(h.state.exportChatHistory())));
  return h.items().find(item => item.kind === "clarification");
}

test("saved unbound legacy clarification answers in planning, persists and rejects duplicates after reload", async t => {
  for (const running of [false, true]) {
    const h = harness(t, false);
    const item = savedLegacy(h);
    assert.equal(item.backendThreadId, undefined);
    assert.equal(item.backendItemId, undefined);
    h.state.updateChat(h.chat.id, { accessMode: "danger-full-access", ...(running ? { status: "running", activeTurnId: "turn-a", activeRunMode: "planning" } : {}) });
    let runMode;
    const build = h.options.contextOrchestrator.buildTurnContext;
    h.options.contextOrchestrator.buildTurnContext = async options => { runMode = options.runMode; return build(options); };
    assert.equal((await h.answer(item, "Saved legacy answer")).accepted, true);
    assert.deepEqual(h.requests.map(r => r.method), [running ? "turn/steer" : "turn/start"]);
    assert.equal(h.requests[0].params.threadId, "thread-a");
    assert.equal(h.state.getChat(h.chat.id).activeRunMode, "planning");
    if (!running) {
      assert.equal(runMode, "planning");
      assert.equal(h.requests[0].params.sandboxPolicy.type, "readOnly");
    }
    h.state.replaceChatHistory(normalizeHistory(plain(h.state.exportChatHistory())));
    assert.equal(h.items().find(value => value.id === item.id).answer, "Saved legacy answer");
    assert.equal((await h.answer(item, "duplicate")).accepted, false);
    assert.equal(h.requests.length, 1);
  }
});

test("legacy compatibility does not bypass missing threads, partial bindings, chat ownership or execution mode", async t => {
  for (const mode of ["missing-thread", "partial-thread", "partial-item", "chat", "owner", "archive", "execution"]) {
    const h = harness(t, false);
    const item = savedLegacy(h);
    let chatId = h.chat.id;
    if (mode === "missing-thread") h.state.updateChat(chatId, { backendThreadId: null });
    if (mode === "partial-thread") item.backendThreadId = "thread-a";
    if (mode === "partial-item") item.backendItemId = "unknown-item";
    if (mode === "chat") chatId = h.state.createChat("general").id;
    if (mode === "owner") h.runtime.activeThreadChatId.set("thread-a", "foreign-chat");
    if (mode === "archive") h.state.updateChat(chatId, { archivedAt: new Date().toISOString() });
    if (mode === "execution") h.state.updateChat(chatId, { status: "running", activeTurnId: "turn-execution", activeRunMode: "normal" });
    assert.equal((await h.runtime.respondToQuestion(chatId, item.id, item.id, "answer")).accepted, false, mode);
    assert.equal(h.requests.length, 0, mode);
  }
});

test("unbound legacy keeps its frozen thread and history generation across context, resume and acknowledgement races", async t => {
  for (const stage of ["context", "resume", "ack"]) {
    for (const change of ["thread", "history"]) {
      const h = harness(t, false);
      const item = savedLegacy(h);
      const mutate = () => change === "thread"
        ? h.state.updateChat(h.chat.id, { backendThreadId: "thread-b" })
        : h.state.replaceChatHistory(plain(h.state.exportChatHistory()));
      if (stage === "context") h.options.contextOrchestrator.buildTurnContext = async () => { mutate(); return { input: [], worklog: { entries: [], label: "" } }; };
      else {
        if (stage === "resume") h.runtime.loadedThreadIds.clear();
        const request = h.runtime.rpcClient.request;
        h.runtime.rpcClient.request = async (...args) => { mutate(); return request(...args); };
      }
      assert.equal((await h.answer(item, "answer")).accepted, false, `${stage}/${change}`);
      assert.deepEqual(h.requests.map(r => r.method), stage === "context" ? [] : [stage === "resume" ? "thread/resume" : "turn/start"]);
      assert(h.requests.every(r => r.params.threadId === "thread-a"));
      assert.equal(h.items().find(value => value.id === item.id).answer, undefined);
      assert.equal(h.state.getChat(h.chat.id).backendThreadId, change === "thread" ? "thread-b" : "thread-a", "resume must not overwrite a replacement scope");
    }
  }
});

test("answered state and backend bindings survive atomic project history save/load and reject another workspace", async t => {
  const h = harness(t);
  const item = h.question();
  await h.answer(item, "Persisted answer");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-questions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identity = identityFromConsole("https://element.example/", "deployment", { id: "user", "user-list-id": "list", login: "fixture", "is-active": true }, { id: "deployment", name: "Fixture", "space-id": "space", deleted: false });
  const store = new ProjectHistoryStore(dir, normalizeHistory);
  await store.load(identity, root);
  await store.save(identity, root, h.state.exportChatHistory());
  const reloaded = await new ProjectHistoryStore(dir, normalizeHistory).load(identity, root);
  const restored = reloaded.transcripts[h.chat.id].find(value => value.id === item.id);
  assert.equal(restored.questions[0].answer, "Persisted answer");
  assert.equal(restored.backendThreadId, "thread-a");
  assert.equal(restored.backendItemId, "question-item");
  h.state.replaceChatHistory(reloaded);
  assert.equal((await h.answer(item, "duplicate after reload")).accepted, false);
  const moved = await new ProjectHistoryStore(dir, normalizeHistory).load(identity, path.join(root, "different-workspace"));
  h.state.replaceChatHistory(moved);
  assert.equal((await h.answer(item, "not in the new workspace")).accepted, false);
});

test("history validation rejects corrupt question metadata instead of dropping accepted state", t => {
  const h = harness(t);
  const item = h.question();
  for (const patch of [{ answer: {} }, { options: {} }, { id: "" }, { title: "" }, { answer: "x".repeat(16385) }]) {
    const history = plain(h.state.exportChatHistory());
    Object.assign(history.transcripts[h.chat.id].find(value => value.id === item.id).questions[0], patch);
    assert.throws(() => validateHistory(history), /Поврежден/);
    assert.throws(() => normalizeHistory(history), /Поврежден/);
  }
});

test("panel requires explicit owning chatId and only returns accepted when the handler truthfully confirms", async t => {
  const h = harness(t);
  const item = h.question();
  const events = [];
  let calls = 0;
  const handlers = { respondToQuestion: async (...args) => { calls++; return h.runtime.respondToQuestion(...args); } };
  const manager = new ChatPanelManager({}, h.state, logger, handlers);
  const panel = { webview: { postMessage: async event => { events.push(event); return true; } } };
  manager.panel = panel;
  manager.panelChatId = h.chat.id;
  const command = { type: "command", command: "chat.question.respond", chatId: h.chat.id, payload: { messageId: item.id, questionId: item.questions[0].id, answer: "Panel answer" } };
  for (const chatId of [undefined, "foreign-chat", h.state.createChat("general").id]) {
    await manager.handleMessage(panel, { ...command, chatId });
    assert.equal(events.at(-1).event, "chat.question.result");
    assert.equal(events.at(-1).payload.accepted, false);
  }
  assert.equal(calls, 0);
  handlers.respondToQuestion = async () => undefined;
  await manager.handleMessage(panel, command);
  assert.equal(events.at(-1).payload.accepted, false, "a swallowed error / undefined result is not acceptance");
  handlers.respondToQuestion = async (...args) => h.runtime.respondToQuestion(...args);
  await manager.handleMessage(panel, command);
  assert.equal(events.at(-1).chatId, h.chat.id);
  assert.deepEqual(plain(events.at(-1).payload), { messageId: item.id, questionId: item.questions[0].id, accepted: true });
});

test("switching visible chat during response keeps the result scoped to its captured origin", async t => {
  const h = harness(t);
  const item = h.question();
  const wait = deferred();
  const manager = new ChatPanelManager({}, h.state, logger, { respondToQuestion: async (...args) => { await wait.promise; return h.runtime.respondToQuestion(...args); } });
  const events = [];
  const panel = { webview: { postMessage: async event => { events.push(event); } } };
  manager.panel = panel;
  manager.panelChatId = h.chat.id;
  const pending = manager.handleMessage(panel, { type: "command", command: "chat.question.respond", chatId: h.chat.id, payload: { messageId: item.id, questionId: item.questions[0].id, answer: "answer" } });
  const other = h.state.createChat("general");
  const before = plain(h.state.exportChatHistory().transcripts[other.id]);
  manager.panelChatId = other.id;
  wait.resolve();
  await pending;
  assert.equal(events.at(-1).chatId, h.chat.id);
  assert.equal(events.at(-1).payload.accepted, true);
  assert.equal(h.requests[0].params.threadId, "thread-a");
  assert.deepEqual(plain(h.state.exportChatHistory().transcripts[other.id]), before);
});

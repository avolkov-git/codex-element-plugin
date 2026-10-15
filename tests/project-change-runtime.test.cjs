const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, vscode, root } = require("./service-test-utils.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only external boundaries are mocked. Send/start, routing, cancellation and queue
// ownership must execute the controller's implementation, not a fixture copy.
function harness(t, { enabled = true, kind = "project", accessMode } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workspace = { workspaceFolders: [{ uri: { fsPath: path.join(root, "runtime-fixture") } }] };
  const mocks = { vscode: { ...vscode, workspace }, child_process: {
    spawn() { assert.fail("runtime tests must not spawn a backend"); }
  } };
  const { StateStore } = loadSource("src/stateStore.ts", mocks);
  const { CodexRuntimeController } = loadSource("src/codexRuntimeController.ts", mocks);
  const { formatChangeReview } = loadSource("src/projectChangeReviewService.ts", { ...mocks,
    "./projectChangeAnalysis": { analyzeProjectChanges() { assert.fail("runtime fixture must not run project analysis"); } }
  });
  const state = new StateStore();
  const events = [], requests = [], builds = [], baselines = [], reviews = [], contextCalls = [];
  const forgotten = [], unexpected = [], gates = [], tasks = [], logs = [];
  const reports = new Map();
  let profileId = "profile-a", revision = 0, turnSequence = 0, threadSequence = 0, clears = 0;
  let diagnosticsCalls = 0;
  const h = { state, events, requests, builds, baselines, reviews, contextCalls, forgotten, reports, workspace, logs };
  h.gate = () => { const gate = deferred(); gates.push(gate); return gate; };
  h.setProfile = value => { profileId = value; };
  h.edit = () => { revision++; };
  h.setWorkspace = value => { workspace.workspaceFolders = [{ uri: { fsPath: value } }]; };
  h.result = (call, status = "checked") => {
    const result = {
      report: {
        status, changedPaths: ["Changed.xbsl"], changes: [{ path: "Changed.xbsl", kind: "changed" }],
        checkedPaths: ["Changed.xbsl"], findings: [], elementTargets: [],
        limitations: ["Observed changes may include manual or concurrent edits."], omittedLimitations: 0,
        counts: { filesRead: 1, readCalls: 2, sourceBytes: 7, verifiedBytes: 7, parses: 1, inspections: 0 }
      },
      diagnostics: [{ path: "Changed.xbsl", line: 1, message: `OBSERVED_REVIEW_${call.baseline.id}`,
        severity: "error", key: "old", observed: "existing" }], text: ""
    };
    result.text = formatChangeReview(result);
    return result;
  };
  h.beginImpl = async baseline => baseline;
  h.completeImpl = async call => h.result(call);
  h.contextImpl = async chatId => reports.get(chatId)?.block;
  h.buildImpl = async input => ({
    input: [{ type: "text", text: input.prompt, text_elements: [] },
      ...input.explicitContextBlocks.map(block => ({ type: "text", text: block.text, text_elements: [] }))],
    worklog: { entries: [], label: "" }
  });
  const changeReview = {
    async begin() {
      const capturedRoot = workspace.workspaceFolders[0].uri.fsPath;
      const capturedProfile = profileId;
      const baseline = {
        id: `baseline-${baselines.length + 1}`, profileId: capturedProfile, diagnostics: [],
        snapshot: {
          workspaceRoot: capturedRoot, coverage: "bounded-index",
          files: [{ path: "Changed.xbsl", hash: `hash-${revision}` }],
          isCurrent: () => workspace.workspaceFolders[0].uri.fsPath === capturedRoot && profileId === capturedProfile,
          readFile: async () => ({ text: "fixture", hash: `hash-${revision}` })
        }
      };
      baselines.push(baseline);
      events.push(`begin:${baseline.id}`);
      return h.beginImpl(baseline);
    },
    async complete(chatId, baseline, isCurrent) {
      const call = { chatId, baseline, isCurrent };
      reviews.push(call);
      events.push(`review:${baseline.id}`);
      const result = await h.completeImpl(call);
      if (result && isCurrent()) reports.set(chatId, { result, block: {
        source: "project", text: result.text, matchCount: result.diagnostics.length,
        mode: "matched", priority: 110, metadata: { changeReview: true, targets: [] }
      } });
      // Deliberately return even a late result: the controller owns publication.
      return result;
    },
    async context(chatId) {
      contextCalls.push(chatId);
      events.push(`context:${chatId}`);
      return h.contextImpl(chatId);
    },
    forget(chatId) { forgotten.push(chatId); reports.delete(chatId); },
    clear() { clears++; reports.clear(); }
  };
  const options = {
    state, changeReview: enabled ? changeReview : undefined,
    context: { extensionUri: { fsPath: root }, globalStorageUri: { fsPath: root } },
    logger: Object.fromEntries(["info", "warn", "error"].map(level => [level, message => logs.push({ level, message })])),
    profiles: enabled ? { getCurrentProfileId: () => profileId } : undefined,
    onDidChange() {}, onDidChangeChat() {},
    attachments: { resolve: async items => items },
    beforeQueuedDispatch: async chatId => { events.push(`persist-queue:${chatId}`); },
    contextOrchestrator: { buildTurnContext: async input => {
      builds.push(input);
      events.push(`build:${input.prompt}`);
      return h.buildImpl(input);
    } },
    diagnosticsContext: { collectErrorContext: async () => {
      diagnosticsCalls++;
      return { block: { source: "diagnostics", text: "Unrelated workspace error" }, reason: "ready",
        filesCount: 1, errorsCount: 1, totalErrorsCount: 1, fingerprint: "unrelated" };
    } }
  };
  const runtime = new CodexRuntimeController(options);
  runtime.processManager = { isRunning: true, stop: async () => {}, dispose() {} };
  runtime.ensureBackendProcess = async () => { events.push("ensure-backend"); };
  runtime.scheduleThinking = () => {};
  h.rpcImpl = async entry => {
    if (entry.method === "turn/start") return { turn: { id: entry.turnId, status: "inProgress" } };
    if (entry.method === "thread/resume") return { thread: { id: entry.params.threadId } };
    if (entry.method === "turn/interrupt") return {};
    unexpected.push(entry.method);
    throw new Error(`Unexpected RPC: ${entry.method}`);
  };
  runtime.rpcClient = { request: async (method, params) => {
    const entry = { method, params: plain(params ?? {}), turnId: method === "turn/start" ? `turn-${++turnSequence}` : undefined };
    requests.push(entry);
    events.push(`rpc:${method}:${entry.turnId ?? ""}`);
    return h.rpcImpl(entry);
  }, dispose() {} };
  h.createChat = (chatKind = "project") => {
    const chat = state.createChat(chatKind);
    const threadId = `thread-${++threadSequence}`;
    state.updateChat(chat.id, { backendThreadId: threadId, backendWorkspacePath: workspace.workspaceFolders[0].uri.fsPath,
      backendThreadAccessMode: chat.accessMode, backendContextRestored: true,
      ...(accessMode ? { accessMode, backendThreadAccessMode: accessMode } : {}) });
    runtime.activeThreadChatId.set(threadId, chat.id);
    runtime.loadedThreadIds.add(threadId);
    return chat;
  };
  const chat = h.createChat(kind);
  state.setAuth({ status: "authenticated" });
  const track = promise => { tasks.push(promise); return promise; };
  h.send = (text = "first", chatId = chat.id, mode = "normal", blocks = []) =>
    track(runtime.sendPrompt(chatId, text, mode, undefined, blocks));
  h.queue = (text, chatId = chat.id) => track(runtime.queuePrompt(chatId, text));
  h.starts = () => requests.filter(entry => entry.method === "turn/start");
  h.items = (chatId = chat.id) => state.exportChatHistory().transcripts[chatId] ?? [];
  h.activities = (chatId = chat.id) => h.items(chatId).filter(item => item.kind === "activity" && item.activityKind !== "turn");
  h.finish = (entry = h.starts().at(-1), status = "completed") => {
    assert.ok(entry, "a real turn/start request is required before completion");
    runtime.handleNotification({ method: "turn/completed", params: {
      threadId: entry.params.threadId, turn: { id: entry.turnId, status }
    } });
  };
  h.advance = async ms => { t.mock.timers.tick(ms); await flush(); };
  h.assertReleased = () => {
    assert.equal(runtime.changeReviewRuns?.size ?? 0, 0, "no baseline owner remains");
    assert.equal(runtime.postTurnReviews?.size ?? 0, 0, "no review promise remains");
  };
  Object.assign(h, { runtime, options, chat, changeReview, diagnosticsCalls: () => diagnosticsCalls, clears: () => clears });
  t.after(async () => {
    await runtime.stop();
    for (const gate of gates) gate.resolve(undefined);
    await flush();
    await Promise.allSettled(tasks);
    runtime.dispose();
    if (runtime.backendStopPromise) await runtime.backendStopPromise;
    assert.deepEqual(unexpected, [], "only allowlisted RPCs may be sent");
  });
  return h;
}

function inlineQuestion(h) {
  const start = h.starts().at(-1);
  h.runtime.handleNotification({ method: "item/completed", params: {
    threadId: start.params.threadId, turnId: start.turnId,
    item: { type: "agentMessage", id: "pending-steer-question", text: "Choose a target", delivery: "async",
      questions: [{ title: "Which target?", options: ["Test", "Production"] }] }
  } });
  const item = h.items().find(item => item.backendItemId === "pending-steer-question");
  assert.ok(item?.questions?.length);
  return {
    answer: () => h.runtime.respondToQuestion(h.chat.id, item.id, item.questions[0].id, "Test"),
    current: () => h.state.getChatQuestion(h.chat.id, item.id, item.questions[0].id)
  };
}

test("snapshot awaits context and finishes before the first turn/start RPC", async t => {
  const h = harness(t), context = h.gate(), snapshot = h.gate();
  const build = h.buildImpl;
  h.buildImpl = async input => { await context.promise; return build(input); };
  h.beginImpl = async baseline => { await snapshot.promise; return baseline; };
  const sending = h.send();
  await flush();
  assert.equal(h.baselines.length, 0);
  assert.equal(h.starts().length, 0);
  context.resolve();
  await flush();
  assert.equal(h.baselines.length, 1);
  assert.equal(h.starts().length, 0, "snapshot must be awaited, not fire-and-forget");
  snapshot.resolve();
  await sending;
  assert.equal(h.starts().length, 1);
  assert.ok(h.events.indexOf("build:first") < h.events.indexOf("begin:baseline-1"));
  assert.ok(h.events.indexOf("begin:baseline-1") < h.events.indexOf("rpc:turn/start:turn-1"));
  assert.equal(h.state.getChat(h.chat.id).activeTurnId, "turn-1");
});

test("shell-only changes produce one read-only review activity without any auto-repair", async t => {
  const h = harness(t);
  await h.send();
  assert.equal(h.baselines.length, 1);
  // Simulate a shell edit without emitting fileChange or diff notifications.
  h.edit();
  h.finish();
  h.finish();
  await flush();
  assert.equal(h.reviews.length, 1, "fileChange notifications are not a review prerequisite");
  assert.equal(h.reviews[0].baseline, h.baselines[0]);
  assert.equal(h.activities().length, 1);
  assert.equal(h.activities()[0].turnId, "turn-1");
  assert.match(JSON.stringify(h.activities()[0]), /OBSERVED_REVIEW_baseline-1/);
  assert.equal(h.activities()[0].outputPreview, h.result(h.reviews[0]).text, "preserve service attribution and diagnostic caveats verbatim");
  // An old implementation schedules diagnostics at 1500 ms and again at 800 ms.
  await h.advance(1500);
  await h.advance(800);
  assert.equal(h.diagnosticsCalls(), 0);
  assert.equal(h.starts().length, 1, "review must never send a hidden corrective turn");
  assert.equal(h.items().filter(item => item.role === "user").length, 1);
  h.assertReleased();
});

test("early completion drains the queue only after both review and acknowledgement", async t => {
  for (const queuedStart of [false, true]) for (const first of ["review", "acknowledgement"]) {
    await t.test(`${queuedStart ? "queued" : "manual"} start: ${first}`, async t => {
    const h = harness(t), ack = h.gate(), review = h.gate();
    const rpc = h.rpcImpl;
    const turnNumber = queuedStart ? 2 : 1;
    h.rpcImpl = async entry => { if (entry.turnId === `turn-${turnNumber}`) await ack.promise; return rpc(entry); };
    h.completeImpl = call => call.baseline.id === `baseline-${turnNumber}` ? review.promise : h.result(call);
    let sending;
    if (queuedStart) {
      await h.send();
      await h.queue("queued start");
      h.finish();
    } else sending = h.send();
    await flush();
    assert.equal(await h.queue("queued"), true);
    const original = h.starts().at(-1);
    h.finish(original);
    await flush();
    assert.equal(h.reviews.length, turnNumber, "completion must find a run before RPC acknowledgement");
    assert.equal(h.starts().length, turnNumber);
    if (first === "review") review.resolve(h.result(h.reviews.at(-1)));
    else ack.resolve();
    await flush();
    assert.equal(h.starts().length, turnNumber, "one remaining barrier must still block dispatch");
    if (first === "review") ack.resolve();
    else review.resolve(h.result(h.reviews.at(-1)));
    await sending;
    await flush();
    assert.equal(h.starts().length, turnNumber + 1, "last barrier release must retry queue draining");
    assert.equal(h.starts().at(-1).params.input[0].text, "queued");
    assert.equal(h.state.getChat(h.chat.id).activeTurnId, `turn-${turnNumber + 1}`);
    assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 0);
    h.finish(original);
    await flush();
    assert.equal(h.reviews.length, turnNumber, "duplicate completion cannot review or stop the next turn");
    assert.equal(h.state.getChat(h.chat.id).activeTurnId, `turn-${turnNumber + 1}`);
    });
  }
});

test("late turn/start acknowledgement preserves the queue after abnormal completion", async t => {
  for (const queuedStart of [false, true]) for (const status of ["interrupted", "failed"]) {
    await t.test(`${queuedStart ? "queued" : "manual"} start: ${status}`, async t => {
      const h = harness(t), ack = h.gate();
      const rpc = h.rpcImpl;
      const delayedTurn = queuedStart ? "turn-2" : "turn-1";
      h.rpcImpl = async entry => { if (entry.turnId === delayedTurn) await ack.promise; return rpc(entry); };
      let sending;
      if (queuedStart) {
        await h.send();
        await h.queue("queued start");
        await h.queue("must remain queued");
        h.finish();
      } else {
        sending = h.send();
        await flush();
        await h.queue("must remain queued");
      }
      await flush();
      const startsBeforeAck = h.starts().length;
      const reviewsBeforeCompletion = h.reviews.length;
      assert.equal(h.starts().at(-1).turnId, delayedTurn);
      h.finish(h.starts().at(-1), status);
      await flush();
      ack.resolve();
      await sending;
      await flush();
      assert.equal(h.starts().length, startsBeforeAck, "a late ack cannot restart interrupted or failed work");
      assert.deepEqual(plain(h.state.getChat(h.chat.id).queuedMessages.map(item => [item.text, item.dispatchState])),
        [["must remain queued", "queued"]]);
      assert.equal(h.state.getChat(h.chat.id).activeTurnId, null);
      assert.equal(h.reviews.length, reviewsBeforeCompletion, "abnormal completion does not start a review");
      h.assertReleased();
    });
  }
});

test("pending inline steer and post-turn review release queued work exactly once", async t => {
  for (const first of ["review", "steer"]) await t.test(first, async t => {
    const h = harness(t), steer = h.gate(), review = h.gate();
    const rpc = h.rpcImpl;
    h.rpcImpl = async entry => entry.method === "turn/steer" ? steer.promise : rpc(entry);
    h.completeImpl = () => review.promise;
    await h.send();
    const question = inlineQuestion(h);
    await h.queue("after inline answer");
    const responding = question.answer();
    await flush();
    assert.equal(h.requests.at(-1).method, "turn/steer");
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    if (first === "review") review.resolve(h.result(h.reviews[0]));
    else steer.resolve({ turnId: "turn-1" });
    await flush();
    assert.equal(h.starts().length, 1, "both pending barriers must finish before dispatch");
    if (first === "review") steer.resolve({ turnId: "turn-1" });
    else review.resolve(h.result(h.reviews[0]));
    assert.equal((await responding).accepted, true);
    await flush();
    assert.equal(question.current().answer, "Test");
    assert.equal(h.starts().length, 2);
    assert.equal(h.starts()[1].params.input[0].text, "after inline answer");
    assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 0);
  });
});

test("cancel post-turn review with a pending inline steer acknowledgement keeps queued work", async t => {
  for (const first of ["review", "steer"]) await t.test(first, async t => {
    const h = harness(t), steer = h.gate(), review = h.gate();
    const rpc = h.rpcImpl;
    h.rpcImpl = async entry => entry.method === "turn/steer" ? steer.promise : rpc(entry);
    h.completeImpl = () => review.promise;
    await h.send();
    const question = inlineQuestion(h);
    await h.queue("must remain queued");
    const responding = question.answer();
    await flush();
    assert.equal(h.requests.at(-1).method, "turn/steer");
    h.finish();
    await flush();
    assert.equal(h.runtime.postTurnReviews.size, 1);
    const pendingReview = h.reviews[0];
    await h.runtime.cancelTurn(h.chat.id);
    assert.equal(pendingReview.isCurrent(), false);
    h.assertReleased();
    if (first === "review") review.resolve(h.result(pendingReview));
    else steer.resolve({ turnId: "turn-1" });
    await flush();
    assert.equal(h.starts().length, 1);
    if (first === "review") steer.resolve({ turnId: "turn-1" });
    else review.resolve(h.result(pendingReview));
    const response = await responding;
    await flush();
    assert.equal(response.accepted, false);
    assert.ok(response.error);
    assert.equal(question.current().answer, undefined);
    assert.equal(h.starts().length, 1, "late finalizers cannot authorize another writable turn");
    assert.deepEqual(plain(h.state.getChat(h.chat.id).queuedMessages.map(item => [item.text, item.dispatchState])),
      [["must remain queued", "queued"]]);
    assert.doesNotMatch(JSON.stringify(h.activities()), /OBSERVED_REVIEW_/);
    assert.equal(h.runtime.promptStarts.size, 0);
    assert.equal(h.runtime.queuedDispatches.size, 0);
    h.assertReleased();
  });
});

test("queued prompts wait for review, preserve FIFO and capture their own baseline", async t => {
  const h = harness(t), first = h.gate(), second = h.gate();
  h.completeImpl = call => call.baseline.id === "baseline-1" ? first.promise : second.promise;
  await h.send();
  await h.queue("Q1");
  await h.queue("Q2");
  h.finish();
  await flush();
  const queued = h.state.getChat(h.chat.id).queuedMessages;
  assert.deepEqual(plain(queued.map(item => item.dispatchState)), ["queued", "queued"]);
  assert.equal(h.runtime.retryQueuedPrompt(h.chat.id, queued[0].id), false, "manual queue retry also respects the review barrier");
  assert.equal(h.starts().length, 1);
  first.resolve(h.result(h.reviews[0]));
  await flush();
  assert.equal(h.starts().length, 2);
  assert.equal(h.starts()[1].params.input[0].text, "Q1");
  assert.deepEqual(plain(h.state.getChat(h.chat.id).queuedMessages.map(item => item.text)), ["Q2"]);
  h.finish();
  await flush();
  assert.equal(h.starts().length, 2);
  assert.equal(h.reviews[1].baseline, h.baselines[1]);
  assert.notEqual(h.reviews[1].baseline, h.reviews[0].baseline);
  second.resolve(h.result(h.reviews[1]));
  await flush();
  assert.equal(h.starts().length, 3);
  assert.equal(h.starts()[2].params.input[0].text, "Q2");
  assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 0);
  assert.deepEqual(plain(h.items().filter(item => item.role === "user").map(item => item.text)), ["first", "Q1", "Q2"]);
});

test("manual prompt supersedes an old review without letting its finally release a newer queue", async t => {
  const h = harness(t), old = h.gate(), current = h.gate();
  h.completeImpl = call => call.baseline.id === "baseline-1" ? old.promise : current.promise;
  await h.send();
  h.finish();
  await flush();
  assert.equal(h.reviews.length, 1);
  const stale = h.reviews[0];
  await h.send("manual");
  assert.equal(stale.isCurrent(), false);
  await h.queue("after manual");
  h.finish();
  await flush();
  assert.equal(h.reviews.length, 2);
  const owner = h.runtime.postTurnReviews.get(h.chat.id);
  old.resolve(h.result(stale));
  await flush();
  assert.equal(h.runtime.postTurnReviews.get(h.chat.id), owner, "old finally cannot delete the new promise");
  assert.equal(h.starts().length, 2);
  assert.doesNotMatch(JSON.stringify(h.activities()), /OBSERVED_REVIEW_baseline-1/);
  current.resolve(h.result(h.reviews[1]));
  await flush();
  assert.equal(h.starts().length, 3);
  assert.doesNotMatch(JSON.stringify(h.starts()[2].params.input), /OBSERVED_REVIEW_baseline-1/);
});

test("inline answers supersede pending review without losing the new run or its queue", async t => {
  for (const phase of ["new turn", "new review"]) await t.test(phase, async t => {
    const h = harness(t), old = h.gate(), current = h.gate();
    h.completeImpl = call => call.baseline.id === "baseline-1" ? old.promise : current.promise;
    await h.send();
    const original = h.starts()[0];
    h.runtime.handleNotification({ method: "item/completed", params: {
      threadId: original.params.threadId, turnId: original.turnId,
      item: { type: "agentMessage", id: "inline-question", text: "Choose a target", delivery: "async",
        questions: [{ title: "Which target?", options: ["Test", "Production"] }] }
    } });
    const question = h.items().find(item => item.backendItemId === "inline-question");
    assert.ok(question?.questions?.length, "create the question through the real notification handler");
    assert.equal(await h.queue("after inline answer"), true);
    h.finish(original);
    await flush();
    assert.equal(h.reviews.length, 1);
    const stale = h.reviews[0];
    assert.equal(stale.isCurrent(), true);
    assert.equal(h.starts().length, 1);

    const response = await h.runtime.respondToQuestion(h.chat.id, question.id, question.questions[0].id, "Test");
    assert.equal(response.accepted, true, response.error);
    assert.equal(h.state.getChatQuestion(h.chat.id, question.id, question.questions[0].id).answer, "Test");
    assert.equal(stale.isCurrent(), false, "startTurn must cancel review even when sendPromptCore is bypassed");
    assert.equal(h.starts().length, 2);
    const answerTurn = h.starts()[1];
    assert.equal(answerTurn.params.threadId, original.params.threadId);
    assert.deepEqual(h.requests.map(entry => entry.method), ["turn/start", "turn/start"]);
    const run = h.runtime.changeReviewRuns.get(h.chat.id);
    assert.ok(run);
    assert.equal(run.baseline, h.baselines[1]);
    assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 1);

    if (phase === "new review") { h.finish(answerTurn); await flush(); }
    const pending = h.runtime.postTurnReviews.get(h.chat.id);
    if (phase === "new review") assert.ok(pending, "new review must not be blocked by the old promise");
    old.resolve(h.result(stale));
    await flush();
    assert.equal(h.runtime.changeReviewRuns.get(h.chat.id), run, "old finally cannot delete the new baseline");
    assert.equal(h.runtime.postTurnReviews.get(h.chat.id), pending, "old finally cannot replace the new queue barrier");
    assert.equal(h.starts().length, 2, "queued work must still wait for the answer turn and its review");
    assert.doesNotMatch(JSON.stringify(h.items()), /OBSERVED_REVIEW_baseline-1/);

    if (phase === "new turn") { h.finish(answerTurn); await flush(); }
    assert.equal(h.reviews.length, 2);
    assert.equal(h.reviews[1].baseline, h.baselines[1]);
    current.resolve(h.result(h.reviews[1]));
    await flush();
    assert.equal(h.starts().length, 3, "the queue must drain exactly once after the current review");
    assert.equal(h.starts()[2].params.input[0].text, "after inline answer");
    assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 0);
    assert.doesNotMatch(JSON.stringify(h.starts()[2].params.input), /OBSERVED_REVIEW_baseline-1/);
    assert.match(JSON.stringify(h.starts()[2].params.input), /OBSERVED_REVIEW_baseline-2/);
    assert.equal(h.items().filter(item => item.role === "user").length, 3);
  });
});

test("cancel invalidates capture, active turn and idle post-turn review without draining queued work", async t => {
  for (const phase of ["capture", "active", "review"]) await t.test(phase, async t => {
    const h = harness(t), gate = h.gate();
    if (phase === "capture") h.beginImpl = async baseline => { await gate.promise; return baseline; };
    if (phase === "review") h.completeImpl = () => gate.promise;
    const sending = h.send();
    await flush();
    assert.equal(await h.queue("must remain queued"), true);
    if (phase !== "capture") await sending;
    if (phase === "review") { h.finish(); await flush(); assert.equal(h.reviews.length, 1); }
    const count = h.starts().length;
    await h.runtime.cancelTurn(h.chat.id);
    if (phase === "review") assert.equal(h.reviews[0].isCurrent(), false, "idle cancellation still invalidates review ownership");
    gate.resolve(phase === "review" ? h.result(h.reviews[0]) : undefined);
    await sending;
    if (phase === "active") h.finish();
    await flush();
    assert.equal(h.starts().length, count);
    assert.equal(h.activities().filter(item => JSON.stringify(item).includes("OBSERVED_REVIEW_")).length, 0);
    assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 1);
    assert.equal(h.state.getChat(h.chat.id).activeTurnId, null);
    h.assertReleased();
  });
});

test("profile, workspace, history, thread and archive changes invalidate a pending review", async t => {
  for (const scope of ["profile", "workspace", "history", "thread", "archive"]) await t.test(scope, async t => {
    const h = harness(t), gate = h.gate();
    h.completeImpl = () => gate.promise;
    await h.send();
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    const call = h.reviews[0];
    if (scope === "profile") h.setProfile("profile-b");
    if (scope === "workspace") h.setWorkspace(path.join(root, "another-runtime-fixture"));
    if (scope === "history") h.state.replaceChatHistory(plain(h.state.exportChatHistory()));
    if (scope === "thread") h.state.updateChat(h.chat.id, { backendThreadId: "replacement-thread" });
    if (scope === "archive") h.state.updateChat(h.chat.id, { archivedAt: new Date().toISOString() });
    assert.equal(call.isCurrent(), false, `${scope} cannot reuse an earlier review owner`);
    gate.resolve(h.result(call));
    await flush();
    assert.doesNotMatch(JSON.stringify(h.items()), /OBSERVED_REVIEW_/);
    assert.equal(h.reports.has(h.chat.id), false);
    assert.equal(h.starts().length, 1);
    h.assertReleased();
  });
});

test("stop, identity change, process exit and disposal invalidate late review results", async t => {
  for (const action of ["stop", "identity", "exit", "dispose"]) await t.test(action, async t => {
    const h = harness(t), gate = h.gate();
    h.completeImpl = () => gate.promise;
    await h.send();
    await h.queue("do not restart");
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    if (action === "stop") await h.runtime.stop();
    if (action === "identity") await h.runtime.stopForIdentityChange();
    if (action === "exit") h.runtime.handleExit(1, null);
    if (action === "dispose") { h.runtime.dispose(); await h.runtime.backendStopPromise; }
    assert.equal(h.reviews[0].isCurrent(), false);
    assert.ok(h.activities().every(item => item.status !== "running"), "shutdown must immediately finish the pending review activity");
    gate.resolve(h.result(h.reviews[0]));
    await flush();
    assert.doesNotMatch(JSON.stringify(h.items()), /OBSERVED_REVIEW_/);
    assert.equal(h.starts().length, 1);
    assert.ok(h.clears() > 0, "stored next-turn context must also be cleared");
    h.assertReleased();
  });
});

test("service-tier, model and thread-resume fallbacks review only the accepted attempt", async t => {
  for (const error of ["invalid service tier", "unknown model", "turn/start: thread not found"]) await t.test(error, async t => {
    const h = harness(t), rpc = h.rpcImpl;
    h.rpcImpl = async entry => {
      if (entry.turnId === "turn-1") throw new Error(error);
      return rpc(entry);
    };
    await h.send();
    assert.equal(h.starts().length, 2);
    assert.equal(h.reviews.length, 0);
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    assert.equal(h.reviews[0].baseline, h.baselines.at(-1));
    assert.equal(h.activities().length, 1);
    assert.equal(h.activities()[0].turnId, "turn-2");
    assert.equal(h.items().filter(item => item.role === "user").length, 1);
    h.assertReleased();
  });
  for (const failure of ["rejected", "missing-turn-id"]) await t.test(failure, async t => {
    const h = harness(t);
    h.rpcImpl = async () => {
      if (failure === "rejected") throw new Error("fixture transport failure");
      return {};
    };
    await h.send();
    assert.equal(h.starts().length, 1, "an ambiguous start is not automatically retried");
    assert.equal(h.state.getChat(h.chat.id).status, "error");
    assert.equal(h.reviews.length, 0);
    h.assertReleased();
  });
});

test("unavailable review is optional and review failure or timeout releases the queue", async t => {
  for (const mode of ["disabled", "general", "planning", "read-only", "no-baseline", "reject", "timeout"]) await t.test(mode, async t => {
    const h = harness(t, { enabled: mode !== "disabled", kind: mode === "general" ? "general" : "project",
      accessMode: mode === "read-only" ? "read-only" : undefined });
    if (mode === "no-baseline") h.beginImpl = async () => undefined;
    if (mode === "reject") h.completeImpl = async () => { throw new Error("review provider failed"); };
    if (mode === "timeout") h.completeImpl = () => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error("review deadline exceeded")), 8000);
    });
    await h.send("first", h.chat.id, mode === "planning" ? "planning" : "normal");
    await h.queue("next");
    h.finish();
    await flush();
    if (mode === "timeout") {
      assert.equal(h.starts().length, 1);
      await h.advance(8000);
    }
    assert.equal(h.starts().length, 2, "optional review must not permanently block dispatch");
    assert.doesNotMatch(JSON.stringify(h.items()), /OBSERVED_REVIEW_/);
    assert.equal(h.diagnosticsCalls(), 0);
    if (["disabled", "general", "read-only"].includes(mode)) assert.equal(h.baselines.length, 0);
    if (["planning", "no-baseline"].includes(mode)) assert.equal(h.reviews.length, 0);
  });
});

test("only revalidated next-turn project context reaches RPC, preserving explicit user context", async t => {
  await t.test("valid and stale reports", async t => {
    const h = harness(t);
    await h.send();
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    const marker = h.result(h.reviews[0]).text;
    const explicit = { source: "project", text: "EXPLICIT_USER_CONTEXT", matchCount: 1, mode: "matched" };
    await h.send("second", h.chat.id, "normal", [explicit]);
    const second = h.starts()[1];
    assert.equal(second.params.input.filter(item => item.text === marker).length, 1);
    assert.equal(second.params.input.filter(item => item.text === explicit.text).length, 1);
    assert.equal(h.builds[1].explicitContextBlocks.filter(block => block.metadata?.changeReview).length, 1);
    assert.ok(h.contextCalls.includes(h.chat.id));
    assert.equal(h.items().filter(item => item.role === "user" && item.text.includes("OBSERVED_REVIEW_")).length, 0);
    h.finish(second);
    await flush();
    h.edit();
    h.contextImpl = async () => undefined;
    await h.send("third", h.chat.id, "normal", [explicit]);
    assert.doesNotMatch(JSON.stringify(h.starts()[2].params.input), /OBSERVED_REVIEW_/);
    assert.equal(h.starts()[2].params.input.filter(item => item.text === explicit.text).length, 1);
    assert.equal(h.starts().length, 3);
  });
  await t.test("report becomes stale while context is being built", async t => {
    const h = harness(t), building = h.gate();
    await h.send();
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    const build = h.buildImpl;
    h.buildImpl = async input => { await building.promise; return build(input); };
    const sending = h.send("second");
    await flush();
    assert.equal(h.starts().length, 1);
    assert.ok(h.builds.at(-1).explicitContextBlocks.some(block => block.metadata?.changeReview));
    h.edit();
    h.contextImpl = async () => undefined;
    building.resolve();
    await sending;
    assert.equal(h.starts().length, 2);
    assert.doesNotMatch(JSON.stringify(h.starts()[1].params.input), /OBSERVED_REVIEW_/);
  });
  for (const scope of ["profile", "workspace", "history"]) await t.test(`${scope} changes during final context revalidation`, async t => {
    const h = harness(t), revalidation = h.gate();
    await h.send();
    h.finish();
    await flush();
    assert.equal(h.reviews.length, 1);
    const block = h.reports.get(h.chat.id).block;
    let reads = 0;
    h.contextImpl = async () => {
      if (++reads === 2) await revalidation.promise;
      return block;
    };
    const sending = h.send("second");
    await flush();
    assert.equal(reads, 2, "report must be revalidated immediately before dispatch");
    assert.equal(h.starts().length, 1);
    if (scope === "profile") h.setProfile("profile-b");
    if (scope === "workspace") h.setWorkspace(path.join(root, "replacement-workspace"));
    if (scope === "history") h.state.replaceChatHistory(plain(h.state.exportChatHistory()));
    revalidation.resolve();
    await sending;
    assert.equal(h.starts().length, 1, "a late truthy context result cannot authorize a changed scope");
    h.assertReleased();
  });
});

test("final review diagnostics refresh replaces the report in turn/start", async t => {
  for (const transition of ["replace", "clear", "arrive", "unchanged", "invalidate-on-rebuild", "churn-on-rebuild"]) await t.test(transition, async t => {
    const h = harness(t), building = h.gate();
    const workspaceRoot = h.workspace.workspaceFolders[0].uri.fsPath;
    const uri = { scheme: "file", fsPath: path.join(workspaceRoot, "Changed.xbsl") };
    const diagnostic = message => [uri, [{ message, severity: 0, range: { start: { line: 0 } }, source: "simulated-IDE" }]];
    let cache = transition === "arrive" ? [] : [diagnostic("OLD_DIAGNOSTIC")];
    let reads = 0;
    let sourceCurrent = true;
    const snapshot = {
      workspaceRoot, files: [{ path: "Changed.xbsl", hash: "unchanged-source-hash" }], coverage: "bounded-index",
      isCurrent: () => true, isContentCurrent: () => sourceCurrent,
      readFile: async () => ({ text: "unchanged source", hash: "unchanged-source-hash" })
    };
    const { ProjectChangeReviewService } = loadSource("src/projectChangeReviewService.ts", {
      vscode: { ...vscode, DiagnosticSeverity: { Error: 0, Warning: 1 }, languages: {
        getDiagnostics: () => { reads++; return cache; }
      } },
      "./projectChangeAnalysis": { analyzeProjectChanges() { assert.fail("context refresh must not rerun analysis"); } }
    });
    const service = new ProjectChangeReviewService({ captureChangeSnapshot: async () => snapshot }, {}, {},
      () => "profile-a", h.options.logger);
    const result = h.result({ baseline: { id: "prior" } });
    service.reports.set(h.chat.id, { result, snapshot, profileId: "profile-a", baselineDiagnostics: new Set() });
    const refreshed = [];
    const context = service.context.bind(service);
    service.context = async chatId => { const block = await context(chatId); refreshed.push(block); return block; };
    h.options.changeReview = service;
    const build = h.buildImpl;
    h.buildImpl = async input => {
      await building.promise;
      if (h.builds.length === 2) {
        if (transition === "invalidate-on-rebuild") sourceCurrent = false;
        if (transition === "churn-on-rebuild") cache = [diagnostic("CHANGED_AGAIN_DIAGNOSTIC")];
      }
      return build(input);
    };
    const explicit = { source: "project", text: "EXPLICIT_USER_CONTEXT", matchCount: 1, mode: "matched" };
    const sending = h.send("explain diagnostics", h.chat.id, "normal", [explicit]);
    await flush();
    assert.equal(refreshed.length, 1);
    assert.equal(h.starts().length, 0);
    if (transition !== "unchanged") cache = transition === "clear" ? [] : [diagnostic("NEW_DIAGNOSTIC")];
    building.resolve();
    await sending;
    assert.equal(refreshed.length, transition === "unchanged" ? 2 : 3,
      "revalidate against the current IDE cache after every context build");
    if (transition.endsWith("-on-rebuild")) {
      assert.equal(h.starts().length, 0, "never send a report invalidated during rebuilding");
      assert.equal(h.state.getChat(h.chat.id).status, "error");
      assert.ok(h.logs.some(item => item.message.includes("Данные проверки изменились")));
      assert.equal(h.builds.length, 2, "do not retry indefinitely when sources or diagnostics keep changing");
      return;
    }
    assert.ok(reads >= 3, "read diagnostics for initial context, baseline and final context");
    assert.equal(h.starts().length, 1);
    assert.ok(refreshed[1]);
    const input = h.starts()[0].params.input;
    assert.equal(input.filter(item => item.text === refreshed[1].text).length, 1,
      "send exactly the final validated report, including newly arrived or cleared diagnostics");
    assert.equal(input.filter(item => item.text === explicit.text).length, 1);
    assert.equal(h.builds.length, transition === "unchanged" ? 1 : 2,
      "rebuild only when the validated report changes");
    if (transition !== "unchanged") assert.doesNotMatch(JSON.stringify(input), /OLD_DIAGNOSTIC/);
    assert.equal(JSON.stringify(input).includes("NEW_DIAGNOSTIC"), ["replace", "arrive"].includes(transition));
  });
});

test("concurrent chats keep review results, activities and queue barriers with their owners", async t => {
  const h = harness(t), other = h.createChat(), a = h.gate(), b = h.gate();
  h.completeImpl = call => call.chatId === h.chat.id ? a.promise : b.promise;
  await h.send("A", h.chat.id);
  await h.send("B", other.id);
  const [turnA, turnB] = h.starts();
  await h.queue("QA", h.chat.id);
  await h.queue("QB", other.id);
  h.finish(turnA);
  h.finish(turnB);
  await flush();
  assert.equal(h.reviews.length, 2);
  const reviewA = h.reviews.find(call => call.chatId === h.chat.id);
  const reviewB = h.reviews.find(call => call.chatId === other.id);
  b.resolve(h.result(reviewB));
  await flush();
  assert.equal(h.starts().length, 3);
  assert.equal(h.starts()[2].params.threadId, turnB.params.threadId);
  assert.equal(h.state.getChat(h.chat.id).queuedMessages.length, 1);
  assert.doesNotMatch(JSON.stringify(h.activities(h.chat.id)), /OBSERVED_REVIEW_/);
  a.resolve(h.result(reviewA));
  await flush();
  assert.equal(h.starts().length, 4);
  assert.equal(h.starts()[3].params.threadId, turnA.params.threadId);
  assert.match(JSON.stringify(h.activities(h.chat.id)), /OBSERVED_REVIEW_baseline-1/);
  assert.doesNotMatch(JSON.stringify(h.activities(h.chat.id)), /OBSERVED_REVIEW_baseline-2/);
  assert.match(JSON.stringify(h.activities(other.id)), /OBSERVED_REVIEW_baseline-2/);
  assert.doesNotMatch(JSON.stringify(h.activities(other.id)), /OBSERVED_REVIEW_baseline-1/);
});

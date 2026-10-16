const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { loadSource, root, vscode } = require("./service-test-utils.cjs");

const copy = value => JSON.parse(JSON.stringify(value));
const state = (patch = {}) => ({ type: "browser.viewer.state", sessionId: "session-a", status: "live",
  message: "Live", pages: [{ id: "page-a", title: "A", url: "http://fixture.invalid/a" }], selectedPageId: "page-a", ...patch });
const frame = (patch = {}) => ({ type: "browser.viewer.frame", sessionId: "session-a", pageId: "page-a",
  sequence: 1, data: "/9j/AAAA", width: 800, height: 600, ...patch });

function event() {
  const listeners = new Set();
  return { subscribe: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fire: value => { for (const listener of [...listeners]) listener(value); }, get size() { return listeners.size; } };
}

function fixture(t, service) {
  const states = event(), frames = event(), pointers = event(), inputResults = event(), calls = [], panels = [], serializers = [], renders = [];
  let current = state();
  const viewer = service || {
    onState: states.subscribe, onFrame: frames.subscribe, getState: () => current,
    onPointer: pointers.subscribe, onInputResult: inputResults.subscribe,
    setControl: (...args) => calls.push(["control", ...args]), sendInput: (...args) => calls.push(["input", ...args]),
    setVisible: value => { calls.push(["visible", value]); states.fire(current); },
    setPaused: value => calls.push(["paused", value]),
    selectPage: (...args) => calls.push(["select", ...args]),
    closePages: (...args) => calls.push(["close", ...args]),
    acknowledge: (...args) => calls.push(["ack", ...args])
  };
  function makePanel(viewColumn = 2) {
    const messages = event(), views = event(), disposals = event();
    const panel = {
      visible: true, viewColumn, sent: [], reveals: [], disposed: false,
      webview: { options: {}, html: "", postMessage: async value => { panel.sent.push(copy(value)); return true; },
        onDidReceiveMessage: messages.subscribe },
      onDidChangeViewState: views.subscribe, onDidDispose: disposals.subscribe,
      reveal: column => panel.reveals.push(column),
      dispose() { if (!panel.disposed) { panel.disposed = true; disposals.fire(); } },
      send: messages.fire,
      show(value) { panel.visible = value; views.fire({ webviewPanel: panel }); },
      events: { messages, views, disposals }
    };
    return panel;
  }
  const mockVscode = { ...vscode,
    Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
    ViewColumn: { Beside: -2 },
    window: {
      createWebviewPanel: (...args) => { const panel = makePanel(); panel.creation = args; panels.push(panel); return panel; },
      registerWebviewPanelSerializer: (type, serializer) => {
        const registration = { type, serializer, disposed: false, dispose() { this.disposed = true; } };
        serializers.push(registration); return registration;
      }
    }
  };
  const { BrowserViewerPanelManager, BROWSER_VIEWER_TYPE } = loadSource("src/browserViewerPanelManager.ts", {
    vscode: mockVscode, "./webviewHtml": { renderWebviewHtml: options => { renders.push(options); return "production-html-fixture"; } }
  });
  const manager = new BrowserViewerPanelManager({ extensionUri: { fsPath: root } }, viewer);
  t.after(() => manager.dispose());
  return { manager, viewer, calls, panels, serializers, renders, makePanel, states, frames, pointers, inputResults, BROWSER_VIEWER_TYPE,
    setState(value) { current = value; states.fire(value); }, open() { manager.open(); return panels.at(-1); } };
}

test("viewer is a separate singleton Beside panel with only local viewer assets", t => {
  const h = fixture(t), panel = h.open();
  assert.equal(h.BROWSER_VIEWER_TYPE, "codexElement.browserViewer");
  assert.equal(panel.creation[0], h.BROWSER_VIEWER_TYPE);
  assert.equal(panel.creation[2], -2, "new viewer must open beside the chat, not replace it");
  assert.deepEqual(copy(panel.creation[3]), { enableScripts: true, retainContextWhenHidden: true,
    enableFindWidget: false, localResourceRoots: [{ fsPath: path.join(root, "media") }] });
  assert.equal(panel.webview.html, "production-html-fixture");
  assert.equal(h.renders[0].scriptPath, "media/browser-viewer.js");
  assert.equal(h.renders[0].stylePath, "media/browser-viewer.css");
  assert.equal(h.renders[0].webview, panel.webview);
  assert.equal(panel.iconPath.light.fsPath, path.join(root, "resources/icons/codex-panel-light.svg"));
  assert.equal(panel.iconPath.dark.fsPath, path.join(root, "resources/icons/codex-panel-dark.svg"));
  panel.viewColumn = 4;
  h.manager.open(); h.manager.open();
  assert.equal(h.panels.length, 1);
  assert.deepEqual(panel.reveals, [4, 4], "reveal preserves the user's chosen column");
});

test("viewer waits for ready and combines panel/document visibility before forwarding frames", t => {
  const h = fixture(t), panel = h.open();
  h.states.fire(state()); h.frames.fire(frame());
  for (const message of [{ type: "viewer.pause", paused: true }, { type: "viewer.select", pageId: "page-a" },
    { type: "viewer.ack", pageId: "page-a", sequence: 1 }, { type: "viewer.visibility", visible: true }]) {
    panel.send({ sessionId: "session-a", ...message });
  }
  assert.deepEqual(panel.sent, []);
  assert.deepEqual(h.calls, []);
  panel.send({ type: "viewer.ready", visible: false });
  assert.deepEqual(h.calls, [["visible", false]]);
  assert.equal(panel.sent.at(-1).type, "browser.viewer.state", "ready publishes the service snapshot");
  h.frames.fire(frame());
  assert.equal(panel.sent.filter(item => item.type === "browser.viewer.frame").length, 0);
  panel.send({ type: "viewer.visibility", visible: true });
  h.frames.fire(frame());
  assert.deepEqual(panel.sent.at(-1), frame());
  panel.show(false);
  h.frames.fire(frame({ sequence: 2 }));
  h.setState(state({ status: "paused" }));
  assert.equal(panel.sent.at(-1).status, "paused", "hidden panels still receive state updates");
  assert.equal(panel.sent.filter(item => item.type === "browser.viewer.frame").length, 1);
  panel.send({ type: "viewer.visibility", visible: true });
  assert.deepEqual(h.calls.at(-1), ["visible", false]);
  panel.show(true);
  assert.deepEqual(h.calls.at(-1), ["visible", true]);
  panel.send({ type: "viewer.visibility", visible: false });
  panel.show(true);
  assert.deepEqual(h.calls.at(-1), ["visible", false]);
});

test("viewer validates pause/select/ACK envelopes and ignores stale sessions and browser control messages", t => {
  const h = fixture(t), panel = h.open();
  panel.send({ type: "viewer.ready" });
  h.calls.length = 0;
  const valid = [{ type: "viewer.pause", paused: true }, { type: "viewer.select", pageId: "page-a" },
    { type: "viewer.ack", pageId: "page-a", sequence: 17 }];
  const malformed = [null, false, "viewer.ready", [], {}, { type: "viewer.visibility", visible: "true" },
    { type: "viewer.pause", paused: 1 }, { type: "viewer.select", pageId: 7 },
    ...[undefined, null, "17", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(sequence => ({ type: "viewer.ack", pageId: "page-a", sequence })),
    { type: "viewer.ack", pageId: null, sequence: 17 }];
  for (const message of malformed) panel.send(message && typeof message === "object" ? { sessionId: "session-a", ...message } : message);
  for (const sessionId of [undefined, "", "old-session", 123]) for (const message of valid) panel.send({ ...message, sessionId });
  for (const type of ["click", "keydown", "navigate", "input", "cdp", "viewer.click", "viewer.navigate", "viewer.input", "Page.navigate", "Input.dispatchMouseEvent", "command"]) {
    panel.send({ type, sessionId: "session-a", command: "browser.navigate", pageId: "page-a", url: "http://fixture.invalid/forbidden", x: 1, y: 2 });
  }
  assert.deepEqual(h.calls, [], "only the four read-only viewer operations may reach the service");
  for (const message of valid) panel.send({ ...message, sessionId: "session-a" });
  assert.deepEqual(h.calls, [["paused", true], ["visible", true], ["select", "session-a", "page-a"], ["ack", "session-a", "page-a", 17]]);
  h.setState(state({ sessionId: "session-b" }));
  const before = copy(h.calls);
  for (const message of valid) panel.send({ ...message, sessionId: "session-a" });
  assert.deepEqual(h.calls, before);
  panel.send({ type: "viewer.pause", sessionId: "session-b", paused: false });
  assert.deepEqual(h.calls.slice(-2), [["paused", false], ["visible", true]]);
});

test("viewer disposal drops listeners and reopening requires a fresh ready handshake", t => {
  const h = fixture(t), old = h.open();
  old.send({ type: "viewer.ready" }); old.dispose();
  assert.deepEqual(h.calls.at(-1), ["visible", false]);
  for (const source of Object.values(old.events)) assert.equal(source.size, 0);
  const panel = h.open();
  const before = h.calls.length;
  old.send({ type: "viewer.ready" }); old.show(true);
  h.states.fire(state()); h.frames.fire(frame());
  assert.equal(h.calls.length, before);
  assert.deepEqual(panel.sent, []);
  panel.send({ type: "viewer.ready" });
  h.frames.fire(frame({ sequence: 2 }));
  assert.deepEqual(panel.sent.at(-1), frame({ sequence: 2 }));
  h.manager.dispose(); h.manager.dispose();
  assert.equal(h.states.size, 0); assert.equal(h.frames.size, 0);
  assert(panel.disposed);
});

test("panel forwards manual controls only from the ready visible current session", t => {
  const h = fixture(t), panel = h.open();
  const control = { type: "viewer.control", sessionId: "session-a", pageId: "page-a", enabled: true };
  const input = { type: "viewer.input", sessionId: "session-a", pageId: "page-a", controlId: "lease", inputId: 1, input: { kind: "text", text: "hello" } };
  panel.send(control); panel.send(input);
  assert.deepEqual(h.calls, []);
  panel.send({ type: "viewer.ready" }); h.calls.length = 0;
  panel.send({ ...control, sessionId: "old" }); panel.send({ ...input, sessionId: "old" });
  assert.deepEqual(h.calls, []);
  panel.send(control); panel.send(input);
  assert.deepEqual(h.calls, [["control", "session-a", "page-a", true], ["input", "session-a", "page-a", "lease", 1, input.input]]);
  panel.show(false); h.calls.length = 0;
  panel.send(control); panel.send(input);
  assert.deepEqual(h.calls, []);
  panel.show(true); panel.send({ type: "viewer.visibility", visible: false }); h.calls.length = 0;
  panel.send(control); panel.send(input);
  assert.deepEqual(h.calls, []);
});

test("panel validates viewer.close modes, page IDs and current sessions before forwarding", t => {
  const h = fixture(t), panel = h.open();
  panel.send({ type: "viewer.ready" }); h.calls.length = 0;
  const close = { type: "viewer.close", sessionId: "session-a", pageId: "page-a", mode: "selected" };
  for (const mode of [undefined, null, "all", "", true, {}, 1]) panel.send({ ...close, mode });
  for (const pageId of [undefined, null, 1, {}, []]) panel.send({ ...close, pageId });
  for (const sessionId of [undefined, null, "", "old-session", 1]) panel.send({ ...close, sessionId });
  assert.deepEqual(h.calls, []);
  panel.send(close);
  panel.send({ ...close, mode: "others" });
  assert.deepEqual(h.calls, [["close", "session-a", "page-a", "selected"], ["close", "session-a", "page-a", "others"]]);
  h.setState(state({ sessionId: "session-b" })); h.calls.length = 0;
  panel.send(close);
  assert.deepEqual(h.calls, [], "a session rotation invalidates the old close envelope");
  panel.send({ ...close, sessionId: "session-b" });
  assert.deepEqual(h.calls, [["close", "session-b", "page-a", "selected"]]);
});

test("panel gates both close modes on readiness, panel visibility and document visibility", t => {
  const h = fixture(t), panel = h.open();
  const close = () => {
    for (const mode of ["selected", "others"]) panel.send({ type: "viewer.close", sessionId: "session-a", pageId: "page-a", mode });
  };
  close(); assert.deepEqual(h.calls, []);
  panel.send({ type: "viewer.ready", visible: false }); h.calls.length = 0;
  close(); assert.deepEqual(h.calls, []);
  panel.show(true); h.calls.length = 0;
  close(); assert.deepEqual(h.calls, [], "showing the panel does not override a hidden document");
  panel.send({ type: "viewer.visibility", visible: true });
  panel.show(false); h.calls.length = 0;
  close(); assert.deepEqual(h.calls, []);
  panel.send({ type: "viewer.visibility", visible: true }); h.calls.length = 0;
  close(); assert.deepEqual(h.calls, [], "document visibility does not override a hidden panel");
  panel.show(true); h.calls.length = 0;
  close();
  assert.deepEqual(h.calls, [["close", "session-a", "page-a", "selected"], ["close", "session-a", "page-a", "others"]]);
});

test("panel forwards closing/error state and never accepts close from a disposed panel", t => {
  const h = fixture(t), old = h.open();
  old.send({ type: "viewer.ready" });
  const pending = state({ closingPageIds: ["page-a"], controlId: "" });
  h.setState(pending);
  assert.deepEqual(old.sent.at(-1), pending);
  old.show(false);
  const failed = state({ closingPageIds: [], tabError: "Close failed" });
  h.setState(failed);
  assert.deepEqual(old.sent.at(-1), failed, "hidden panels still receive close completion/failure state");
  old.dispose();
  const replacement = h.open(), close = { type: "viewer.close", sessionId: "session-a", pageId: "page-a", mode: "selected" };
  h.calls.length = 0;
  old.send(close); replacement.send(close);
  assert.deepEqual(h.calls, [], "replacement panels need their own ready handshake");
  replacement.send({ type: "viewer.ready" }); h.calls.length = 0;
  old.send(close);
  assert.deepEqual(h.calls, []);
  replacement.send(close);
  assert.deepEqual(h.calls, [["close", "session-a", "page-a", "selected"]]);
  const recovered = state({ closingPageIds: [] });
  h.setState(recovered);
  assert.deepEqual(replacement.sent.at(-1), recovered);
});

test("panel forwards pointer and input results without putting them into the chat bridge", t => {
  const h = fixture(t), panel = h.open();
  const pointer = { type: "browser.viewer.pointer", sessionId: "session-a", pageId: "page-a", kind: "move", x: .5, y: .5 };
  const result = { type: "browser.viewer.inputResult", sessionId: "session-a", pageId: "page-a", controlId: "lease", inputId: 1, ok: true };
  h.pointers.fire(pointer); h.inputResults.fire(result); assert.deepEqual(panel.sent, []);
  panel.send({ type: "viewer.ready" });
  h.pointers.fire(pointer); h.inputResults.fire(result);
  assert.deepEqual(panel.sent.slice(-2), [pointer, result]);
  panel.show(false); const count = panel.sent.length;
  h.pointers.fire(pointer); assert.equal(panel.sent.length, count);
  h.manager.dispose();
  assert.equal(h.pointers.size, 0); assert.equal(h.inputResults.size, 0);
});

test("viewer serializer restores one viewer and disposes duplicate restored panels", async t => {
  const h = fixture(t), registration = h.manager.registerSerializer();
  assert.equal(h.serializers[0].type, h.BROWSER_VIEWER_TYPE);
  const restored = h.makePanel(3);
  await registration.serializer.deserializeWebviewPanel(restored);
  assert.equal(restored.webview.html, "production-html-fixture");
  h.manager.open();
  assert.equal(h.panels.length, 0);
  assert.deepEqual(restored.reveals, [3]);
  const duplicate = h.makePanel();
  await registration.serializer.deserializeWebviewPanel(duplicate);
  assert(duplicate.disposed); assert(!restored.disposed);
  restored.send({ type: "viewer.ready" });
  h.frames.fire(frame());
  assert.deepEqual(restored.sent.at(-1), frame());
  registration.dispose();
  assert(registration.disposed);
});

for (const outcome of ["throw", "false", "reject"]) test(`viewer ${outcome} delivery stops streaming and a retained panel recovers via readyRequest`, async t => {
  const h = fixture(t), panel = h.open();
  panel.send({ type: "viewer.ready" });
  await delay(0);
  const successfulPost = panel.webview.postMessage;
  panel.webview.postMessage = () => {
    if (outcome === "throw") throw new Error("synchronous delivery failure");
    return outcome === "false" ? Promise.resolve(false) : Promise.reject(new Error("asynchronous delivery failure"));
  };
  h.frames.fire(frame());
  await delay(0);
  assert.deepEqual(h.calls.at(-1), ["visible", false]);
  const callsBefore = h.calls.length, messagesBefore = panel.sent.length;
  panel.send({ type: "viewer.ack", sessionId: "session-a", pageId: "page-a", sequence: 1 });
  panel.send({ type: "viewer.close", sessionId: "session-a", pageId: "page-a", mode: "selected" });
  panel.send({ type: "viewer.close", sessionId: "session-a", pageId: "page-a", mode: "others" });
  panel.send({ type: "viewer.visibility", visible: true });
  h.states.fire(state()); h.frames.fire(frame({ sequence: 2 }));
  assert.equal(h.calls.length, callsBefore, "failed delivery resets readiness, not only visibility");
  assert.equal(panel.sent.length, messagesBefore);
  panel.webview.postMessage = successfulPost;
  panel.show(false);
  assert.equal(panel.sent.length, messagesBefore, "hidden panels do not request readiness");
  panel.show(true);
  assert.deepEqual(panel.sent.at(-1), { type: "browser.viewer.readyRequest" });
  assert.deepEqual(h.calls.at(-1), ["visible", false], "request alone cannot resume the producer");
  panel.send({ type: "viewer.ready", visible: true });
  assert.deepEqual(h.calls.at(-1), ["visible", true]);
  h.frames.fire(frame({ sequence: 3 }));
  assert.deepEqual(panel.sent.at(-1), frame({ sequence: 3 }));
  const requests = panel.sent.filter(message => message.type === "browser.viewer.readyRequest").length;
  panel.show(true);
  assert.equal(panel.sent.filter(message => message.type === "browser.viewer.readyRequest").length, requests, "ready panels do not remount on view-state changes");
});

for (const outcome of ["reject", "false"]) test(`late old-panel ${outcome} delivery cannot suspend a replacement`, async t => {
  const h = fixture(t), panel = h.open();
  panel.send({ type: "viewer.ready" });
  panel.webview.postMessage = async () => { throw new Error("disposed webview"); };
  h.frames.fire(frame());
  await delay(0);
  assert.deepEqual(h.calls.at(-1), ["visible", false]);
  const before = h.calls.length;
  panel.send({ type: "viewer.ack", sessionId: "session-a", pageId: "page-a", sequence: 1 });
  assert.equal(h.calls.length, before);
  let finish;
  panel.webview.postMessage = () => new Promise((resolve, reject) => { finish = () => outcome === "reject" ? reject(new Error("late old-panel failure")) : resolve(false); });
  panel.send({ type: "viewer.ready" });
  panel.dispose();
  const replacement = h.open();
  replacement.send({ type: "viewer.ready" });
  finish();
  await delay(0);
  assert.deepEqual(h.calls.at(-1), ["visible", true]);
  h.frames.fire(frame());
  assert.deepEqual(replacement.sent.at(-1), frame());
});

async function until(predicate, message) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { assert(Date.now() < deadline, message); await delay(5); }
}

test("panel/service integration filters ACKs, pause/hidden frames and old-scope producers", { timeout: 15000 }, async t => {
  assert.notEqual(process.platform, "win32", "this smoke deliberately exercises Unix IPC only");
  let scope = "/users/alice/projects/a/session";
  const { BrowserViewerService } = loadSource("src/browserViewerService.ts");
  const service = new BrowserViewerService(() => scope);
  const sockets = [], directories = [];
  t.after(async () => {
    sockets.forEach(socket => socket.destroy()); service.dispose();
    await until(() => directories.every(directory => !fs.existsSync(directory)), "IPC fixture directories must be cleaned up");
  });
  const h = fixture(t, service), panel = h.open();
  async function peer(pageId) {
    const connection = service.startSession(scope);
    assert(connection); directories.push(path.dirname(connection.socketPath));
    const socket = net.createConnection(connection.socketPath), messages = [];
    sockets.push(socket); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "", serial = 0;
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    await once(socket, "connect", { signal: AbortSignal.timeout(2500) });
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    send({ type: "hello", token: connection.token, pageId, title: "Fixture", url: "http://fixture.invalid/" });
    await until(() => service.getState().pages.some(page => page.id === pageId), "producer was not registered");
    return { ...connection, messages, socket, send, async barrier() {
      const title = `barrier-${++serial}`;
      send({ type: "page", title });
      await until(() => service.getState().pages[0]?.title === title, "IPC barrier missing");
    } };
  }
  const producer = await peer("page-a"), wireFrame = { type: "frame", data: "/9j/AAAA", width: 800, height: 600 };
  const frames = () => panel.sent.filter(item => item.type === "browser.viewer.frame");
  producer.send(wireFrame); await producer.barrier();
  assert.equal(frames().length, 0, "not ready means no stream");
  panel.send({ type: "viewer.ready" });
  producer.send(wireFrame);
  await until(() => frames().length === 1, "ready frame missing");
  const first = frames()[0], ack = { type: "viewer.ack", sessionId: first.sessionId, pageId: first.pageId, sequence: first.sequence };
  for (const patch of [{ sessionId: "old-session" }, { pageId: "other-page" }, { sequence: first.sequence + 1 }]) panel.send({ ...ack, ...patch });
  producer.send(wireFrame); await producer.barrier();
  assert.equal(frames().length, 1); assert.equal(producer.messages.filter(item => item.type === "ack").length, 0);
  panel.send(ack);
  await until(() => producer.messages.some(item => item.type === "ack"), "matching ACK missing");
  for (const mode of ["pause", "panel-hidden", "document-hidden"]) {
    if (mode === "pause") panel.send({ type: "viewer.pause", sessionId: producer.sessionId, paused: true });
    else if (mode === "panel-hidden") panel.show(false);
    else panel.send({ type: "viewer.visibility", visible: false });
    producer.send(wireFrame); await producer.barrier();
    assert.equal(frames().length, 1, `${mode} must not forward frames`);
    assert.equal(service.getState().status, "paused");
    if (mode === "pause") panel.send({ type: "viewer.pause", sessionId: producer.sessionId, paused: false });
    else if (mode === "panel-hidden") panel.show(true);
    else panel.send({ type: "viewer.visibility", visible: true });
    assert.equal(service.getState().status, "live");
  }
  scope = "/users/bob/projects/b/session";
  const oldClosed = once(producer.socket, "close", { signal: AbortSignal.timeout(2500) });
  producer.send(wireFrame);
  await oldClosed;
  assert.equal(frames().length, 1, "a revoked producer must not leak a cross-scope frame");
  assert.equal(panel.sent.at(-1).status, "idle");
  const replacement = await peer("page-a");
  assert.notEqual(replacement.sessionId, producer.sessionId);
  replacement.send(wireFrame);
  await until(() => frames().length === 2, "new scope frame missing");
  panel.send(ack); await replacement.barrier();
  assert.equal(replacement.messages.filter(item => item.type === "ack").length, 0, "old-scope ACK cannot release a new-scope frame");
  const latest = frames().at(-1);
  panel.send({ ...ack, sessionId: latest.sessionId, sequence: latest.sequence });
  await until(() => replacement.messages.some(item => item.type === "ack"), "new scope ACK missing");
  assert(producer.messages.concat(replacement.messages).every(item => ["stream", "ack"].includes(item.type)));
});

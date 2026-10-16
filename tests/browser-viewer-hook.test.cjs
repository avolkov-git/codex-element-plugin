const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const ts = require("typescript");
const { root, loadSource } = require("./service-test-utils.cjs");

const protocol = loadSource("src/browserViewerProtocol.ts");
const { VIEWER_MAX_FRAME } = protocol;
const CONNECTION = { socketPath: "/fixture/view.sock", token: "a".repeat(64), sessionId: "session-a" };
const ALLOWED_CDP = new Set(["Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"]);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fakeClock() {
  let now = 10000, serial = 0;
  const timers = new Map();
  const schedule = (callback, ms, interval = false) => {
    const timer = { id: ++serial, callback, at: now + ms, ms, interval, unref() { return this; } };
    timers.set(timer.id, timer);
    return timer;
  };
  return {
    timers,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms) => schedule(callback, ms),
    setInterval: (callback, ms) => schedule(callback, ms, true),
    clearTimeout: timer => timers.delete(timer?.id),
    clearInterval: timer => timers.delete(timer?.id),
    async advance(ms) {
      const target = now + ms;
      let iterations = 0;
      while (true) {
        const next = [...timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        assert(++iterations < 10000, "timer loop must remain bounded");
        now = next.at;
        if (next.interval) next.at += next.ms; else timers.delete(next.id);
        next.callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

// The shared loader omits interval globals. Keep this equivalent loader local to
// this test file so CDP races and pacing can use an entirely controlled clock.
function loadHook(mocks, clock, source = "browserViewerHook") {
  const filename = path.join(root, `src/${source}.ts`);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(output, {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : name === "./browserViewerProtocol" ? protocol
      : name === "./browserViewerInteraction" ? loadHook(mocks, clock, "browserViewerInteraction") : localRequire(name),
    Buffer, URL, process, console, Error, AbortController, ...clock,
  }, { filename });
  return module.exports;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writes = [];
  messages = [];
  unref() { return this; }
  setEncoding(value) { assert.equal(value, "utf8"); return this; }
  write(text) {
    assert.equal(this.destroyed, false, "must never write to a closed IPC socket");
    this.writes.push(text);
    for (const line of text.trimEnd().split("\n")) this.messages.push(JSON.parse(line));
    return this.writableLength === 0;
  }
  receive(value) { this.emit("data", `${JSON.stringify(value)}\n`); }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }
  frames() { return this.messages.filter(message => message.type === "frame"); }
}

function fixture(t, options = {}) {
  const clock = fakeClock(), sockets = [], calls = [], inputCalls = [];
  const bindings = new Map(), scripts = [], evaluations = [];
  const cdp = new EventEmitter();
  let detachCount = 0, sessionCount = 0, pageClosed = options.closed || false;
  cdp.send = async (method, params) => {
    calls.push({ method, params: params && JSON.parse(JSON.stringify(params)) });
    return options.send ? options.send(method, params) : {};
  };
  cdp.detach = async () => { detachCount++; if (options.detach) return options.detach(); };
  const page = new EventEmitter();
  const mainFrame = { evaluate: async script => { evaluations.push(script); }, };
  const forbidden = method => (...args) => { inputCalls.push({ method, args }); throw new Error(`Forbidden input: ${method}`); };
  Object.assign(page, {
    isClosed: () => pageClosed,
    title: options.title || (async () => "Fixture page"),
    url: () => options.url || "https://example.test/current",
    viewportSize: () => options.viewport === undefined ? { width: 1000, height: 500 } : options.viewport,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    exposeBinding: async (name, callback) => { bindings.set(name, callback); },
    addInitScript: async script => { scripts.push(script); },
    context: () => ({ newCDPSession: async target => {
      assert.equal(target, page, "CDP must attach to the existing MCP page");
      sessionCount++;
      return options.newCDPSession ? options.newCDPSession(cdp) : cdp;
    } }),
    goto: forbidden("goto"), click: forbidden("click"), evaluate: forbidden("evaluate"),
    keyboard: { press: forbidden("keyboard.press"), type: forbidden("keyboard.type") },
    mouse: { click: forbidden("mouse.click"), move: forbidden("mouse.move"), wheel: forbidden("mouse.wheel") },
    close() { pageClosed = true; page.emit("close"); },
  });
  const { attachBrowserViewer } = loadHook({ net: { createConnection(socketPath) {
    assert.equal(socketPath, CONNECTION.socketPath);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } } }, clock);
  t.after(async () => {
    page.close();
    await settle();
    assert.equal(inputCalls.length, 0, "viewer must never call Playwright input/focus APIs");
    const allowed = new Set([...ALLOWED_CDP, ...(options.manual ? ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.getLayoutMetrics"] : [])]);
    assert(calls.every(call => allowed.has(call.method)), "unapproved CDP method");
  });
  const attach = () => attachBrowserViewer(page, CONNECTION);
  const connect = async () => {
    attach();
    const socket = sockets.at(-1);
    socket.emit("connect");
    await settle();
    return socket;
  };
  const stream = async (socket, active) => { socket.receive({ type: "stream", active }); await settle(); };
  const frame = (id, changes = {}) => {
    const value = { sessionId: id, data: "/9j/" + Buffer.from(String(id)).toString("base64"),
      metadata: { deviceWidth: 1280.2, deviceHeight: 719.8 }, ...changes };
    cdp.emit("Page.screencastFrame", value);
    return value;
  };
  return { clock, sockets, calls, cdp, page, attach, connect, stream, frame, bindings, scripts, evaluations, mainFrame,
    get detachCount() { return detachCount; }, get sessionCount() { return sessionCount; } };
}

test("hook authenticates once, observes the existing page and bounds metadata", async t => {
  const f = fixture(t, { title: async () => "T".repeat(300), url: "https://example.test/" + "u".repeat(5000) });
  const socket = await f.connect();
  f.attach();
  assert.equal(f.sockets.length, 1, "duplicate hooks must not open duplicate sockets");
  assert.equal(f.sessionCount, 0, "hidden viewer must not create a CDP session");
  const hello = socket.messages.find(message => message.type === "hello");
  assert.equal(hello.token, CONNECTION.token);
  assert.match(hello.pageId, /^[a-f0-9-]+$/);
  assert.equal(hello.url.length, 4096);
  assert.equal(socket.messages.find(message => message.type === "page").title.length, 256);
  await f.stream(socket, true);
  assert.equal(f.sessionCount, 1);
  const start = f.calls.find(call => call.method === "Page.startScreencast");
  assert.equal(start.params.format, "jpeg");
  assert(start.params.quality > 0 && start.params.quality <= 100);
  assert(start.params.maxWidth <= 1440 && start.params.maxHeight <= 900);
});

test("hook ACKs every CDP frame while keeping only the latest frame for a slow viewer", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  const first = f.frame(1);
  assert.equal(socket.frames().length, 1);
  assert.equal(socket.frames()[0].data, first.data);
  assert.equal(socket.frames()[0].width, 1280);
  assert.equal(socket.frames()[0].height, 720);
  let latest;
  for (let id = 2; id <= 500; id++) latest = f.frame(id);
  await settle();
  assert.equal(socket.frames().length, 1, "only one frame may be in flight to the webview");
  assert.deepEqual(f.calls.filter(call => call.method === "Page.screencastFrameAck").map(call => call.params.sessionId),
    Array.from({ length: 500 }, (_, index) => index + 1));
  await f.clock.advance(1000);
  assert.equal(socket.frames().length, 1, "elapsed time alone must not bypass webview ACK");
  socket.receive({ type: "ack" });
  await settle();
  assert.equal(socket.frames().length, 2);
  assert.equal(socket.frames()[1].data, latest.data, "ACK must publish only the newest retained frame");
  socket.receive({ type: "ack" });
  await f.clock.advance(1000);
  assert.equal(socket.frames().length, 2, "a backlog must not replay after the latest frame");
});

test("hook frame pacing has a trailing flush so a final static frame is not lost", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  f.frame(1);
  socket.receive({ type: "ack" });
  await f.clock.advance(50);
  const latest = f.frame(2);
  await f.clock.advance(149);
  assert.equal(socket.frames().length, 1);
  await f.clock.advance(1);
  assert.equal(socket.frames().length, 2);
  assert.equal(socket.frames()[1].data, latest.data);
});

test("hook respects IPC backpressure without building a frame queue", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  socket.writableLength = VIEWER_MAX_FRAME;
  let latest;
  for (let id = 1; id <= 200; id++) latest = f.frame(id);
  await f.clock.advance(500);
  assert.equal(socket.frames().length, 0);
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 200);
  socket.writableLength = 0;
  await f.clock.advance(200);
  assert.equal(socket.frames().length, 1);
  assert.equal(socket.frames()[0].data, latest.data);
  socket.receive({ type: "ack" });
  await f.clock.advance(500);
  assert.equal(socket.frames().length, 1);
});

test("hook ACKs and drops oversized CDP frames without blocking a later valid frame", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  f.frame(1, { data: "/9j/" + "A".repeat(VIEWER_MAX_FRAME - 3) });
  assert.equal(socket.frames().length, 0);
  assert.equal(f.calls.at(-1).method, "Page.screencastFrameAck");
  f.frame(2, { data: "/9j/" + "A".repeat(VIEWER_MAX_FRAME - 4) });
  assert.equal(socket.frames().length, 1);
  assert.equal(socket.frames()[0].data.length, VIEWER_MAX_FRAME);
  assert(Buffer.byteLength(socket.writes.at(-1)) <= protocol.VIEWER_MAX_MESSAGE);
});

test("hook pause/hidden clears retained frames and resumes the same CDP session", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  f.frame(1);
  f.frame(2);
  await f.stream(socket, false);
  assert.equal(f.calls.at(-1).method, "Page.stopScreencast");
  f.frame(3);
  socket.receive({ type: "ack" });
  await f.clock.advance(500);
  assert.equal(socket.frames().length, 1);
  await f.stream(socket, true);
  assert.equal(f.sessionCount, 1);
  await f.clock.advance(500);
  assert.equal(socket.frames().length, 1, "resume must not reveal a stale paused frame");
  const fresh = f.frame(4);
  assert.equal(socket.frames().length, 2);
  assert.equal(socket.frames()[1].data, fresh.data);
});

test("hook handles fragmented controls and ignores arbitrary input/CDP commands", async t => {
  const f = fixture(t), socket = await f.connect();
  socket.emit("data", '{"type":"stream","active":');
  await settle();
  assert.equal(f.calls.length, 0);
  socket.emit("data", 'true}\n');
  await settle();
  for (const type of ["input", "click", "keydown", "navigate", "cdp", "Input.dispatchKeyEvent", "Page.navigate", "Runtime.evaluate"]) {
    socket.receive({ type, method: type, params: { expression: "document.body.click()" } });
  }
  socket.receive({ type: "stream", active: "true" });
  await settle();
  assert.deepEqual(f.calls.map(call => call.method), ["Page.startScreencast"]);
  assert.equal(socket.destroyed, false);
});

for (const [name, input] of [["malformed JSON", "{invalid}\n"], ["oversized input", "x".repeat(8193)]]) {
  test(`hook closes ${name}, detaches CDP and stops timers`, async t => {
    const f = fixture(t), socket = await f.connect();
    await f.stream(socket, true);
    f.frame(1);
    f.frame(2);
    socket.emit("data", input);
    await settle();
    assert.equal(socket.destroyed, true);
    assert.equal(f.detachCount, 1);
    const count = socket.messages.length;
    await f.clock.advance(10000);
    assert.equal(socket.messages.length, count);
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.page.listenerCount("close"), 0);
  });
}

test("hook bounds control IPC in UTF-8 bytes, not UTF-16 characters", async t => {
  const f = fixture(t), socket = await f.connect();
  socket.emit("data", "\u20ac".repeat(2731));
  await settle();
  assert.equal(socket.destroyed, true, "8193 UTF-8 bytes must exceed the 8192-byte control limit");
});

test("hook page close is idempotent and prevents queued frames/metadata from escaping", async t => {
  const title = deferred(), f = fixture(t, { title: () => title.promise }), socket = await f.connect();
  await f.stream(socket, true);
  f.frame(1);
  f.frame(2);
  f.page.close();
  f.page.close();
  title.resolve("late title");
  await settle();
  assert.equal(f.detachCount, 1);
  assert.equal(socket.destroyed, true);
  const count = socket.messages.length;
  f.frame(3);
  await f.clock.advance(10000);
  assert.equal(socket.messages.length, count);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.page.listenerCount("close"), 0);
  assert.equal(f.clock.timers.size, 0);
});

test("hook detaches a CDP session that resolves after page close", async t => {
  const pending = deferred(), f = fixture(t, { newCDPSession: () => pending.promise }), socket = await f.connect();
  await f.stream(socket, true);
  assert.equal(f.sessionCount, 1);
  f.page.close();
  pending.resolve(f.cdp);
  await settle();
  assert.equal(f.detachCount, 1, "late-created session must be detached even though cleanup ran before it existed");
  assert.equal(f.calls.filter(call => call.method === "Page.startScreencast").length, 0);
});

test("hook serializes rapid stream changes while newCDPSession is pending", async t => {
  const pending = deferred(), f = fixture(t, { newCDPSession: () => pending.promise }), socket = await f.connect();
  await f.stream(socket, true);
  await f.stream(socket, false);
  pending.resolve(f.cdp);
  await settle();
  assert.equal(f.sessionCount, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.startScreencast").length, 0, "obsolete start must not win over pause");
  assert.equal(f.calls.at(-1).method, "Page.stopScreencast");
  await f.stream(socket, true);
  assert.equal(f.sessionCount, 1);
  assert.equal(f.calls.at(-1).method, "Page.startScreencast");
});

test("hook serializes stop behind an in-flight startScreencast", async t => {
  const pending = deferred();
  const f = fixture(t, { send: method => method === "Page.startScreencast" ? pending.promise : {} }), socket = await f.connect();
  await f.stream(socket, true);
  await f.stream(socket, false);
  assert.deepEqual(f.calls.map(call => call.method), ["Page.startScreencast"]);
  pending.resolve({});
  await settle();
  assert.deepEqual(f.calls.map(call => call.method), ["Page.startScreencast", "Page.stopScreencast"]);
});

test("hook retries initial connection failures with a finite budget and cancels on page close", async t => {
  const f = fixture(t);
  f.attach();
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(f.sockets.length, attempt + 1);
    const socket = f.sockets.at(-1);
    socket.emit("error", new Error("fixture ECONNREFUSED"));
    socket.destroy();
    await settle();
    await f.clock.advance(250);
  }
  await f.clock.advance(10000);
  assert.equal(f.sockets.length, 20);
  assert.equal(f.page.listenerCount("close"), 0);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.sessionCount, 0);
});

test("hook pending retry is cancelled when the page closes", async t => {
  const f = fixture(t);
  f.attach();
  f.sockets[0].destroy();
  await settle();
  f.page.close();
  await f.clock.advance(10000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("hook broker shutdown after connection detaches without reconnecting stale credentials", async t => {
  const f = fixture(t), socket = await f.connect();
  await f.stream(socket, true);
  socket.destroy();
  await settle();
  await f.clock.advance(10000);
  assert.equal(f.detachCount, 1);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("hook does nothing for a page already closed before attachment", async t => {
  const f = fixture(t, { closed: true });
  f.attach();
  await settle();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.sessionCount, 0);
  assert.equal(f.page.listenerCount("close"), 0);
});

test("hook retries a transient CDP attach failure without reporting a permanent error", async t => {
  let attempts = 0;
  const f = fixture(t, { newCDPSession: cdp => { if (++attempts === 1) throw new Error("fixture CDP unavailable"); return cdp; } });
  const socket = await f.connect();
  await f.stream(socket, true);
  assert.equal(socket.messages.filter(message => message.type === "error").length, 0);
  await f.clock.advance(250);
  assert.equal(f.sessionCount, 2);
  assert.equal(f.calls.at(-1).method, "Page.startScreencast");
});

test("hook retries startScreencast rejection without duplicating the CDP attachment", async t => {
  let starts = 0;
  const f = fixture(t, { send: method => {
    if (method === "Page.startScreencast" && ++starts === 1) throw new Error("fixture start failed");
    return {};
  } }), socket = await f.connect();
  await f.stream(socket, true);
  assert.equal(socket.messages.filter(message => message.type === "error").length, 0);
  await f.clock.advance(250);
  assert.equal(starts, 2);
  assert.equal(f.sessionCount, 1);
  f.frame(1);
  assert.equal(socket.frames().length, 1);
});

test("hook observation retries are bounded and recover on an explicit resume", async t => {
  let fail = true;
  const f = fixture(t, { newCDPSession: cdp => { if (fail) throw new Error("fixture unavailable"); return cdp; } });
  const socket = await f.connect(); await f.stream(socket, true);
  await f.clock.advance(10000);
  assert.equal(f.sessionCount, 3);
  assert.equal(socket.messages.filter(message => message.type === "error").length, 1);
  fail = false;
  await f.stream(socket, true);
  assert.equal(f.sessionCount, 4);
  f.frame(1); assert.equal(socket.frames().length, 1);
});

for (const action of ["pause", "close"]) test(`hook ${action} cancels an observation retry`, async t => {
  const f = fixture(t, { newCDPSession: () => { throw new Error("fixture unavailable"); } });
  const socket = await f.connect(); await f.stream(socket, true);
  if (action === "pause") await f.stream(socket, false); else f.page.close();
  await f.clock.advance(10000);
  assert.equal(f.sessionCount, 1);
  assert.equal(socket.messages.filter(message => message.type === "error").length, 0);
});

test("hook ignores a failed startup superseded by pause", async t => {
  const pending = deferred();
  const f = fixture(t, { newCDPSession: () => pending.promise });
  const socket = await f.connect(); await f.stream(socket, true); await f.stream(socket, false);
  pending.reject(new Error("fixture obsolete startup")); await settle(); await f.clock.advance(10000);
  assert.equal(f.sessionCount, 1);
  assert.equal(socket.messages.filter(message => message.type === "error").length, 0);
});

test("hook contains rejected CDP ACK and detach promises without unhandled rejections", async t => {
  const f = fixture(t, {
    send: method => { if (method === "Page.screencastFrameAck") throw new Error("fixture ACK failed"); return {}; },
    detach: async () => { throw new Error("fixture already detached"); },
  }), socket = await f.connect();
  await f.stream(socket, true);
  f.frame(1);
  await settle();
  assert.equal(socket.frames().length, 1);
  f.page.close();
  await settle();
  assert.equal(f.detachCount, 1);
  assert.equal(socket.destroyed, true);
});

test("hook navigation metadata refresh keeps the same page ID and CDP attachment", async t => {
  let title = "Before navigation";
  const options = { title: async () => title, url: "https://example.test/before" };
  const f = fixture(t, options), socket = await f.connect();
  await f.stream(socket, true);
  const id = socket.messages.find(message => message.type === "hello").pageId;
  title = "After navigation";
  options.url = "https://example.test/after";
  f.page.emit("framenavigated", {});
  await f.clock.advance(1500);
  const metadata = socket.messages.filter(message => message.type === "page").at(-1);
  assert.equal(metadata.title, title);
  assert.equal(metadata.url, options.url);
  assert.equal(socket.messages.filter(message => message.type === "hello").length, 1);
  assert.equal(socket.messages[0].pageId, id);
  assert.equal(f.sessionCount, 1);
  const latest = f.frame(1);
  assert.equal(socket.frames().at(-1).data, latest.data);
});

for (const failure of ["rejected", "unresolved"]) {
  test(`hook ${failure} title lookup cannot block authentication or screencast`, async t => {
    const pending = deferred();
    const f = fixture(t, { title: () => failure === "rejected" ? Promise.reject(new Error("fixture navigation")) : pending.promise });
    const socket = await f.connect();
    assert.equal(socket.messages[0].type, "hello");
    await f.stream(socket, true);
    f.frame(1);
    assert.equal(socket.frames().length, 1);
    await f.clock.advance(1000);
    assert.equal(socket.messages.filter(message => message.type === "page").length, 1);
    assert.equal(typeof socket.messages.find(message => message.type === "page").title, "string");
  });
}

test("hook keeps one unresolved title lookup across 30 seconds and resumes polling after settlement", async t => {
  const lookups = [];
  const f = fixture(t, { title: () => {
    const lookup = deferred();
    lookups.push(lookup);
    return lookup.promise;
  } });
  const socket = await f.connect();
  assert.equal(lookups.length, 1);
  await f.clock.advance(30000);
  assert.equal(lookups.length, 1, "metadata deadlines must not start more page.title() calls while the original RPC is unresolved");
  assert(socket.messages.some(message => message.type === "page"), "an unresolved title must still allow fallback metadata");

  lookups[0].resolve("Recovered title");
  await settle();
  await f.clock.advance(1500);
  assert.equal(lookups.length, 2, "polling must resume once the original title RPC actually settles");
  lookups[1].resolve("Fresh title");
  await settle();
  assert.equal(socket.messages.filter(message => message.type === "page").at(-1).title, "Fresh title");

  f.page.close();
  await f.clock.advance(30000);
  assert.equal(lookups.length, 2, "closed pages must never start another metadata lookup");
  assert.equal(f.clock.timers.size, 0);
});

test("hook socket close while CDP attach is pending detaches the eventual session", async t => {
  const pending = deferred(), f = fixture(t, { newCDPSession: () => pending.promise }), socket = await f.connect();
  await f.stream(socket, true);
  socket.destroy();
  await settle();
  pending.resolve(f.cdp);
  await settle();
  assert.equal(f.detachCount, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.startScreencast").length, 0);
  assert.equal(f.page.listenerCount("close"), 0);
});

const textInput = { kind: "text", text: "private \u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80" };
const clickInput = { kind: "click", x: 0.5, y: 0.25, button: "left", clickCount: 2, modifiers: 0 };
const manualCalls = f => f.calls.filter(call => call.method.startsWith("Input."));
const inputResults = socket => socket.messages.filter(message => message.type === "input.result");

test("hook dispatches only validated input with an exact active nonempty lease", async t => {
  const f = fixture(t, { manual: true }), socket = await f.connect();
  const input = (inputId, controlId, value = textInput) => socket.receive({ type: "input", inputId, controlId, input: value });
  socket.receive({ type: "control", controlId: "lease" });
  input(1, "lease");
  await f.stream(socket, true);
  input(2, "lease");
  socket.receive({ type: "control", controlId: "lease" });
  input(3, ""); input(4, "wrong");
  input(5, "lease", { kind: "text", text: "x".repeat(1025) });
  input(6, "lease", { kind: "move", x: -1, y: 0.5 });
  input(7, "lease", { kind: "key", key: "F5", modifiers: 0 });
  await settle();
  assert.equal(manualCalls(f).length, 0);
  input(8, "lease");
  await settle();
  assert.deepEqual(manualCalls(f), [{ method: "Input.insertText", params: { text: textInput.text } }]);
  assert.deepEqual(inputResults(socket).at(-1), { type: "input.result", inputId: 8, controlId: "lease", ok: true });
  assert(!JSON.stringify(socket.messages).includes(textInput.text), "no input content may be reflected into IPC results");
  input(8, "lease");
  await settle();
  assert.equal(manualCalls(f).length, 1, "duplicate IDs must not replay text");
  socket.receive({ type: "control", controlId: "" });
  input(9, "lease");
  await settle();
  assert.equal(manualCalls(f).length, 1);
});

for (const invalidation of ["revoke", "replace", "pause", "navigation", "close"]) {
  test(`hook ${invalidation} stops accepted input waiting for CDP readiness`, async t => {
    const pending = deferred();
    const f = fixture(t, { manual: true, newCDPSession: () => pending.promise }), socket = await f.connect();
    await f.stream(socket, true);
    socket.receive({ type: "control", controlId: "lease" });
    socket.receive({ type: "input", controlId: "lease", inputId: 1, input: textInput });
    if (invalidation === "revoke") socket.receive({ type: "control", controlId: "" });
    if (invalidation === "replace") socket.receive({ type: "control", controlId: "new-lease" });
    if (invalidation === "pause") await f.stream(socket, false);
    if (invalidation === "navigation") f.page.emit("framenavigated", f.mainFrame);
    if (invalidation === "close") socket.destroy();
    await settle();
    pending.resolve(f.cdp);
    await settle();
    assert.equal(manualCalls(f).length, 0);
    if (invalidation !== "close") assert.equal(inputResults(socket).at(-1).ok, false);
  });
}

test("hook bounds unresolved input to one action without retaining or replaying a backlog", async t => {
  const pending = deferred();
  const f = fixture(t, { manual: true, send: method => method === "Input.insertText" ? pending.promise : {} }), socket = await f.connect();
  await f.stream(socket, true);
  socket.receive({ type: "control", controlId: "lease" });
  for (let inputId = 1; inputId <= 200; inputId++) socket.receive({ type: "input", controlId: "lease", inputId, input: textInput });
  await f.clock.advance(30000);
  assert.equal(manualCalls(f).length, 1);
  assert.equal(inputResults(socket).length, 199);
  assert(inputResults(socket).every(result => !result.ok));
  socket.receive({ type: "control", controlId: "" });
  pending.resolve({});
  await settle();
  assert.equal(inputResults(socket).at(-1).ok, false);
  assert.equal(manualCalls(f).length, 1);
});

for (const input of [clickInput, { kind: "key", key: "Enter", modifiers: 0 }]) {
  test(`hook revocation releases an unresolved ${input.kind} and suppresses remaining presses`, async t => {
    const pending = deferred(), pressed = input.kind === "click" ? "mousePressed" : "keyDown";
    const released = input.kind === "click" ? "mouseReleased" : "keyUp";
    const f = fixture(t, { manual: true, send: (_method, params) => params?.type === pressed ? pending.promise : {} }), socket = await f.connect();
    await f.stream(socket, true);
    socket.receive({ type: "control", controlId: "lease" });
    socket.receive({ type: "input", controlId: "lease", inputId: 1, input });
    await settle();
    assert.equal(manualCalls(f).length, 1);
    socket.receive({ type: "control", controlId: "" });
    await settle();
    assert.deepEqual(manualCalls(f).map(call => call.params.type), [pressed, released]);
    pending.resolve({});
    await settle();
    assert.equal(manualCalls(f).length, 2);
    assert.equal(inputResults(socket).at(-1).ok, false);
  });
}

test("hook close releases before detach and caps a blocked release without double-detaching", async t => {
  const down = deferred(), up = deferred();
  const f = fixture(t, { manual: true, send: (_method, params) => params?.type === "mousePressed" ? down.promise
    : params?.type === "mouseReleased" ? up.promise : {} }), socket = await f.connect();
  await f.stream(socket, true);
  socket.receive({ type: "control", controlId: "lease" });
  socket.receive({ type: "input", controlId: "lease", inputId: 1, input: clickInput });
  await settle();
  socket.destroy();
  await settle();
  assert.equal(manualCalls(f).at(-1).params.type, "mouseReleased");
  assert.equal(f.detachCount, 0);
  await f.clock.advance(1000);
  assert.equal(f.detachCount, 1);
  down.resolve({}); up.resolve({});
  await settle();
  assert.equal(f.detachCount, 1);
  assert.equal(inputResults(socket).length, 0);
  assert.equal(f.page.listenerCount("framenavigated"), 0);
});

test("hook navigation clears pointers, revokes control and drops retained pre-navigation frames", async t => {
  const f = fixture(t, { manual: true }), socket = await f.connect();
  await f.stream(socket, true);
  socket.receive({ type: "control", controlId: "lease" });
  f.frame(1); f.frame(2);
  f.page.emit("framenavigated", f.mainFrame);
  socket.receive({ type: "ack" });
  socket.receive({ type: "input", controlId: "lease", inputId: 1, input: textInput });
  await f.clock.advance(1000);
  assert.equal(manualCalls(f).length, 0);
  assert.equal(socket.frames().length, 1);
  assert.equal(socket.messages.filter(message => message.type === "navigation").length, 1);
  assert.deepEqual(socket.messages.find(message => message.type === "pointer"), { type: "pointer", kind: "clear", x: 0, y: 0 });
  const callback = [...f.bindings.values()][0];
  const reply = await callback({ page: f.page, frame: f.mainFrame }, { kind: "ready" });
  await callback({ page: f.page, frame: f.mainFrame }, { kind: "move", x: 0.2, y: 0.3, epoch: reply.epoch - 1 });
  await settle();
  assert.equal(socket.messages.filter(message => message.type === "pointer").length, 1);
});

test("hook iframe navigation refreshes observation without revoking the main-page lease", async t => {
  const f = fixture(t, { manual: true }), socket = await f.connect();
  await f.stream(socket, true);
  socket.receive({ type: "control", controlId: "lease" });
  f.page.emit("framenavigated", {});
  socket.receive({ type: "input", controlId: "lease", inputId: 1, input: textInput });
  await settle();
  assert.equal(socket.messages.filter(message => message.type === "navigation").length, 0);
  assert.equal(manualCalls(f).length, 1);
  assert.equal(inputResults(socket).at(-1).ok, true);
});

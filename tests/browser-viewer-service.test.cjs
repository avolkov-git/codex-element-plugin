const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");

const { BrowserViewerService } = loadSource("src/browserViewerService.ts");
const { VIEWER_MAX_FRAME, VIEWER_MAX_MESSAGE } = loadSource("src/browserViewerProtocol.ts");
const { isViewerInput } = loadSource("src/browserViewerProtocol.ts");
const FRAME = { type: "frame", data: "/9j/AAAA", width: 800, height: 600 };

async function until(predicate, message, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await delay(5);
  }
}

function fixture(t) {
  let scope = "/users/alice/projects/one/sessions/current";
  const service = new BrowserViewerService(() => scope);
  const frames = [], states = [], clients = [], directories = [];
  service.onFrame(frame => frames.push(JSON.parse(JSON.stringify(frame))));
  service.onState(state => states.push(JSON.parse(JSON.stringify(state))));
  t.after(async () => {
    clients.forEach(client => client.socket.destroy());
    service.dispose();
    await until(() => directories.every(directory => !fs.existsSync(directory)), "IPC directories must be removed after disposal");
  });
  const start = () => {
    const connection = service.startSession(scope);
    assert(connection, "a current trusted scope must create an IPC session");
    if (process.platform !== "win32") directories.push(path.dirname(connection.socketPath));
    return connection;
  };
  async function connect(connection) {
    const socket = net.createConnection(connection.socketPath);
    const messages = [], errors = [];
    let text = "", closed = false;
    socket.setEncoding("utf8");
    socket.on("error", error => errors.push(error));
    socket.on("close", () => { closed = true; });
    socket.on("data", chunk => {
      text += chunk;
      let end;
      while ((end = text.indexOf("\n")) !== -1) {
        messages.push(JSON.parse(text.slice(0, end)));
        text = text.slice(end + 1);
      }
    });
    const client = { socket, messages, errors, get closed() { return closed; },
      send: message => socket.write(`${JSON.stringify(message)}\n`),
      count: type => messages.filter(message => message.type === type).length,
    };
    clients.push(client);
    await once(socket, "connect", { signal: AbortSignal.timeout(2000) });
    return client;
  }
  async function peer(connection, pageId = "page-a") {
    const client = await connect(connection);
    client.send({ type: "hello", token: connection.token, pageId, title: pageId, url: `https://example.test/${pageId}` });
    await until(() => service.getState().pages.some(page => page.id === pageId), "authenticated page must appear");
    let serial = 0;
    client.barrier = async () => {
      const title = `barrier-${pageId}-${++serial}`;
      client.send({ type: "page", title });
      await until(() => service.getState().pages.some(page => page.id === pageId && page.title === title), "IPC barrier was not processed");
    };
    return client;
  }
  return { service, frames, states, start, connect, peer, get scope() { return scope; }, setScope(value) { scope = value; } };
}

test("viewer IPC is local/private, session credentials rotate and public events do not expose them", async t => {
  const f = fixture(t);
  const first = f.start();
  assert.equal(f.service.getState().status, "waiting");
  assert.match(first.token, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(first.socketPath)).mode & 0o777, 0o700);
    await until(() => fs.existsSync(first.socketPath), "Unix socket was not created");
    assert(fs.statSync(first.socketPath).isSocket());
  } else assert(first.socketPath.startsWith("\\\\.\\pipe\\"));
  const peer = await f.peer(first);
  const second = f.start();
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.socketPath, first.socketPath);
  await until(() => peer.closed, "restart must close the previous producer");
  assert.equal(f.service.getState().pages.length, 0);
  const publicEvents = JSON.stringify(f.states);
  for (const secret of [first.token, second.token, first.socketPath, second.socketPath]) assert(!publicEvents.includes(secret));
});

for (const [name, token] of [
  ["missing", undefined], ["wrong length", "x"], ["wrong value", "0".repeat(64)],
  ["non-string", 42], ["same character count but different byte length", "\u00e9".repeat(64)],
]) {
  test(`viewer rejects ${name} auth token before registering a page`, async t => {
    const f = fixture(t), connection = f.start(), client = await f.connect(connection);
    client.send({ type: "hello", token, pageId: "unauthorized" });
    await until(() => client.closed, "invalid token must close its socket");
    assert.equal(f.service.getState().pages.length, 0);
    assert.equal(f.frames.length, 0);
    assert.equal(client.messages.length, 0, "unauthenticated sockets must not receive controls");
    await f.peer(connection, "valid-after-rejection");
  });
}

test("viewer rejects frames before hello, invalid page IDs and duplicate page ownership", async t => {
  const f = fixture(t), connection = f.start();
  const owner = await f.peer(connection);
  for (const message of [FRAME, null, [], { type: "hello", token: connection.token, pageId: "../page" },
    { type: "hello", token: connection.token, pageId: "a".repeat(65) },
    { type: "hello", token: connection.token, pageId: "page-a" }]) {
    const client = await f.connect(connection);
    client.send(message);
    await until(() => client.closed, "invalid handshake must be rejected");
    assert.equal(f.service.getState().pages.length, 1);
    assert.equal(owner.closed, false, "a rejected duplicate must not remove the original page");
  }
});

test("viewer hello timeout closes unauthenticated connections", { timeout: 5000 }, async t => {
  const f = fixture(t), client = await f.connect(f.start());
  await until(() => client.closed, "hello timeout did not close the socket", 4000);
  assert.equal(f.service.getState().pages.length, 0);
});

test("viewer scope must match exactly and a scope change revokes existing producers", async t => {
  const f = fixture(t);
  for (const scope of [undefined, "", `${f.scope}-other`, path.dirname(f.scope)]) {
    assert.equal(f.service.startSession(scope), undefined);
    assert.equal(f.service.getState().status, "idle");
  }
  const connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  await until(() => client.messages.some(message => message.active === true), "stream was not enabled");
  f.setScope("/users/bob/projects/one/sessions/current");
  client.send(FRAME);
  await until(() => client.closed, "old scope socket must be revoked on input");
  assert.equal(f.frames.length, 0);
  assert.equal(f.service.getState().status, "idle");
  const replacement = f.start(), replay = await f.connect(replacement);
  replay.send({ type: "hello", token: connection.token, pageId: "replayed" });
  await until(() => replay.closed, "a token from another scope must not authenticate");
});

test("viewer state reads revoke a scope that disappeared without waiting for a frame", async t => {
  const f = fixture(t), client = await f.peer(f.start());
  f.setScope(undefined);
  assert.equal(f.service.getState().status, "idle");
  await until(() => client.closed, "lost scope must close the producer");
});

test("viewer ACK rechecks scope before releasing an old producer", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  client.send(FRAME);
  await until(() => f.frames.length === 1, "first frame missing");
  const frame = f.frames[0];
  f.setScope("/users/bob/projects/two/sessions/current");
  f.service.acknowledge(connection.sessionId, frame.pageId, frame.sequence);
  // Do not call getState here: it revokes the scope itself and would hide a
  // missing authorization check in the ACK entry point.
  await until(() => client.closed || client.count("ack") > 0, "scope-invalid ACK must revoke the producer");
  assert.equal(client.count("ack"), 0, "an old scope must not receive permission to send another frame");
  assert.equal(f.frames.length, 1);
});

test("viewer restart with a pending frame rejects stale session and sequence ACKs", async t => {
  const f = fixture(t), first = f.start(), oldPeer = await f.peer(first);
  f.service.setVisible(true);
  oldPeer.send(FRAME);
  await until(() => f.frames.length === 1, "old session frame missing");
  const oldFrame = f.frames[0], second = f.start(), current = await f.peer(second);
  await until(() => oldPeer.closed, "restart must close the previous producer");
  current.send(FRAME);
  await until(() => f.frames.length === 2, "new session frame missing");
  const newFrame = f.frames[1];
  f.service.acknowledge(first.sessionId, newFrame.pageId, newFrame.sequence);
  f.service.acknowledge(second.sessionId, newFrame.pageId, oldFrame.sequence);
  await current.barrier();
  assert.equal(current.count("ack"), 0);
  f.service.acknowledge(second.sessionId, newFrame.pageId, newFrame.sequence);
  await until(() => current.count("ack") === 1, "only the current session/frame ACK may release the producer");
});

test("viewer repeated immediate restarts clean up each superseded socket directory", async t => {
  const f = fixture(t), sessions = new Set();
  let connection;
  for (let i = 0; i < 20; i++) {
    connection = f.start();
    assert(!sessions.has(connection.sessionId));
    sessions.add(connection.sessionId);
  }
  await f.peer(connection);
  f.service.stop();
  assert.equal(f.service.getState().status, "idle");
});

test("viewer reassembles fragmented UTF-8 and newline-delimited IPC without mixing pages", async t => {
  const f = fixture(t), connection = f.start(), client = await f.connect(connection);
  const hello = Buffer.from(JSON.stringify({ type: "hello", token: connection.token, pageId: "page-a", title: "\u041f\u0440\u0438\u0432\u0435\u0442" }) + "\n");
  const split = hello.indexOf(Buffer.from("\u041f")) + 1;
  client.socket.write(hello.subarray(0, split));
  await delay(10);
  assert.equal(f.service.getState().pages.length, 0);
  client.socket.write(hello.subarray(split));
  await until(() => f.service.getState().pages[0]?.title === "\u041f\u0440\u0438\u0432\u0435\u0442", "UTF-8 split corrupted the handshake");
  client.socket.write('{"type":"page","title":"first"}\n{"type":"page","title":"last","url":"https://example.test/new"}\n');
  await until(() => f.service.getState().pages[0]?.title === "last", "coalesced messages were not processed");
  assert.equal(f.service.getState().pages[0].url, "https://example.test/new");
});

for (const terminated of [false, true]) {
  test(`viewer bounds oversized IPC ${terminated ? "lines" : "unterminated fragments"}`, async t => {
    const f = fixture(t), connection = f.start(), client = await f.peer(connection);
    client.socket.write("x".repeat(VIEWER_MAX_MESSAGE + 1) + (terminated ? "\n" : ""));
    await until(() => client.closed, "oversized IPC must close the producer");
    await until(() => f.service.getState().pages.length === 0, "closed oversized producer must be removed");
    await f.peer(connection, "healthy");
  });
}

test("viewer bounds IPC in bytes, including multibyte metadata", async t => {
  const f = fixture(t), client = await f.peer(f.start());
  const wire = JSON.stringify({ type: "page", title: "\u20ac".repeat(Math.floor(VIEWER_MAX_MESSAGE / 3) + 1) }) + "\n";
  assert(Buffer.byteLength(wire) > VIEWER_MAX_MESSAGE);
  assert(wire.length < VIEWER_MAX_MESSAGE);
  client.socket.write(wire);
  await until(() => client.closed, "IPC byte limit must not be bypassed with multibyte characters");
});

test("viewer rejects malformed JSON and remains usable by other peers", async t => {
  const f = fixture(t), connection = f.start(), healthy = await f.peer(connection), broken = await f.peer(connection, "broken");
  broken.socket.write("{not-json}\n");
  await until(() => broken.closed, "malformed JSON must close its socket");
  await healthy.barrier();
  assert.equal(healthy.closed, false);
});

test("viewer drops invalid/oversized frames with ACK, accepts exact limits and bounds page metadata", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  for (const changes of [
    { data: "/9j/" + "A".repeat(VIEWER_MAX_FRAME - 3) }, { data: "" }, { data: "not-a-jpeg" },
    { data: "/9j/!" }, { data: 42 }, { width: 0 }, { height: 4097 }, { width: 1.5 }, { height: "600" },
  ]) {
    const acks = client.count("ack");
    client.send({ ...FRAME, ...changes });
    await until(() => client.count("ack") === acks + 1, "invalid frame needs ACK so the producer can recover");
    assert.equal(f.frames.length, 0);
  }
  client.send({ ...FRAME, data: "/9j/" + "A".repeat(VIEWER_MAX_FRAME - 4), width: 4096, height: 1 });
  await until(() => f.frames.length === 1, "frame exactly at the limit must be accepted");
  assert.equal(f.frames[0].data.length, VIEWER_MAX_FRAME);
  client.send({ type: "page", title: "T".repeat(1000), url: "https://example.test/" + "u".repeat(5000) });
  await until(() => f.service.getState().pages[0].title.length === 256, "title was not bounded");
  assert.equal(f.service.getState().pages[0].url.length, 4096);
});

test("viewer keeps one unacknowledged frame, rejects stale ACK and never replays a slow-webview backlog", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  client.send(FRAME);
  await until(() => f.frames.length === 1, "first frame missing");
  const first = f.frames[0];
  for (let i = 0; i < 100; i++) client.send({ ...FRAME, data: "/9j/BBBB" });
  await client.barrier();
  assert.equal(f.frames.length, 1, "slow rendering must not queue frames in the broker");
  for (const args of [["old-session", first.pageId, first.sequence], [connection.sessionId, "other-page", first.sequence],
    [connection.sessionId, first.pageId, first.sequence + 1]]) f.service.acknowledge(...args);
  await client.barrier();
  assert.equal(client.count("ack"), 0);
  f.service.acknowledge(connection.sessionId, first.pageId, first.sequence);
  await until(() => client.count("ack") === 1, "matching webview ACK must release the producer");
  await client.barrier();
  assert.equal(f.frames.length, 1, "old frames must not be replayed after ACK");
  client.send({ ...FRAME, data: "/9j/CCCC" });
  await until(() => f.frames.length === 2, "fresh frame must resume after ACK");
  assert(f.frames[1].sequence > first.sequence);
  f.service.acknowledge(connection.sessionId, first.pageId, first.sequence);
  await client.barrier();
  assert.equal(client.count("ack"), 1, "duplicate ACK must not release a newer frame");
});

test("viewer selecting the current page must not discard the outstanding ACK", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  client.send(FRAME);
  await until(() => f.frames.length === 1, "first frame missing");
  const frame = f.frames[0];
  f.service.selectPage(connection.sessionId, frame.pageId);
  f.service.acknowledge(connection.sessionId, frame.pageId, frame.sequence);
  await until(() => client.count("ack") === 1, "reselecting the active page must not lose its pending ACK and freeze the hook");
});

test("viewer pause/hidden stops streaming; resume does not release stale ACK or replay old frames", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  assert.equal(f.service.getState().status, "paused");
  for (const mode of ["paused", "hidden"]) {
    f.service.setVisible(true);
    f.service.setPaused(false);
    await until(() => client.messages.at(-1)?.active === true, "resume must enable stream");
    client.send(FRAME);
    const count = f.frames.length;
    await until(() => f.frames.length > count, "live frame missing");
    const previous = f.frames.at(-1), acks = client.count("ack");
    if (mode === "paused") f.service.setPaused(true); else f.service.setVisible(false);
    await until(() => client.messages.at(-1)?.active === false, "pause/hidden must disable stream");
    assert.equal(f.service.getState().status, "paused");
    client.send(FRAME);
    f.service.acknowledge(connection.sessionId, previous.pageId, previous.sequence);
    await client.barrier();
    assert.equal(f.frames.at(-1), previous);
    assert.equal(client.count("ack"), acks, "old ACK must not release a paused stream");
  }
});

test("viewer ACK timeout stops streaming rather than continuing to enqueue frames", { timeout: 5000 }, async t => {
  const f = fixture(t), client = await f.peer(f.start());
  f.service.setVisible(true);
  client.send(FRAME);
  await until(() => f.frames.length === 1, "first frame missing");
  await until(() => client.messages.at(-1)?.active === false, "missing webview ACK must stop streaming", 4000);
  assert.equal(f.service.getState().status, "paused");
  client.send(FRAME);
  await client.barrier();
  assert.equal(f.frames.length, 1);
});

test("viewer switches pages, rejects stale selectors, and selects a survivor on page close", async t => {
  const f = fixture(t), connection = f.start(), a = await f.peer(connection), b = await f.peer(connection, "page-b");
  f.service.setVisible(true);
  f.service.selectPage("wrong-session", "page-b");
  f.service.selectPage(connection.sessionId, "missing");
  assert.equal(f.service.getState().selectedPageId, "page-a");
  b.send(FRAME);
  await b.barrier();
  assert.equal(f.frames.length, 0);
  f.service.selectPage(connection.sessionId, "page-b");
  await until(() => a.messages.at(-1)?.active === false && b.messages.at(-1)?.active === true, "switch must enable exactly one producer");
  b.socket.destroy();
  await until(() => f.service.getState().selectedPageId === "page-a", "closing selection must choose the remaining page");
  await until(() => a.messages.at(-1)?.active === true, "surviving page must resume");
  a.socket.destroy();
  await until(() => f.service.getState().pages.length === 0, "closed pages must disappear");
  assert.equal(f.service.getState().status, "waiting");
});

test("viewer ignores input-shaped IPC and sends only stream/ACK controls", async t => {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  for (const type of ["input", "click", "keydown", "navigate", "cdp", "Input.dispatchMouseEvent", "Page.navigate"]) {
    client.send({ type, method: type, params: { x: 5, y: 9, url: "https://example.test/forbidden" } });
  }
  await client.barrier();
  assert.equal(f.frames.length, 0);
  assert(client.messages.every(message => message.type === "stream" || message.type === "ack"));
  f.service.stop();
  f.service.stop();
  await until(() => client.closed, "stop must close all producers");
  assert.equal(f.service.getState().status, "idle");
  assert.equal(f.service.getState().sessionId, "");
  assert.equal(f.service.getState().pages.length, 0);
});

test("viewer publishes recovery from a CDP error on the next valid frame", async t => {
  const f = fixture(t), client = await f.peer(f.start());
  f.service.setVisible(true);
  client.send({ type: "error" });
  await until(() => f.states.at(-1)?.status === "error", "CDP failure must be visible");
  client.send(FRAME);
  await until(() => f.frames.length === 1, "recovery frame missing");
  assert.equal(f.states.at(-1).status, "live", "UI must receive a recovery state, not just getState callers");
});

async function controllable(t) {
  const f = fixture(t), connection = f.start(), client = await f.peer(connection);
  f.service.setVisible(true);
  client.send(FRAME);
  await until(() => f.frames.length === 1, "a decoded frame is required for manual control");
  const frame = f.frames[0];
  f.service.acknowledge(connection.sessionId, frame.pageId, frame.sequence);
  f.service.setControl(connection.sessionId, frame.pageId, true);
  const controlId = f.service.getState().controlId;
  assert(controlId);
  await until(() => client.messages.some(m => m.type === "control" && m.controlId === controlId), "control lease missing");
  return { ...f, connection, client, controlId, pageId: frame.pageId };
}

test("manual input schema rejects arbitrary CDP, invalid geometry and unbounded text", () => {
  for (const value of [null, [], {}, { kind: "Page.navigate", url: "https://example.test" },
    { kind: "move", x: -1, y: 0 }, { kind: "move", x: NaN, y: 0 }, { kind: "move", x: 0, y: Infinity },
    { kind: "click", x: 0, y: 0, button: "left", clickCount: "1", modifiers: 0 },
    { kind: "click", x: 0, y: 0, button: "left", clickCount: 3, modifiers: 0 },
    { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 2001 },
    { kind: "key", key: "Power", modifiers: 0 }, { kind: "key", key: "a", modifiers: 16 },
    { kind: "text", text: "x".repeat(1025) }, { kind: "text", text: "\u0000" }, { kind: "text", text: "" }]) assert.equal(isViewerInput(value), false, JSON.stringify(value));
  for (const value of [{ kind: "move", x: 0, y: 1 }, { kind: "text", text: "Привет\nмир 😀" },
    { kind: "click", x: .5, y: .7, button: "left", clickCount: 2, modifiers: 8 },
    { kind: "wheel", x: .5, y: .5, deltaX: -2, deltaY: 500 }, { kind: "key", key: "a", modifiers: 2 }]) assert(isViewerInput(value));
});

test("control is opt-in and requires a visible, decoded current page", async t => {
  const f = fixture(t), c = f.start(), client = await f.peer(c);
  f.service.setControl(c.sessionId, "page-a", true);
  assert.equal(f.service.getState().controlId, "");
  f.service.setVisible(true);
  f.service.setControl(c.sessionId, "page-a", true);
  assert.equal(f.service.getState().controlId, "");
  client.send(FRAME);
  await until(() => f.frames.length === 1, "frame missing");
  f.service.setControl(c.sessionId, "page-a", true);
  assert.equal(f.service.getState().controlId, "", "not enabled before decode ACK");
  f.service.acknowledge(c.sessionId, "page-a", f.frames[0].sequence);
  f.service.setControl(c.sessionId, "page-a", true);
  assert(f.service.getState().controlId);
});

test("same-page navigation invalidates old frame ACK and requires a new decoded revision", async t => {
  const f = fixture(t), c = f.start(), client = await f.peer(c);
  f.service.setVisible(true); client.send(FRAME);
  await until(() => f.frames.length === 1, "old frame missing");
  const old = f.frames[0];
  client.send({ type: "navigation" });
  await until(() => f.service.getState().pageRevision > old.pageRevision, "revision did not change");
  f.service.acknowledge(c.sessionId, old.pageId, old.sequence);
  f.service.setControl(c.sessionId, old.pageId, true);
  assert.equal(f.service.getState().controlId, "", "old decode must not reauthorize control");
  client.send(FRAME); await until(() => f.frames.length === 2, "new frame missing");
  const next = f.frames[1];
  assert.equal(next.pageRevision, f.service.getState().pageRevision);
  f.service.acknowledge(c.sessionId, next.pageId, next.sequence);
  f.service.setControl(c.sessionId, next.pageId, true);
  assert(f.service.getState().controlId);
});

test("manual input is acknowledged once and stale IDs/leases/pages cannot dispatch", async t => {
  const f = await controllable(t), results = [];
  f.service.onInputResult(value => results.push(value));
  const input = { kind: "text", text: "Привет" };
  const send = (session = f.connection.sessionId, page = f.pageId, control = f.controlId, id = 1, value = input) => f.service.sendInput(session, page, control, id, value);
  send("old"); send(undefined, "other"); send(undefined, undefined, "old");
  send(undefined, undefined, undefined, 0); send(undefined, undefined, undefined, 1, { kind: "cdp" });
  await delay(10); assert.equal(f.client.count("input"), 0);
  send();
  await until(() => f.client.count("input") === 1, "input not sent");
  assert.deepEqual(f.client.messages.filter(m => m.type === "input")[0].input, input);
  f.client.send({ type: "input.result", controlId: "old", inputId: 1, ok: true });
  f.client.send({ type: "input.result", controlId: f.controlId, inputId: 2, ok: true });
  await delay(10); assert.equal(results.length, 0);
  f.client.send({ type: "input.result", controlId: f.controlId, inputId: 1, ok: true });
  await until(() => results.length === 1, "input result missing");
  assert.equal(results[0].ok, true);
  assert(!JSON.stringify(results).includes(input.text), "typed text never appears in status messages");
  send(); await delay(10); assert.equal(f.client.count("input"), 1, "duplicate id cannot replay text");
});

for (const mode of ["hidden", "paused", "selected", "navigation", "disabled", "scope", "stopped"]) {
  test(`manual lease is revoked on ${mode}, including in-flight responses`, async t => {
    const f = await controllable(t), results = [];
    f.service.onInputResult(result => results.push(result));
    f.service.sendInput(f.connection.sessionId, f.pageId, f.controlId, 1, { kind: "text", text: "one" });
    await until(() => f.client.count("input") === 1, "first command missing");
    if (mode === "hidden") f.service.setVisible(false);
    if (mode === "paused") f.service.setPaused(true);
    if (mode === "selected") { await f.peer(f.connection, "page-b"); f.service.selectPage(f.connection.sessionId, "page-b"); }
    if (mode === "navigation") { f.client.send({ type: "navigation" }); await until(() => !f.service.getState().controlId, "navigation did not revoke"); }
    if (mode === "disabled") f.service.setControl(f.connection.sessionId, f.pageId, false);
    if (mode === "scope") f.setScope("/other-scope");
    if (mode === "stopped") f.service.stop();
    f.service.sendInput(f.connection.sessionId, f.pageId, f.controlId, 2, { kind: "text", text: "two" });
    if (!f.client.socket.destroyed) f.client.send({ type: "input.result", controlId: f.controlId, inputId: 1, ok: true });
    await delay(10);
    assert.equal(f.service.getState().controlId, "");
    assert.equal(f.client.count("input"), 1); assert.equal(results.length, 0);
  });
}

test("manual input timeout revokes control without retrying an uncertain operation", { timeout: 11000 }, async t => {
  const f = await controllable(t), results = [];
  f.service.onInputResult(result => results.push(result));
  f.service.sendInput(f.connection.sessionId, f.pageId, f.controlId, 1, { kind: "key", key: "Enter", modifiers: 0 });
  await until(() => results.length === 1, "input deadline missing", 9000);
  assert.equal(results[0].ok, false);
  assert.equal(f.service.getState().controlId, "");
  assert.match(f.service.getState().inputError, /не будет повторена/);
  assert.equal(f.client.count("input"), 1);
});

test("manual input has one in-flight command and a failed command revokes the lease", async t => {
  for (const overflow of [false, true]) {
    const f = await controllable(t), results = [];
    f.service.onInputResult(result => results.push(result));
    f.service.sendInput(f.connection.sessionId, f.pageId, f.controlId, 1, { kind: "text", text: "one" });
    await until(() => f.client.count("input") === 1, "input missing");
    if (overflow) f.service.sendInput(f.connection.sessionId, f.pageId, f.controlId, 2, { kind: "text", text: "two" });
    else f.client.send({ type: "input.result", controlId: f.controlId, inputId: 1, ok: false });
    await until(() => !f.service.getState().controlId, "failure did not revoke");
    assert.equal(results.length, 1); assert.equal(results[0].ok, false);
    assert.equal(f.client.count("input"), 1);
  }
});

test("pointer forwarding is scoped, bounded and excludes arbitrary page data", async t => {
  const f = await controllable(t), pointers = [], b = await f.peer(f.connection, "page-b");
  f.service.onPointer(value => pointers.push(value));
  const event = { type: "pointer", kind: "focus", x: .2, y: .3, bounds: { x: .1, y: .2, width: .3, height: .1, value: "secret" }, text: "secret" };
  b.send(event); f.client.send({ ...event, x: -1 }); f.client.send({ ...event, bounds: { x: 0 } });
  await delay(10); assert.equal(pointers.length, 0);
  f.client.send(event);
  await until(() => pointers.length === 1, "pointer missing");
  assert.equal(pointers[0].pageId, f.pageId);
  assert(!JSON.stringify(pointers).includes("secret"));
  f.service.setPaused(true); f.client.send(event); await delay(10);
  assert.equal(pointers.length, 1);
});

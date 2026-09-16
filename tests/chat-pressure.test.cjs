const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource, logger, vscode } = require("./service-test-utils.cjs");
const { DiffPatchStore, summarizePatch, patchFromChanges, MAX_PATCH_BYTES } = loadSource("src/diffPatchStore.ts");
const { ChatPanelManager } = loadSource("src/chatPanelManager.ts", { vscode });
const { SidebarProvider } = loadSource("src/sidebarProvider.ts", { vscode });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const patch = (name = "file.xbsl", body = "-before\n+after\n") => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}`;

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-pressure-")));
  let root = path.join(temp, "user-a", "project-a");
  const store = new DiffPatchStore(() => root, logger);
  t.after(async () => { store.dispose(); await store.flush(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, store, get root() { return root; }, switchRoot(value) { root = value; } };
}

test("large UTF-8 patches keep exact counters, bounded detached previews and reloadable private artifacts", async t => {
  const f = fixture(t);
  const source = patch("Документы/Пример.xbsl", `-${"раньше".repeat(18000)}\n+${"после".repeat(22000)}\n`);
  const [file] = f.store.capture(source, "turn-a");
  assert.equal(file.additions, 1); assert.equal(file.deletions, 1);
  assert.equal(file.truncated, true); assert(file.diff.length <= 2048);
  assert(JSON.stringify(file).length < 3000);
  await f.store.flush();
  const second = new DiffPatchStore(() => f.root, logger);
  const opened = await second.read(file);
  assert.equal(opened.text, source); assert.equal(opened.truncated, false);
  const filename = path.join(f.root, "patches", `${file.patchArtifact.id}.patch`);
  if (process.platform !== "win32") assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  fs.writeFileSync(filename, "tampered");
  assert.equal(await second.read(file), undefined);
  second.dispose();
});

test("patch recordings are never resolved across users, directories or forged byte ranges", async t => {
  const f = fixture(t); const [file] = f.store.capture(patch(), "turn-a"); await f.store.flush();
  for (const ref of [{ ...file.patchArtifact, id: "../secret" }, { ...file.patchArtifact, start: -1 }, { ...file.patchArtifact, length: MAX_PATCH_BYTES + 1 }]) {
    assert.equal(await f.store.read({ ...file, patchArtifact: ref }), undefined);
  }
  f.switchRoot(path.join(f.temp, "user-b", "project-a"));
  assert.equal(await f.store.read(file), undefined);
});

test("symlinked patch cache fails closed while previews and the runtime remain usable", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t); const outside = path.join(f.temp, "outside");
  fs.mkdirSync(outside); fs.mkdirSync(f.root, { recursive: true });
  fs.symlinkSync(outside, path.join(f.root, "patches"));
  const [file] = f.store.capture(patch(), "turn-a");
  assert.match(file.diff, /after/); await f.store.flush();
  assert.equal(f.store.getMetrics().failures, 1);
  assert.equal(fs.readdirSync(outside).length, 0);
  assert.equal(await f.store.read(file), undefined);
});

test("burst updates coalesce writes without retaining an unbounded patch queue", async t => {
  const f = fixture(t); let latest;
  for (let index = 0; index < 100; index++) {
    [latest] = f.store.capture(patch("file", `+${index}:${"x".repeat(64000)}\n`), "same-turn");
    const metrics = f.store.getMetrics();
    assert(metrics.queuedPatches <= 4); assert(metrics.queuedBytes <= 16 * 1024 * 1024);
  }
  await f.store.flush();
  assert(f.store.getMetrics().coalesced >= 98);
  assert(f.store.getMetrics().written <= 2);
  assert.match((await f.store.read(latest)).text, /\+99:/);
});

test("parser budgets total previews, line length, file metadata and handles added/deleted hunks", () => {
  const raw = Array.from({ length: 1600 }, (_, index) => patch(`path-${index}`, `+${"x".repeat(1800)}\n`)).join("");
  const files = summarizePatch(raw);
  assert(files.length <= 1025);
  assert.equal(files.reduce((sum, file) => sum + file.additions, 0), 1600);
  assert(files.reduce((sum, file) => sum + (file.diff?.length || 0), 0) <= 128 * 1024);
  assert.match(files.at(-1).path, /limit/);
  assert.throws(() => summarizePatch("x".repeat(MAX_PATCH_BYTES + 1)), /8 MiB/);
  const list = summarizePatch(patchFromChanges({ changes: [{ path: "a b.xbsl", status: "added", diff: "@@ -0 +1 @@\n+text" }, { path: "old", status: "deleted", diff: "@@ -1 +0 @@\n-text" }] }));
  assert.equal(list[0].path, "a b.xbsl"); assert.equal(list[0].status, "added");
  assert.equal(list[1].status, "deleted"); assert.equal(list[1].deletions, 1);
});

function panelFixture(t, postMessage) {
  const data = { kind: "chat", version: 1, chat: { id: "a", updatedAt: "" }, transcriptWindow: { offset: 0, totalCount: 1, items: [{ kind: "message", id: "one", text: "A", role: "assistant", status: "streaming" }] } };
  const panel = { visible: true, webview: { postMessage } };
  const manager = new ChatPanelManager({}, { getActiveChatSnapshot: () => data, getActiveChatId: () => "a" }, logger, {});
  Object.assign(manager, { panel, ready: true, visible: true });
  t.after(() => { clearTimeout(manager.ackTimer); clearTimeout(manager.flushTimer); manager.ready = false; manager.panel = undefined; });
  return { data, panel, manager };
}

test("ACK timeout and repeated resyncs cannot overlap unresolved postMessage promises", { timeout: 8000 }, async t => {
  const calls = []; let release;
  const f = panelFixture(t, frame => { calls.push(frame); return calls.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true); });
  f.manager.dirty = true; const first = f.manager.flushSnapshot();
  await sleep(3200);
  assert.equal(f.manager.getMetrics().ackTimeouts, 1);
  for (let i = 0; i < 100; i++) {
    f.data.transcriptWindow.items[0].text += ".";
    await f.manager.handleMessage(f.panel, { type: "chat.resync" });
    await f.manager.flushSnapshot();
  }
  assert.equal(calls.length, 1); assert.equal(f.manager.getMetrics().pendingPosts, 1);
  release(true); await first; await sleep(120);
  assert.equal(calls.length, 2); assert.equal(calls[1].kind, "snapshot");
  assert.equal(calls[1].rows[0].item.text.length, 101);
});

test("slow consumer receives no timeout replay; late ACK resumes a single accumulated delta", { timeout: 8000 }, async t => {
  const calls = [];
  const f = panelFixture(t, async frame => { calls.push(frame); return true; });
  f.manager.dirty = true; await f.manager.flushSnapshot();
  for (let i = 0; i < 5000; i++) { f.data.transcriptWindow.items[0].text += "."; f.manager.postAllSnapshots(); }
  await sleep(3200);
  assert.equal(calls.length, 1);
  await f.manager.handleMessage(f.panel, { type: "chat.ack", chatId: "a", epoch: calls[0].epoch, revision: 1, metrics: { eventLoopLagMs: Infinity, receiveMs: 15 } });
  await sleep(120);
  assert.equal(calls.length, 2); assert.equal(calls[1].appends[0].text.length, 5000);
  assert.equal(f.manager.getMetrics().frontendLagMs, 0); assert.equal(f.manager.getMetrics().frontendReceiveMs, 15);
  assert(f.manager.getMetrics().ackMaxMs >= 3000);
});

test("failed delivery pauses until an explicit readiness handshake rather than retry-flooding", async t => {
  let calls = 0;
  const f = panelFixture(t, async () => { calls++; return false; });
  f.manager.dirty = true; await f.manager.flushSnapshot();
  for (let i = 0; i < 100; i++) f.manager.postAllSnapshots();
  await sleep(120);
  assert.equal(calls, 1); assert.equal(f.manager.getMetrics().postFailures, 1);
  assert.equal(f.manager.getMetrics().pendingPosts, 0);
});

test("sidebar strips heavyweight chat data and deduplicates streaming timestamps until status changes", async t => {
  const frames = [];
  const chat = { id: "a", kind: "project", title: "Chat", status: "running", updatedAt: "first", hasUnread: false,
    queuedMessages: [{ prompt: "secret queued body", attachments: [{ bytes: "large data" }] }], pendingApproval: { diff: "+huge" } };
  const raw = { kind: "sidebar", version: 1, chats: [chat], auth: {}, proxy: {}, activeChatId: "a", rateLimits: {} };
  const view = { visible: true, webview: { postMessage: async frame => { frames.push(frame); return true; } } };
  const sidebar = new SidebarProvider({}, { getSidebarSnapshot: () => raw }, logger, {});
  Object.assign(sidebar, { view, ready: true, dirty: true });
  t.after(() => { clearTimeout(sidebar.timer); sidebar.ready = false; sidebar.view = undefined; });
  await sidebar.flushSnapshot();
  assert.equal(frames.length, 1); assert(!JSON.stringify(frames[0]).includes("secret"));
  assert(!JSON.stringify(frames[0]).includes("+huge"));
  for (let i = 0; i < 2000; i++) { raw.version++; chat.updatedAt = String(i); sidebar.postSnapshot(); }
  await sleep(150); assert.equal(frames.length, 1, "no send before ACK");
  sidebar.waitingAck = 0; await sidebar.flushSnapshot();
  assert.equal(frames.length, 1, "updatedAt is irrelevant while spinner shown");
  chat.status = "idle"; sidebar.dirty = true; await sidebar.flushSnapshot();
  assert.equal(frames.length, 2); assert.equal(frames[1].snapshot.chats[0].updatedAt, "1999");
  sidebar.waitingAck = 0; sidebar.lastSnapshot = ""; sidebar.dirty = true; view.visible = false;
  await sidebar.flushSnapshot(); assert.equal(frames.length, 2, "hidden sidebar stops snapshots");
});

test("patch read that outlives an IDE identity switch cannot fall back to the previous user's preview", async t => {
  const f = fixture(t); const [file] = f.store.capture(patch(), "turn");
  const read = f.store.read(file);
  f.switchRoot(path.join(f.temp, "other-user"));
  await assert.rejects(read, /IDE user or project changed/);
});

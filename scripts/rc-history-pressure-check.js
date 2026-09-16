"use strict";

// Source-only pressure/regression checks; never reads or writes compiled artifacts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");
const originalLoad = Module._load, originalTs = Module._extensions[".ts"];
const workspace = { workspaceFolders: [{ uri: { fsPath: "/pressure/workspace-a" } }] };
Module._load = function(id, ...args) { return id === "vscode" ? { workspace } : originalLoad.call(this, id, ...args); };
Module._extensions[".ts"] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, filename);
const { ChatHistoryService, normalizeHistory } = require("../src/chatHistoryService.ts");
const { ProjectHistoryStore } = require("../src/projectHistoryStore.ts");
const { identityFromConsole } = require("../src/elementIdentityService.ts");
const { StateStore } = require("../src/stateStore.ts");
const identity = identityFromConsole("https://pressure.invalid", "deployment", {
  id: "user", "user-list-id": "realm", login: "user", "is-active": true
}, { id: "deployment", name: "Project", "space-id": "space", deleted: false });
const logger = { info() {}, error() {} };
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; return { promise: new Promise(resolve => { release = resolve; }), release }; }
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, "Fixture boundary timed out"); await tick(); }
}
function history(chatCount = 1, itemCount = 1, textBytes = 16) {
  const chats = [], transcripts = {};
  for (let chat = 0; chat < chatCount; chat++) {
    const id = `chat-${chat}`;
    chats.push({ id, kind: "project", title: id, createdAt: "2026-09-08", updatedAt: "2026-09-08" });
    transcripts[id] = Array.from({ length: itemCount }, (_, item) => ({
      id: `item-${item}`, kind: "message", role: "assistant", text: "x".repeat(textBytes), createdAt: "2026-09-08", status: "complete"
    }));
  }
  return normalizeHistory({ version: 1, activeChatId: chats[0]?.id, chats, transcripts });
}
async function fixture(operation, options) {
  const root = fs.mkdtempSync(path.join(__dirname, ".history-pressure-"));
  let current = identity;
  workspace.workspaceFolders[0].uri.fsPath = "/pressure/workspace-a";
  const errors = [];
  const service = new ChatHistoryService({ globalStorageUri: { fsPath: root } }, root, logger, () => current, error => errors.push(error), options);
  const store = new ProjectHistoryStore(root, normalizeHistory);
  try {
    await service.load(identity.userKey);
    await operation({ root, service, store, errors, select: value => { current = value; }, file: store.file(identity) });
  } finally {
    await service.flush().catch(() => undefined);
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function heldWrite(file, operation, fail = false) {
  const held = gate(), rename = fs.promises.rename;
  const revisions = [];
  let reached = false;
  fs.promises.rename = async (from, to) => {
    if (to === file) {
      revisions.push(JSON.parse(fs.readFileSync(from, "utf8")));
      if (!reached) { reached = true; await held.promise; }
      if (fail) { throw new Error("fixture persistence failure"); }
    }
    return rename(from, to);
  };
  try { await operation({ release: held.release, reached: () => until(() => reached), revisions }); }
  finally { held.release(); fs.promises.rename = rename; }
}

let passed = 0;
async function test(name, operation) {
  let timer;
  try {
    await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 10000); })]);
    console.log(`ok ${++passed}: ${name}`);
  } finally { clearTimeout(timer); }
}

function dispatchCallback(service, value) {
  const filename = path.join(__dirname, "../src/extension.ts");
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  let callback;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "beforeQueuedDispatch") callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, "Cannot find the actual extension dispatch barrier");
  const code = ts.transpileModule(`return ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function("ensureHistoryLoaded", "historyProfileId", "history", "state", code)(async () => {}, identity.userKey, service, { exportChatHistory: () => value });
}

function putImport(file, imported) {
  const directory = path.join(path.dirname(file), "imports");
  fs.mkdirSync(directory, { recursive: true });
  const { userKey, projectKey, server, projectName, spaceId, userId, userListId } = identity;
  fs.writeFileSync(path.join(directory, "owned.json"), JSON.stringify({ schema: "codex-element-history-export-v1",
    scope: { userKey, projectKey, server, projectName, spaceId }, owner: { userId, userListId }, history: imported }));
}

async function regressions() {
  await test("real StateStore item/turn completion mutations persist their latest complete view", () => fixture(async ({ service, file }) => {
    const requests = [];
    const state = new StateStore(mode => {
      if (mode === "immediate") requests.push(service.saveNow(identity.userKey, state.exportChatHistory()));
      else service.scheduleSave(identity.userKey, state.exportChatHistory());
    });
    state.replaceChatHistory(history(12, 8, 512));
    for (let turn = 0; turn < 60; turn++) {
      const chatId = `chat-${turn % 12}`, turnId = `turn-${turn}`;
      state.setLastAssistantText(chatId, `Completed response ${turn}`, turnId);
      state.addOrUpdateActivityItem(chatId, { id: `command-${turn}`, activityKind: "command", label: "Command completed",
        status: "completed", turnId, outputPreview: `Result ${turn}` }, "immediate");
      state.addOrUpdateActivityItem(chatId, { id: `turn-item-${turn}`, activityKind: "turn", label: "Turn completed",
        status: "completed", turnId }, "immediate");
    }
    const expected = copy(normalizeHistory(state.exportChatHistory()));
    await Promise.all(requests); await service.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).history, expected);
    assert.equal(requests.length, 180);
    assert.ok(service.getMetrics().coalescedSaves >= 178);
    assert.ok(service.getMetrics().queueMax <= 2);
    assert.equal(expected.transcripts["chat-11"].find(item => item.kind === "turn-run" && item.turnId === "turn-59").status, "completed");
  }));

  await test("active write plus one replaceable batch; detached mutable snapshots and shared durable promises", () => fixture(async ({ service, file }) => {
    const value = history();
    value.transcripts["chat-0"][0].text = "active";
    await heldWrite(file, async ({ reached, release, revisions }) => {
      let firstDone = false, batchDone = false;
      const first = service.saveNow(identity.userKey, value).then(() => { firstDone = true; });
      await reached();
      let completion;
      for (let index = 0; index < 200; index++) {
        value.transcripts["chat-0"][0].text = `latest-${index}`;
        const saving = service.saveNow(identity.userKey, value);
        if (completion) assert.equal(saving, completion, "Coalesced requests should share one completion, not retain per-request snapshots");
        completion = saving;
      }
      completion.then(() => { batchDone = true; });
      value.transcripts["chat-0"][0].text = "unsubmitted mutation";
      value.transcripts["chat-0"].push({ id: "unsubmitted", kind: "message", role: "user", text: "not captured", createdAt: "2026-09-08" });
      assert.equal(service.getMetrics().queueCurrent, 2);
      assert.equal(service.getMetrics().coalescedSaves, 199);
      assert.equal(firstDone || batchDone, false);
      release(); await Promise.all([first, completion]);
      assert.deepEqual(revisions.map(item => item.history.transcripts["chat-0"][0].text), ["active", "latest-199"]);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"].length, 1);
      assert.equal(service.getMetrics().queueCurrent, 0);
      const metrics = service.getMetrics(); metrics.store.writtenBytes = -1;
      assert.ok(service.getMetrics().store.writtenBytes > 0, "Metrics must be detached copies");
    });
  }));

  await test("flush seals its batch without waiting for or absorbing later saves", () => fixture(async ({ service, file }) => {
    const value = history();
    await heldWrite(file, async ({ reached, release, revisions }) => {
      value.transcripts["chat-0"][0].text = "first";
      const first = service.saveNow(identity.userKey, value); await reached();
      value.transcripts["chat-0"][0].text = "barrier";
      const second = service.saveNow(identity.userKey, value);
      const flushed = service.flush().then(() => {
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "barrier");
      });
      value.transcripts["chat-0"][0].text = "later";
      const third = service.saveNow(identity.userKey, value);
      assert.notEqual(second, third);
      release(); await Promise.all([first, second, flushed, third]);
      assert.deepEqual(revisions.map(item => item.history.transcripts["chat-0"][0].text), ["first", "barrier", "later"]);
    });
  }));

  await test("hard queue cap rejects overflow without losing accepted or debounced saves", () => fixture(async ({ service, file }) => {
    const value = history();
    await heldWrite(file, async ({ reached, release, revisions }) => {
      const first = service.saveNow(identity.userKey, value); await reached();
      value.transcripts["chat-0"][0].text = "second";
      const second = service.saveNow(identity.userKey, value), secondBarrier = service.flush();
      value.transcripts["chat-0"][0].text = "third";
      const third = service.saveNow(identity.userKey, value), thirdBarrier = service.flush();
      value.transcripts["chat-0"][0].text = "rejected";
      await assert.rejects(service.saveNow(identity.userKey, value), /queue is full/);
      value.transcripts["chat-0"][0].text = "debounced";
      service.scheduleSave(identity.userKey, value);
      await assert.rejects(service.flush(), /queue is full/);
      assert.equal(service.getMetrics().queueCurrent, 3);
      assert.equal(service.getMetrics().scheduledSavePending, true);
      release(); await Promise.all([first, second, third, secondBarrier, thirdBarrier]);
      await service.flush();
      assert.deepEqual(revisions.map(item => item.history.transcripts["chat-0"][0].text), ["x".repeat(16), "second", "third", "debounced"]);
      assert.equal(service.getMetrics().queueMax, 3);
      assert.equal(service.getMetrics().scheduledSavePending, false);
    });
  }, { maxQueuedOperations: 3 }));

  await test("all coalesced awaiters and queued flush/load reject failed writes; idle reload recovers", () => fixture(async ({ service, file }) => {
    const value = history(); await service.saveNow(identity.userKey, value);
    const original = fs.readFileSync(file);
    await heldWrite(file, async ({ reached, release }) => {
      value.transcripts["chat-0"][0].text = "first failure";
      const first = assert.rejects(service.saveNow(identity.userKey, value), /fixture persistence failure/);
      await reached();
      const failures = [];
      for (let index = 0; index < 30; index++) {
        value.transcripts["chat-0"][0].text = `failure-${index}`;
        failures.push(assert.rejects(service.saveNow(identity.userKey, value), /fixture persistence failure/));
      }
      failures.push(assert.rejects(service.flush(), /fixture persistence failure/));
      failures.push(assert.rejects(service.load(identity.userKey), /fixture persistence failure/));
      release(); await Promise.all([first, ...failures]);
      assert.deepEqual(fs.readFileSync(file), original);
      assert.equal(service.getMetrics().store.persistedBytes, original.length, "A failed replacement must not report attempted bytes as persisted");
      assert.equal(service.getMetrics().saveFailures, 2);
      assert.equal(service.getMetrics().queueCurrent, 0);
    }, true);
    await service.load(identity.userKey);
    value.transcripts["chat-0"][0].text = "recovered";
    await service.saveNow(identity.userKey, value);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "recovered");
  }));

  for (const fail of [false, true]) {
    await test(`actual beforeQueuedDispatch callback ${fail ? "rejects failure and prevents dispatch" : "waits for a durable queued-message record"}`, () => fixture(async ({ service, file }) => {
      const value = history();
      value.chats[0].queuedMessages = [{ id: "queued", text: "send", mode: "normal", skills: [], attachments: [],
        dispatchState: "dispatching", dispatchAttempt: 1, transcriptMessageId: "user-message", createdAt: "2026-09-08" }];
      const before = dispatchCallback(service, value);
      await heldWrite(file, async ({ reached, release }) => {
        let dispatched = false;
        const dispatch = before().then(() => {
          dispatched = true;
          const queued = JSON.parse(fs.readFileSync(file, "utf8")).history.chats[0].queuedMessages[0];
          assert.equal(queued.id, "queued");
          assert.equal(queued.dispatchState, "failed", "Interrupted dispatch is durable and cannot auto-replay");
          assert.equal(queued.transcriptMessageId, "user-message");
        });
        const observed = fail ? assert.rejects(dispatch, /fixture persistence failure/) : dispatch;
        await reached(); assert.equal(dispatched, false);
        release(); await observed;
        assert.equal(dispatched, !fail);
      }, fail);
    }));
  }

  await test("a dispatch barrier coalesced behind an active write waits for the superseding durable snapshot", () => fixture(async ({ service, file }) => {
    const value = history();
    await heldWrite(file, async ({ reached, release, revisions }) => {
      const active = service.saveNow(identity.userKey, value); await reached();
      value.chats[0].queuedMessages = [{ id: "queued", text: "send", mode: "normal", skills: [], attachments: [],
        dispatchState: "dispatching", dispatchAttempt: 1, createdAt: "2026-09-08" }];
      let dispatched = false;
      const dispatch = dispatchCallback(service, value)().then(() => {
        const disk = JSON.parse(fs.readFileSync(file, "utf8")).history;
        assert.equal(disk.chats[0].queuedMessages[0].id, "queued");
        assert.equal(disk.transcripts["chat-0"][0].text, "completed-29");
        dispatched = true;
      });
      await until(() => service.getMetrics().queueCurrent === 2);
      const writes = [];
      for (let index = 0; index < 30; index++) {
        value.transcripts["chat-0"][0].text = `completed-${index}`;
        writes.push(service.saveNow(identity.userKey, value));
      }
      assert.equal(dispatched, false);
      assert.equal(service.getMetrics().coalescedSaves, 30);
      release(); await Promise.all([active, dispatch, ...writes]);
      assert.equal(dispatched, true);
      assert.equal(revisions.length, 2);
    });
  }));

  await test("debounced saves have a fixed deadline, immediate saves supersede them, dispose drains pending state", () => fixture(async ({ service, file, errors }) => {
    const value = history();
    for (let index = 0; index < 12; index++) {
      value.transcripts["chat-0"][0].text = `stream-${index}`;
      service.scheduleSave(identity.userKey, value);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(file), "Continuous mutation starved the fixed save deadline");
    value.transcripts["chat-0"][0].text = "immediate";
    await service.saveNow(identity.userKey, value);
    const writes = service.getMetrics().store.historyWrites;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(service.getMetrics().store.historyWrites, writes, "Stale debounce timer rewrote older state");
    value.transcripts["chat-0"][0].text = "disposed";
    service.scheduleSave(identity.userKey, value); service.dispose(); await service.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "disposed");
    assert.deepEqual(errors, []);
  }, { saveDelayMs: 20 }));

  await test("malformed immediate requests cannot discard a valid pending debounce snapshot", () => fixture(async ({ service, file }) => {
    const pending = history(); pending.transcripts["chat-0"][0].text = "must survive rejection";
    service.scheduleSave(identity.userKey, pending);
    const malformed = history(); malformed.transcripts["chat-0"][0].text = null;
    await assert.rejects(service.saveNow(identity.userKey, malformed));
    assert.equal(service.getMetrics().scheduledSavePending, true);
    await service.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "must survive rejection");
  }));

  await test("timer-driven save errors reach the error callback and subsequent flush", () => fixture(async ({ service, file, errors }) => {
    await heldWrite(file, async ({ reached, release }) => {
      service.scheduleSave(identity.userKey, history());
      await reached(); release();
      await until(() => errors.length === 1);
      assert.match(errors[0], /fixture persistence failure/);
      await assert.rejects(service.flush(), /fixture persistence failure/);
    }, true);
  }, { saveDelayMs: 1 }));

  await test("user/project/workspace transitions never share a batch or relabel old cleanup writes", async () => {
    const variants = [
      { ...identity, userKey: "other-user", userId: "other-user" },
      { ...identity, projectKey: "other-project", projectName: "Other project" },
      { ...identity }
    ];
    for (const target of variants) await fixture(async ({ service, file, select, store }) => {
      const value = history();
      await heldWrite(file, async ({ reached, release, revisions }) => {
        value.transcripts["chat-0"][0].text = "old scope";
        const first = service.saveNow(identity.userKey, value); await reached();
        select(target); workspace.workspaceFolders[0].uri.fsPath = "/pressure/workspace-b";
        value.transcripts["chat-0"][0].text = "old cleanup";
        const cleanup = service.saveNow(identity.userKey, value);
        const loading = service.load(target.userKey);
        await assert.rejects(service.saveNow(identity.userKey, value), /запрещена/);
        release(); await Promise.all([first, cleanup, loading]);
        assert.deepEqual(revisions.map(revision => revision.workspacePath), ["/pressure/workspace-a", "/pressure/workspace-a"]);
        assert.ok(revisions.every(revision => revision.scope.userKey === identity.userKey && revision.scope.projectKey === identity.projectKey));
      });
      const next = history(); next.transcripts["chat-0"][0].text = "new scope";
      await service.saveNow(target.userKey, next);
      const persisted = JSON.parse(fs.readFileSync(store.file(target), "utf8"));
      assert.equal(persisted.workspacePath, "/pressure/workspace-b");
      assert.equal(persisted.scope.userKey, target.userKey);
      assert.equal(persisted.scope.projectKey, target.projectKey);
      if (store.file(target) !== file) assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "old cleanup");
    });
  });

  await test("import is a sealed boundary; a coalesced pre-import view cannot delete imported chats", () => fixture(async ({ service, file }) => {
    const value = history(); await service.saveNow(identity.userKey, value);
    const imported = history(); imported.chats[0].id = "imported"; imported.activeChatId = "imported";
    imported.transcripts = { imported: imported.transcripts["chat-0"] };
    putImport(file, imported);
    const [candidate] = await service.listLegacy(); assert.ok(candidate);
    await heldWrite(file, async ({ reached, release }) => {
      const importing = service.importLegacy(candidate.id, value); await reached();
      const writes = [];
      for (let index = 0; index < 75; index++) {
        value.transcripts["chat-0"][0].text = `during-import-${index}`;
        writes.push(service.saveNow(identity.userKey, value));
      }
      release(); await Promise.all([importing, ...writes]); await service.flush();
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(result.history.chats.map(chat => chat.id).sort(), ["chat-0", "imported"]);
      assert.equal(result.history.transcripts["chat-0"][0].text, "during-import-74");
      assert.ok(result.imports.includes(candidate.id));
      assert.equal(service.getMetrics().coalescedSaves, 74);
    });
    assert.deepEqual(await service.listLegacy(), []);
  }));

  await test("unchanged saves skip writes, still read under lock, and cache only exact verified raw revisions", () => fixture(async ({ service, file }) => {
    const value = history(3); await service.saveNow(identity.userKey, value);
    const before = fs.readFileSync(file), metrics = service.getMetrics();
    for (let index = 0; index < 20; index++) await service.saveNow(identity.userKey, value);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(`${file}.bak`), false);
    const current = service.getMetrics();
    assert.equal(current.store.skippedWrites - metrics.store.skippedWrites, 20);
    assert.equal(current.store.readCacheHits - metrics.store.readCacheHits, 20);
    assert.equal(current.store.serializations - metrics.store.serializations, 60, "Each chat is serialized once, not entire histories repeatedly");
    const stat = fs.statSync(file);
    const remote = JSON.parse(before); remote.history.transcripts["chat-1"][0].text = "y".repeat(16);
    const raw = JSON.stringify(remote) + "\n";
    assert.equal(Buffer.byteLength(raw), before.length);
    fs.writeFileSync(file, raw); fs.utimesSync(file, stat.atime, stat.mtime);
    await service.saveNow(identity.userKey, value);
    assert.equal(fs.readFileSync(file, "utf8"), raw, "Unseen remote-only change should not be rewritten");
    value.transcripts["chat-0"][0].text = "local";
    await service.saveNow(identity.userKey, value);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-1"][0].text, "y".repeat(16));
    assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), raw);
  }));

  await test("persistedBytes is the confirmed main file size, including UTF8/newlines, never cumulative or backup bytes", () => fixture(async ({ service, file, select }) => {
    assert.equal(service.getMetrics().store.persistedBytes, 0);
    const value = history(); value.transcripts["chat-0"][0].text = "\u0442\u0435\u0441\u0442 \ud83d\ude00";
    await service.saveNow(identity.userKey, value);
    const firstSize = fs.statSync(file).size;
    assert.equal(service.getMetrics().store.persistedBytes, firstSize);
    assert.ok(firstSize > fs.readFileSync(file, "utf8").length);
    value.transcripts["chat-0"][0].text += " longer value";
    await service.saveNow(identity.userKey, value);
    const secondSize = fs.statSync(file).size;
    assert.equal(service.getMetrics().store.persistedBytes, secondSize);
    assert.equal(service.getMetrics().store.writtenBytes, 2 * firstSize + secondSize);
    await service.listLegacy();
    assert.equal(service.getMetrics().store.persistedBytes, secondSize, "Import target metadata must not change the main file gauge");
    const raw = "\n " + JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")), null, 2) + "\n\n";
    fs.writeFileSync(file, raw);
    const loaded = await service.load(identity.userKey);
    assert.equal(service.getMetrics().store.persistedBytes, Buffer.byteLength(raw));
    await service.saveNow(identity.userKey, loaded);
    assert.equal(service.getMetrics().store.persistedBytes, Buffer.byteLength(raw), "No-op cache hit must retain the exact raw file size");
    const cumulative = service.getMetrics().store.writtenBytes;
    select({ ...identity, projectKey: "missing-project", projectName: "Missing project" });
    assert.equal(await service.load(identity.userKey), undefined);
    assert.equal(service.getMetrics().store.persistedBytes, 0);
    assert.equal(service.getMetrics().store.writtenBytes, cumulative, "Loading an absent scope must not reset cumulative counters");
  }));

  await test("coalescing retains independent remote edits and rejects conflicting same-chat edits", () => fixture(async ({ service, store, file }) => {
    const local = history(2); await service.saveNow(identity.userKey, local);
    const remote = await store.load(identity, "/pressure/workspace-a");
    remote.transcripts["chat-1"][0].text = "remote independent";
    await store.save(identity, "/pressure/workspace-a", remote);
    const saving = [];
    for (let index = 0; index < 50; index++) {
      local.transcripts["chat-0"][0].text = `local-${index}`;
      saving.push(service.saveNow(identity.userKey, local));
    }
    await Promise.all(saving);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-1"][0].text, "remote independent");
    const conflicting = await store.load(identity, "/pressure/workspace-a");
    conflicting.transcripts["chat-0"][0].text = "remote conflicting";
    await store.save(identity, "/pressure/workspace-a", conflicting);
    const failures = [];
    for (let index = 0; index < 50; index++) {
      local.transcripts["chat-0"][0].text = `conflicting-${index}`;
      failures.push(assert.rejects(service.saveNow(identity.userKey, local), /другой IDE/));
    }
    await Promise.all(failures);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][0].text, "remote conflicting");
    const conflicts = fs.readdirSync(path.dirname(file)).filter(name => name.includes(".conflict-"));
    assert.equal(conflicts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), conflicts[0]), "utf8")).history.transcripts["chat-0"][0].text, "conflicting-49");
  }));

  await test("cache cannot conceal schema, foreign-scope, malformed-message or invalid-UTF8 corruption", async () => {
    for (const corrupt of [
      raw => raw.replace('"schema":2', '"schema":9'),
      raw => raw.replace(identity.userKey, "f".repeat(identity.userKey.length)),
      raw => raw.replace('"text":"xxxxxxxxxxxxxxxx"', '"text":null'),
      raw => Buffer.concat([Buffer.from(raw.slice(0, raw.indexOf("xxxxxxxxxxxxxxxx"))), Buffer.from([0xff]), Buffer.from(raw.slice(raw.indexOf("xxxxxxxxxxxxxxxx") + 1))])
    ]) await fixture(async ({ service, file }) => {
      const value = history(); await service.saveNow(identity.userKey, value);
      const damaged = Buffer.from(corrupt(fs.readFileSync(file, "utf8")));
      fs.writeFileSync(file, damaged);
      await assert.rejects(service.saveNow(identity.userKey, value));
      assert.deepEqual(fs.readFileSync(file), damaged);
      assert.equal(fs.existsSync(`${file}.bak`), false);
      await assert.rejects(service.load(identity.userKey));
    });
  });

  await test("a missing loaded history is not recreated by the no-op path", () => fixture(async ({ service, file }) => {
    const value = history(); await service.saveNow(identity.userKey, value);
    fs.unlinkSync(file);
    await assert.rejects(service.saveNow(identity.userKey, value));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.bak`), false);
  }));

  await test("verified write cache cannot admit an unsafe revision that subsequent load would reject", () => fixture(async ({ service, file }) => {
    const value = history(); await service.saveNow(identity.userKey, value);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8")); envelope.revision = Number.MAX_SAFE_INTEGER;
    const raw = JSON.stringify(envelope); fs.writeFileSync(file, raw);
    const loaded = await service.load(identity.userKey);
    await service.saveNow(identity.userKey, loaded);
    loaded.transcripts["chat-0"][0].text = "cannot increment revision";
    await assert.rejects(service.saveNow(identity.userKey, loaded), /ограничение числа версий истории/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    assert.equal(fs.existsSync(`${file}.bak`), false);
  }));

  await test("raw backup is byte-exact, including unknown fields and whitespace; no eager disk normalization", () => fixture(async ({ service, file }) => {
    const value = history(); await service.saveNow(identity.userKey, value);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.history.transcripts["chat-0"][0].unknownRecovery = "retain original bytes";
    const raw = "\n  " + JSON.stringify(envelope, null, 2) + "\n\n";
    fs.writeFileSync(file, raw);
    const loaded = await service.load(identity.userKey);
    await service.saveNow(identity.userKey, loaded);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
    loaded.transcripts["chat-0"][0].text = "edited";
    await service.saveNow(identity.userKey, loaded);
    assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), raw);
  }));

  await test("opaque patch references survive bounded normalization, all file counts and overflow summaries survive", () => fixture(async ({ service, file }) => {
    const max = 8 * 1024 * 1024;
    const ref = { id: "a".repeat(64), scope: "b".repeat(64), start: 0, length: max };
    const value = history();
    const files = Array.from({ length: 1025 }, (_, index) => ({ path: `file-${index}`, additions: index + 1, deletions: index + 2,
      diff: index === 0 ? "d".repeat(4096) : "preview", patchArtifact: ref }));
    files.push({ path: "[overflow]", additions: 9000, deletions: 8000, truncated: true });
    value.transcripts["chat-0"].push({ id: "diff", kind: "diff", title: "Changes", files, createdAt: "2026-09-08" });
    const normalized = normalizeHistory(value).transcripts["chat-0"][1];
    assert.equal(normalized.files.length, 1026);
    assert.equal(normalized.files[0].diff.length, 2048);
    assert.equal(normalized.files[0].truncated, true);
    assert.equal(normalized.additions, files.reduce((sum, entry) => sum + entry.additions, 0));
    assert.equal(normalized.deletions, files.reduce((sum, entry) => sum + entry.deletions, 0));
    assert.deepEqual(normalized.files[0].patchArtifact, ref);
    assert.deepEqual(normalized.files.at(-1), { path: "[overflow]", oldPath: undefined, newPath: undefined, status: undefined,
      additions: 9000, deletions: 8000, diff: undefined, truncated: true, patchArtifact: undefined });
    const invalid = [null, {}, { ...ref, id: "A".repeat(64) }, { ...ref, scope: "b".repeat(63) }, { ...ref, id: "../file" },
      { ...ref, start: -1 }, { ...ref, start: 0.5 }, { ...ref, start: Number.MAX_SAFE_INTEGER + 1 }, { ...ref, start: max + 1 },
      { ...ref, length: -1 }, { ...ref, length: NaN }, { ...ref, length: Infinity }, { ...ref, length: 0.5 }, { ...ref, length: max + 1 }, { ...ref, start: 1 }];
    for (const candidate of invalid) {
      files[0].patchArtifact = candidate;
      assert.equal(normalizeHistory(value).transcripts["chat-0"][1].files[0].patchArtifact, undefined);
    }
    for (const candidate of [ref, { ...ref, start: max, length: 0 }, { ...ref, start: 1, length: max - 1 }]) {
      files[0].patchArtifact = candidate;
      assert.deepEqual(normalizeHistory(value).transcripts["chat-0"][1].files[0].patchArtifact, candidate);
    }
    files[0].patchArtifact = ref;
    await service.saveNow(identity.userKey, value);
    const loaded = await service.load(identity.userKey);
    assert.deepEqual(loaded.transcripts["chat-0"][1].files[0].patchArtifact, ref);
    assert.equal(loaded.transcripts["chat-0"][1].files.length, 1026);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).history.transcripts["chat-0"][1].files[0].diff.length, 2048);
  }));
}

async function benchmark() {
  // --baseline runs the same workload before source edits, without optimization assertions.
  await fixture(async ({ service, file }) => {
    const value = history(24, 40, 768);
    const historyBytes = Buffer.byteLength(JSON.stringify(value));
    await service.saveNow(identity.userKey, value);
    const stringify = JSON.stringify, rename = fs.promises.rename;
    let serializations = 0, serializedBytes = 0, serializationMs = 0, writes = 0;
    let maxEventLoopDelayMs = 0, previous = performance.now();
    const pulse = setInterval(() => { const now = performance.now(); maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - previous - 2); previous = now; }, 2);
    JSON.stringify = function(...args) {
      const start = performance.now();
      const result = stringify.apply(this, args);
      serializationMs += performance.now() - start;
      serializations++;
      serializedBytes += result === undefined ? 0 : Buffer.byteLength(result);
      return result;
    };
    fs.promises.rename = async (from, to) => { if (to === file || to === `${file}.bak`) writes++; return rename(from, to); };
    const start = performance.now();
    let submissionMs;
    try {
      const requests = [];
      for (let mutation = 0; mutation < 120; mutation++) {
        value.transcripts[`chat-${mutation % 24}`][0].text = `completed-${mutation}`;
        requests.push(service.saveNow(identity.userKey, value));
      }
      submissionMs = performance.now() - start;
      await Promise.all(requests);
      await service.flush();
      await new Promise(resolve => setTimeout(resolve, 5));
      const disk = JSON.parse(fs.readFileSync(file, "utf8")).history;
      assert.deepEqual(disk, copy(value));
      if (!process.argv.includes("--baseline")) {
        assert.ok(writes <= 4, `120 adjacent saves caused ${writes} file replacements`);
        assert.ok(service.getMetrics().coalescedSaves >= 118);
        assert.ok(service.getMetrics().queueMax <= 2);
      }
    } finally { JSON.stringify = stringify; fs.promises.rename = rename; clearInterval(pulse); }
    console.log(JSON.stringify({ benchmark: "120 completions / 24 chats / 960 items", historyBytes, submissionMs,
      elapsedMs: performance.now() - start, serializations, serializedBytes, serializationMs, writes, maxEventLoopDelayMs,
      metrics: service.getMetrics?.() }));
  });
}

async function residualBenchmark() {
  await fixture(async ({ service }) => {
    const value = history(48, 128, 2048);
    const historyBytes = Buffer.byteLength(JSON.stringify(value));
    await service.saveNow(identity.userKey, value);
    value.transcripts["chat-0"][0].text += " changed";
    const before = service.getMetrics();
    let previous = performance.now(), maxEventLoopDelayMs = 0;
    const pulse = setInterval(() => { const now = performance.now(); maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - previous - 2); previous = now; }, 2);
    const started = performance.now();
    try {
      await service.saveNow(identity.userKey, value);
      await new Promise(resolve => setTimeout(resolve, 5));
      const after = service.getMetrics();
      console.log(JSON.stringify({ benchmark: "residual single large-history save (main-thread, no worker)", historyBytes,
        elapsedMs: performance.now() - started, maxEventLoopDelayMs, snapshotMs: after.snapshotMs - before.snapshotMs,
        serializedBytes: after.serializedBytes - before.serializedBytes, serializationMs: after.serializationMs - before.serializationMs,
        normalizationMs: after.store.normalizationMs - before.store.normalizationMs,
        readBytes: after.store.readBytes - before.store.readBytes, writtenBytes: after.store.writtenBytes - before.store.writtenBytes,
        readCacheHits: after.store.readCacheHits - before.store.readCacheHits }));
    } finally { clearInterval(pulse); }
  });
}

async function main() {
  if (!process.argv.includes("--baseline")) await regressions();
  await benchmark();
  if (!process.argv.includes("--baseline")) await residualBenchmark();
  if (!process.argv.includes("--baseline")) console.log(`rc-history-pressure-check: ${passed} passed; current TypeScript sources and extracted dispatch callback; fixtures removed.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs; else delete Module._extensions[".ts"];
});

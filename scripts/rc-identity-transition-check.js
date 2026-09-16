"use strict";

// Exercise the actual extension closures extracted by the TypeScript parser, not a copied implementation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/extension.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const declarations = new Map();
let featureRequest;
const wanted = new Set(["ensureHistoryLoaded", "invalidateIdentity", "historyProfileId", "historyScopeKey", "historyLoadPromise", "identityTransition", "identityEpoch", "lastHistoryError"]);
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text)) declarations.set(node.name.text, node);
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "featureRequest" && ts.isArrowFunction(node.initializer)) featureRequest = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of wanted) assert.ok(declarations.has(name), `Cannot locate live extension declaration: ${name}`);
assert.ok(featureRequest, "Cannot locate live extension featureRequest callback.");
const shared = ["historyProfileId", "historyScopeKey", "historyLoadPromise", "identityTransition", "identityEpoch", "lastHistoryError"];
const extracted = ts.transpileModule([
  ...shared.map(name => `let ${declarations.get(name).getText(ast)};`),
  `const ${declarations.get("ensureHistoryLoaded").getText(ast)};`,
  `const ${declarations.get("invalidateIdentity").getText(ast)};`,
  `const featureRequest = ${featureRequest.getText(ast)};`,
  "return { ensureHistoryLoaded, invalidateIdentity, featureRequest, transition: () => identityTransition, profile: () => historyProfileId, scope: () => historyScopeKey, epoch: () => identityEpoch, prime: (profile, scope) => { historyProfileId = profile; historyScopeKey = scope; } };"
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;

class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const workspace = { workspaceFolders: [{ uri: { fsPath: "/fixture/workspace" } }], onDidChangeConfiguration: () => ({ dispose() {} }) };
const vscode = { EventEmitter, workspace, window: { showWarningMessage: async (...args) => args[args.length - 1] } };
const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
Module._load = function(request, ...args) { return request === "vscode" ? vscode : originalLoad.call(this, request, ...args); };
Module._extensions[".ts"] = function(module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, filename);
};
const { ElementIdentityService, identityFromConsole } = require("../src/elementIdentityService.ts");
const { ProjectHistoryStore } = require("../src/projectHistoryStore.ts");
const { ChatHistoryService, normalizeHistory } = require("../src/chatHistoryService.ts");
const { StateStore } = require("../src/stateStore.ts");

const copy = value => JSON.parse(JSON.stringify(value));
function gate() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; }
function tick() { return new Promise(resolve => setImmediate(resolve)); }
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Identity fixture exceeded its deadline (possible deadlock).")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(condition) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail("Expected fixture boundary was not reached.");
}
const users = Object.fromEntries(["A", "B", "C"].map(name => [name, { id: `user-${name}`, "user-list-id": `realm-${name}`, login: name, presentation: name, "is-active": true }]));
// A token-authenticated Element user can have NEW status and is-active=false.
users.B["is-active"] = false;
const projects = Object.fromEntries(["A", "B", "C"].map(name => [name, { id: `project-${name}`, name: `Project ${name}`, "space-id": "space", deleted: false }]));
const identities = Object.fromEntries(["A", "B", "C"].map(name => [name, identityFromConsole("https://element.invalid", projects[name].id, users[name], projects[name])]));
function saved(name) { return { version: 1, activeChatId: `${name}-chat`, chats: [{ id: `${name}-chat`, kind: "project", title: `${name} saved chat`, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" }], transcripts: { [`${name}-chat`]: [{ id: `${name}-message`, kind: "message", role: "assistant", text: `${name} private history`, createdAt: "2026-09-08T00:00:00Z" }] } }; }

async function harness(realRoot) {
  let currentName = "A";
  let loadedIdentity;
  const stopGates = [];
  const loadGates = new Map();
  const loads = [], writes = [], publications = [], errors = [];
  const disk = new Map(Object.entries(identities).map(([name, identity]) => [identity.userKey, saved(name)]));
  const identity = new ElementIdentityService(() => ({ server: "https://element.invalid", clientId: `client-${currentName}`, clientSecret: `fixture-${currentName}`, projectId: projects[currentName].id }), async (url, method, headers) => {
    const name = method === "POST" ? Buffer.from(headers.Authorization.slice(6), "base64").toString().split(":")[0].slice(-1) : headers.Authorization.slice(-1);
    if (url.pathname.endsWith("/sys/token")) return { id_token: `fixture-token-${name}` };
    return url.pathname.endsWith("/me") ? users[name] : projects[name];
  });
  await identity.resolve();
  loadedIdentity = identity.getCurrent();
  const state = new StateStore();
  state.replaceChatHistory(saved("A"));
  for (const method of ["replaceChatHistory", "addImportedChatHistory"]) {
    const actual = state[method].bind(state);
    state[method] = value => { actual(value); publications.push(state.exportChatHistory().chats.map(chat => chat.id)); };
  }
  let history = {
    async flush() {},
    async load(profile) {
      const captured = identity.getCurrent();
      assert.equal(captured?.userKey, profile, "Load must use current authenticated user.");
      loads.push(profile);
      if (loadGates.has(profile)) { const waiting = loadGates.get(profile); loadGates.delete(profile); await waiting.promise; }
      loadedIdentity = captured;
      return copy(disk.get(profile));
    },
    async saveNow(profile, snapshot) {
      assert.equal(profile, loadedIdentity.userKey, "A stale transition attempted to save into a newly loaded identity.");
      const owner = Object.keys(identities).find(name => identities[name].userKey === profile);
      assert.ok(snapshot.chats.every(chat => chat.id.startsWith(`${owner}-`)), "Snapshot crossed user ownership.");
      writes.push({ profile, chats: snapshot.chats.map(chat => chat.id) });
      disk.set(profile, copy(snapshot));
    },
    getLoadedIdentity() { return loadedIdentity; }
  };
  if (realRoot) {
    for (const name of Object.keys(identities)) {
      const store = new ProjectHistoryStore(realRoot, normalizeHistory);
      await store.load(identities[name], workspace.workspaceFolders[0].uri.fsPath);
      await store.save(identities[name], workspace.workspaceFolders[0].uri.fsPath, normalizeHistory(saved(name)));
    }
    history = new ChatHistoryService({ globalStorageUri: { fsPath: realRoot } }, realRoot, { info() {}, error() {} }, () => identity.getCurrent(), message => errors.push(message));
    await history.load(identities.A.userKey);
  }
  let stops = 0;
  const runtime = { async stopForIdentityChange() { stops++; const waiting = stopGates.shift(); if (waiting) await waiting.promise; } };
  const dependencies = {
    state, history, identity, runtime, vscode,
    chatPanels: { closeIfActiveChat() {}, postAllSnapshots() {} },
    sidebar: { postSnapshot() {} }, logger: { info() {} }, rulesContext: {}, refreshRulesContext() {}, reportHistoryError: message => errors.push(message),
    profiles: { getCurrentProfileLabel: () => identity.getCurrent()?.userLabel }
  };
  const api = new Function(...Object.keys(dependencies), extracted)(...Object.values(dependencies));
  api.prime(identities.A.userKey, `${identities.A.userKey}/${identities.A.projectKey}/${workspace.workspaceFolders[0].uri.fsPath}`);
  identity.onDidInvalidate(api.invalidateIdentity);
  return {
    ...api, state, identity, history, loads, writes, publications, errors,
    get stops() { return stops; },
    select(name, invalidate = true) { currentName = name; if (invalidate) identity.invalidate(); },
    holdStop() { const waiting = gate(); stopGates.push(waiting); return waiting; },
    holdLoad(name) { const waiting = gate(); loadGates.set(identities[name].userKey, waiting); return waiting; },
    dispose() { history.dispose?.(); identity.dispose(); }
  };
}

function boundExport(identity, history) {
  const { userKey, projectKey, server, projectName, spaceId } = identity;
  return { schema: "codex-element-history-export-v1", scope: { userKey, projectKey, server, projectName, spaceId }, owner: { userId: identity.userId, userListId: identity.userListId }, history };
}

function putExport(store, identity, name, value) {
  const directory = path.join(path.dirname(store.file(identity)), "imports");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

let passed = 0;
async function test(name, operation) { await bounded(operation(), 8000); passed++; console.log(`ok ${passed}: ${name}`); }
function assertActive(h, name) {
  assert.equal(h.profile(), identities[name].userKey);
  assert.deepEqual(h.state.exportChatHistory().chats.map(chat => chat.id), [`${name}-chat`]);
  assert.equal(h.errors.length, 0, JSON.stringify(h.errors));
}

async function main() {
  await test("resolve-triggered invalidation waits for old cleanup before loading new history", async () => {
    const h = await harness();
    const held = h.holdStop();
    try {
      h.select("B", false);
      const loading = h.ensureHistoryLoaded();
      await until(() => h.stops === 1);
      await tick();
      assert.equal(h.loads.length, 0, "New history loaded while the old cleanup was still in flight.");
      held.release();
      await loading;
      await h.transition();
      assertActive(h, "B");
      await h.ensureHistoryLoaded();
      assertActive(h, "B");
    } finally { held.release(); h.dispose(); }
  });
  await test("configuration invalidation midway through load cannot publish stale history", async () => {
    const h = await harness();
    const held = h.holdLoad("B");
    try {
      h.select("B"); await h.transition();
      const loadingB = h.ensureHistoryLoaded();
      await until(() => h.loads.includes(identities.B.userKey));
      h.select("C");
      const loadingC = h.ensureHistoryLoaded();
      await tick(); held.release();
      await Promise.all([loadingB, loadingC]);
      await h.transition();
      assertActive(h, "C");
      assert.equal(h.publications.some(chats => chats.includes("B-chat")), false);
      assert.ok(h.writes.every(write => write.profile === identities.A.userKey));
    } finally { held.release(); h.dispose(); }
  });
  await test("two rapid A -> B -> C swaps cannot let earlier cleanup erase C", async () => {
    const h = await harness();
    const held = h.holdStop();
    try {
      h.select("B");
      const first = h.ensureHistoryLoaded();
      await until(() => h.stops === 1);
      h.select("C");
      const second = h.ensureHistoryLoaded();
      held.release();
      await Promise.all([first, second]);
      await h.transition();
      assertActive(h, "C");
      assert.equal(h.publications.some(chats => chats.includes("B-chat")), false);
      await h.ensureHistoryLoaded();
      assertActive(h, "C");
    } finally { held.release(); h.dispose(); }
  });
  await test("same-scope concurrent lazy initialization shares one load", async () => {
    const h = await harness();
    try {
      h.select("B"); await h.transition();
      await Promise.all([h.ensureHistoryLoaded(), h.ensureHistoryLoaded(), h.ensureHistoryLoaded()]);
      assertActive(h, "B");
      assert.equal(h.loads.filter(profile => profile === identities.B.userKey).length, 1);
    } finally { h.dispose(); }
  });
  await test("two writers encountering an abandoned lock both fail closed without reclaiming it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-lock-fixture-"));
    try {
      const a = new ProjectHistoryStore(root, normalizeHistory), b = new ProjectHistoryStore(root, normalizeHistory);
      const identity = identities.A;
      await a.load(identity, "/fixture/workspace");
      await a.save(identity, "/fixture/workspace", normalizeHistory(saved("A")));
      const left = await a.load(identity, "/fixture/workspace");
      const right = await b.load(identity, "/fixture/workspace");
      const file = a.file(identity), lock = `${file}.lock`;
      const before = fs.readFileSync(file);
      fs.mkdirSync(lock);
      const owner = JSON.stringify({ host: os.hostname(), pid: 2147483647, token: "abandoned-fixture-owner" });
      fs.writeFileSync(path.join(lock, "owner.json"), owner);
      const expired = new Date(Date.now() - 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(lock, "owner.json"), expired, expired);
      fs.utimesSync(lock, expired, expired);
      left.transcripts["A-chat"][0].text = "left edit";
      right.transcripts["A-chat"][0].text = "right edit";
      const results = await Promise.allSettled([a.save(identity, "/fixture/workspace", left), b.save(identity, "/fixture/workspace", right)]);
      assert.ok(results.every(result => result.status === "rejected"), "An abandoned pathname was automatically reclaimed.");
      assert.ok(results.every(result => String(result.reason).includes(lock)), "Lock failure must identify the operator recovery path.");
      assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), owner);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes(".conflict-")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("same-login realms cannot discover global legacy history or import foreign scoped exports", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-legacy-fixture-"));
    try {
      const a = identityFromConsole("https://a.invalid", projects.A.id, { ...users.A, login: "alice" }, projects.A);
      const b = identityFromConsole("https://b.invalid", projects.A.id, { ...users.B, login: "alice" }, projects.A);
      const left = new ProjectHistoryStore(root, normalizeHistory), right = new ProjectHistoryStore(root, normalizeHistory);
      await left.load(a, "/fixture/workspace"); await right.load(b, "/fixture/workspace");
      const legacy = path.join(root, "users", `alice-${crypto.createHash("sha256").update("alice").digest("hex").slice(0, 10)}`, "workspaces", "0123456789abcdef", "chats.json");
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      const original = JSON.stringify(saved("A"));
      fs.writeFileSync(legacy, original);
      assert.deepEqual(await left.listLegacy(a), []);
      assert.deepEqual(await right.listLegacy(b), []);
      const archive = boundExport(a, saved("A"));
      putExport(left, a, "owned.json", archive);
      putExport(right, b, "copied-foreign.json", archive);
      assert.equal((await left.listLegacy(a)).length, 1);
      assert.deepEqual(await right.listLegacy(b), [], "Copied foreign realm export became eligible for import.");
      for (const [key, value] of Object.entries(archive.scope)) {
        const changed = copy(archive); changed.scope[key] = `${value}-foreign`;
        putExport(left, a, `wrong-${key}.json`, changed);
      }
      for (const key of ["userId", "userListId"]) {
        const changed = copy(archive); changed.owner[key] += "-foreign";
        putExport(left, a, `wrong-${key}.json`, changed);
      }
      const candidates = await left.listLegacy(a);
      assert.equal(candidates.length, 1, "Mismatched ownership/scope fields were accepted.");
      const result = await left.importLegacy(a, "/fixture/workspace", candidates[0].id, { version: 1, chats: [], transcripts: {} });
      assert.equal(result.transcripts["A-chat"][0].text, "A private history");
      assert.equal(fs.readFileSync(legacy, "utf8"), original);
      assert.deepEqual(await left.listLegacy(a), [], "Completed import was offered twice.");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("malformed transcript contents block loading and subsequent destructive saves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-corrupt-fixture-"));
    try {
      const store = new ProjectHistoryStore(root, normalizeHistory), identity = identities.A;
      await store.load(identity, "/fixture/workspace");
      await store.save(identity, "/fixture/workspace", normalizeHistory(saved("A")));
      const file = store.file(identity), envelope = JSON.parse(fs.readFileSync(file, "utf8"));
      envelope.history.transcripts["A-chat"].push({ id: "malformed", kind: "message", role: "assistant", text: null, recoverableText: "retain-exact-malformed-content", createdAt: "2026-09-08" });
      const raw = JSON.stringify(envelope, null, 2);
      fs.writeFileSync(file, raw);
      await assert.rejects(() => store.load(identity, "/fixture/workspace"));
      await assert.rejects(() => store.save(identity, "/fixture/workspace", saved("A")));
      assert.equal(fs.readFileSync(file, "utf8"), raw);
      assert.equal(fs.existsSync(`${file}.bak`), false, "A failed load must not replace the recovery revision.");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("successful save backs up actual raw history rather than lossy normalized fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-backup-fixture-"));
    try {
      const store = new ProjectHistoryStore(root, normalizeHistory), identity = identities.A;
      await store.load(identity, "/fixture/workspace");
      await store.save(identity, "/fixture/workspace", normalizeHistory(saved("A")));
      const file = store.file(identity), envelope = JSON.parse(fs.readFileSync(file, "utf8"));
      envelope.history.transcripts["A-chat"][0].unknownRecoveryField = "original-raw-field-not-in-normalized-model";
      const raw = JSON.stringify(envelope, null, 2);
      fs.writeFileSync(file, raw);
      const loaded = await store.load(identity, "/fixture/workspace");
      assert.equal(loaded.transcripts["A-chat"][0].unknownRecoveryField, undefined);
      loaded.transcripts["A-chat"][0].text = "A edited text";
      await store.save(identity, "/fixture/workspace", loaded);
      const backup = fs.readFileSync(`${file}.bak`, "utf8");
      assert.ok(backup === raw || backup === `${raw}\n`, "Backup was reconstructed from normalized history.");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("an old identity's in-flight import cannot publish into the next identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-import-fixture-"));
    const held = gate(), originalRename = fs.promises.rename;
    let h, reached = false;
    try {
      h = await harness(root);
      const store = new ProjectHistoryStore(root, normalizeHistory), file = store.file(identities.A);
      putExport(store, identities.A, "owned.json", boundExport(identities.A, saved("A-imported")));
      const candidates = await h.history.listLegacy();
      assert.equal(candidates.length, 1);
      fs.promises.rename = async (from, to) => {
        if (to === file && !reached) { reached = true; await held.promise; }
        return originalRename(from, to);
      };
      let outcome;
      const importing = h.featureRequest("history.migration.import", { id: candidates[0].id }, "A-chat");
      const imported = importing.then(value => (outcome = { value }), error => (outcome = { error }));
      await until(() => reached || outcome);
      assert.ok(reached, `Import ended before its write boundary: ${outcome?.error?.stack ?? JSON.stringify(outcome)}`);
      const publicationBoundary = h.publications.length;
      h.select("B");
      const loading = h.ensureHistoryLoaded();
      await tick(); held.release();
      await Promise.all([imported, loading]);
      await h.transition();
      assertActive(h, "B");
      assert.equal(h.publications.slice(publicationBoundary).some(chats => chats.includes("A-imported-chat")), false, "An old import published private chats after the identity changed.");
      const check = new ProjectHistoryStore(root, normalizeHistory);
      const storedB = await check.load(identities.B, "/fixture/workspace");
      assert.deepEqual(storedB.chats.map(chat => chat.id), ["B-chat"]);
    } finally { held.release(); fs.promises.rename = originalRename; h?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("local edits and queued pre-import snapshots preserve new imported chats", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-local-import-fixture-"));
    const held = gate(), originalRename = fs.promises.rename;
    let h, reached = false;
    try {
      h = await harness(root);
      const removed = h.state.createChat("project", "Delete during import");
      await h.history.saveNow(identities.A.userKey, h.state.exportChatHistory());
      const store = new ProjectHistoryStore(root, normalizeHistory), file = store.file(identities.A);
      putExport(store, identities.A, "owned.json", boundExport(identities.A, saved("A-imported")));
      const candidates = await h.history.listLegacy();
      assert.equal(candidates.length, 1);
      fs.promises.rename = async (from, to) => {
        if (to === file && !reached) { reached = true; await held.promise; }
        return originalRename(from, to);
      };
      let outcome;
      const importing = h.featureRequest("history.migration.import", { id: candidates[0].id }, "A-chat");
      const imported = importing.then(value => (outcome = { value }), error => (outcome = { error }));
      await until(() => reached || outcome);
      assert.ok(reached, `Import ended before its write boundary: ${outcome?.error?.stack ?? JSON.stringify(outcome)}`);
      h.state.renameChat("A-chat", "Renamed during import");
      const edited = h.state.addTranscriptItem("A-chat", "user", "Edited during import");
      h.state.archiveChat(removed.id);
      assert.equal(h.state.deleteChat(removed.id), true);
      const added = h.state.createChat("project", "Created during import");
      h.state.updateChat("A-chat", { status: "running", activeTurnId: "fixture-live-turn", activeRunMode: "normal" });
      h.state.setChatContextWindow("A-chat", { status: "ready", usedTokens: 123, maxTokens: 1000, usedPercent: 12.3 });
      const input = { id: "fixture-input", requestId: 1, chatId: "A-chat", threadId: "fixture-thread", turnId: "fixture-live-turn", itemId: "fixture-item", questions: [], isBlocking: true, createdAt: "2026-09-08T00:00:00Z", expiresAt: "2026-09-08T01:00:00Z" };
      h.state.setPendingUserInputs("A-chat", [input]);
      const queuedSnapshot = h.state.exportChatHistory();
      const writing = h.history.saveNow(identities.A.userKey, queuedSnapshot);
      const written = writing.then(() => ({}), error => ({ error }));
      await tick(); held.release();
      const [, writeOutcome] = await Promise.all([imported, written]);
      assert.equal(writeOutcome.error, undefined, writeOutcome.error?.stack);
      assert.equal(outcome.error, undefined, outcome.error?.stack);
      await h.history.flush();
      const expected = ["A-chat", "A-imported-chat", added.id].sort();
      const verify = history => {
        assert.deepEqual(history.chats.map(chat => chat.id).sort(), expected);
        assert.equal(history.chats.find(chat => chat.id === "A-chat").title, "Renamed during import");
        assert.equal(history.transcripts["A-chat"].find(item => item.id === edited.id).text, "Edited during import");
      };
      verify(h.state.exportChatHistory());
      assert.equal(h.state.getChat("A-chat").status, "running", "Import reset an in-progress turn.");
      assert.equal(h.state.getChat("A-chat").activeTurnId, "fixture-live-turn");
      assert.equal(h.state.getChatContextWindow("A-chat").usedTokens, 123);
      assert.equal(h.state.getActiveChatId(), added.id);
      assert.deepEqual(h.state.getChatSnapshot("A-chat").pendingUserInputs, [input], "Import cleared an active input request.");
      const checker = new ProjectHistoryStore(root, normalizeHistory);
      verify(await checker.load(identities.A, workspace.workspaceFolders[0].uri.fsPath));
      await h.history.saveNow(identities.A.userKey, h.state.exportChatHistory());
      verify(await checker.load(identities.A, workspace.workspaceFolders[0].uri.fsPath));
      assert.equal(h.errors.length, 0, JSON.stringify(h.errors));
    } finally { held.release(); fs.promises.rename = originalRename; h?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  await test("explicit nullable Console space is a disjoint root scope, not a missing identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-null-space-fixture-"));
    try {
      const project = { ...projects.A, "space-id": null };
      const identity = identityFromConsole("https://element.invalid", project.id, users.A, project);
      assert.equal(identity.userKey, identities.A.userKey);
      for (const space of ["space", "server-root", "root", "null"]) {
        const named = identityFromConsole("https://element.invalid", project.id, users.A, { ...project, "space-id": space });
        assert.notEqual(identity.projectKey, named.projectKey);
      }
      for (const missing of [undefined, "", " "]) {
        assert.throws(() => identityFromConsole("https://element.invalid", project.id, users.A, { ...project, "space-id": missing }));
      }
      const store = new ProjectHistoryStore(root, normalizeHistory);
      await store.load(identity, "/fixture/workspace");
      await store.save(identity, "/fixture/workspace", normalizeHistory(saved("A")));
      assert.equal((await store.load(identity, "/fixture/workspace")).transcripts["A-chat"][0].text, "A private history");
      putExport(store, identity, "owned.json", boundExport(identity, saved("A-imported")));
      assert.equal((await store.listLegacy(identity)).length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const line = name => ast.getLineAndCharacterOfPosition(declarations.get(name).getStart(ast)).line + 1;
  console.log(`rc-identity-transition-check: ${passed} passed; actual extension closures at lines ${line("ensureHistoryLoaded")}/${line("invalidateIdentity")}, source ${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}; actual StateStore/history services, source-only, fake Console/VS Code, temp fixtures removed.`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs; else delete Module._extensions[".ts"];
});

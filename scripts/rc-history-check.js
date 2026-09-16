"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const originalLoad = Module._load;
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const changed = new EventEmitter();
const workspace = { workspaceFolders: [{ uri: { fsPath: "/workspace/application-a" } }], onDidChangeConfiguration: changed.event, getConfiguration: () => ({ get: (_, fallback) => fallback }) };
Module._load = function (id, ...args) { return id === "vscode" ? { EventEmitter, workspace } : originalLoad.call(this, id, ...args); };
const { identityFromConsole, resolveElementIdentity, ElementIdentityService, normalizeConsoleServer } = require("../dist/elementIdentityService");
const { ProjectHistoryStore, validateHistory } = require("../dist/projectHistoryStore");
const { ChatHistoryService, normalizeHistory } = require("../dist/chatHistoryService");
const { UserProfileService } = require("../dist/userProfileService");
const { searchHistory } = require("../dist/historySearch");
Module._load = originalLoad;

const user = { id: "user-1", "user-list-id": "list-1", login: "alice", presentation: "Alice", "is-active": true };
const project = { id: "project-deployment-a", name: "ActiveDirectory", "space-id": "space-1", deleted: false };
const identity = identityFromConsole("https://element.example/", project.id, user, project);
const empty = () => ({ version: 1, chats: [], transcripts: {} });
function chatHistory(ids) {
  return normalizeHistory({ version: 1, chats: ids.map((id) => ({ id, kind: "project", title: id, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", backendThreadId: `thread-${id}` })), transcripts: Object.fromEntries(ids.map((id) => [id, [{ id: `message-${id}`, kind: "message", role: "assistant", text: `Result for ${id}`, createdAt: "2026-09-08T00:00:00Z", status: "complete" }]])) });
}
const clone = (value) => JSON.parse(JSON.stringify(value));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rc-history-"));
  try {
    const redeployed = identityFromConsole("https://element.example/console", "new-project-id", user, { ...project, id: "new-project-id" });
    assert.equal(identity.projectKey, redeployed.projectKey, "project name, not application/project deployment ID, determines history");
    assert.equal(identity.userKey, redeployed.userKey);
    assert.notEqual(identity.userKey, identityFromConsole("https://other.example", project.id, user, project).userKey);
    assert.notEqual(identity.userKey, identityFromConsole(identity.server, project.id, { ...user, id: "user-2" }, project).userKey);
    assert.notEqual(identity.projectKey, identityFromConsole(identity.server, project.id, user, { ...project, "space-id": "space-2" }).projectKey);
    const serverRoot = identityFromConsole(identity.server, project.id, user, { ...project, "space-id": null });
    assert.notEqual(identity.projectKey, serverRoot.projectKey, "explicit null denotes a separate server-root project namespace");
    assert.equal(serverRoot.projectKey, identityFromConsole(identity.server, "redeployed", user, { ...project, id: "redeployed", "space-id": null }).projectKey);
    assert.throws(() => identityFromConsole(identity.server, project.id, user, { ...project, "space-id": undefined }));
    assert.throws(() => identityFromConsole(identity.server, project.id, user, { ...project, "space-id": "" }));
    assert.throws(() => identityFromConsole(identity.server, project.id, { login: "alice" }, project));
    assert.throws(() => identityFromConsole(identity.server, project.id, user, { ...project, deleted: true }));
    assert.throws(() => normalizeConsoleServer("https://secret:token@element.example"));
    const connection = { server: identity.server, clientId: "client", clientSecret: "do-not-log", projectId: project.id };
    const requests = [];
    const request = async (url, method, headers, body) => {
      requests.push({ url: url.toString(), method, headers, body });
      if (url.pathname.endsWith("/sys/token")) return { id_token: "private-token" };
      return url.pathname.endsWith("/me") ? user : project;
    };
    assert.deepEqual(await resolveElementIdentity(connection, request), identity);
    assert.equal(requests[0].body, "grant_type=CLIENT_CREDENTIALS");
    assert.equal(requests[1].headers.Authorization, "Bearer private-token");
    assert.equal(requests[1].url, "https://element.example/console/api/v2/me");
    const identityService = new ElementIdentityService(() => connection, request);
    await identityService.resolve();
    const count = requests.length;
    await identityService.resolve();
    assert.equal(requests.length, count, "identity lookup is locally cached within the same credential binding");
    const profiles = new UserProfileService({}, identityService);
    assert.equal(await profiles.getKnownProfileId(["someone-elses-profile"]), identity.userKey);
    assert.equal(profiles.getCurrentProfileLabel(), "Alice");
    connection.clientSecret = "changed";
    assert.equal(identityService.getCurrent(), undefined, "changed credentials invalidate identity synchronously");
    const unknown = new UserProfileService({}, new ElementIdentityService(() => ({ server: "", clientId: "", clientSecret: "", projectId: "" }), request));
    assert.equal(await unknown.getKnownProfileId(["sole-existing-profile"]), undefined);
    await assert.rejects(() => unknown.requireProfileId(["sole-existing-profile"]));
    identityService.dispose(); unknown.identity.dispose();

    const store = new ProjectHistoryStore(root, normalizeHistory);
    assert.equal(await store.load(identity, "/application-a"), undefined);
    const initial = chatHistory(["a", "b"]);
    await store.save(identity, "/application-a", initial);
    const file = store.file(identity);
    assert.ok(file.includes(`/users/${identity.userKey}/projects/${identity.projectKey}/`));
    const relocated = (await store.load(redeployed, "/application-b")).chats[0];
    assert.equal(relocated.backendThreadId, "thread-a", "same project retains native context after redeploy");
    assert.equal(relocated.backendWorkspacePath, "/application-a", "runtime must confirm the new cwd before updating it");
    const another = new ProjectHistoryStore(root, normalizeHistory);
    const a = await store.load(identity, "/application-a");
    const b = await another.load(identity, "/application-a");
    a.transcripts.a[0].text = "updated a";
    b.transcripts.b[0].text = "updated b";
    await store.save(identity, "/application-a", a);
    await another.save(identity, "/application-a", b);
    let saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.history.transcripts.a[0].text, "updated a");
    assert.equal(saved.history.transcripts.b[0].text, "updated b", "independent chats merge without lost updates");
    assert.ok(fs.existsSync(`${file}.bak`));
    await store.load(identity, "/application-a");
    await another.load(identity, "/application-a");
    const left = clone(saved.history), right = clone(saved.history);
    left.transcripts.a[0].text = "left"; right.transcripts.a[0].text = "right";
    await store.save(identity, "/application-a", left);
    await assert.rejects(() => another.save(identity, "/application-a", right), /другой IDE/);
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.history.transcripts.a[0].text, "left");
    const conflicts = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".conflict-"));
    assert.equal(conflicts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), conflicts[0]), "utf8")).history.transcripts.a[0].text, "right");
    fs.writeFileSync(file, "{broken-json");
    await assert.rejects(() => store.load(identity, "/application-a"), /защищена/);
    await assert.rejects(() => store.save(identity, "/application-a", empty()), /заблокирована/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken-json", "corrupt history cannot be overwritten by empty state");
    fs.writeFileSync(file, JSON.stringify(saved));
    await store.load(identity, "/application-a");
    assert.throws(() => validateHistory({ version: 99, chats: [], transcripts: {} }));
    assert.throws(() => validateHistory({ version: 1, chats: [{ id: "a" }], transcripts: {} }));

    const oldProfile = `alice-${crypto.createHash("sha256").update("alice").digest("hex").slice(0, 10)}`;
    const legacyFile = path.join(root, "users", oldProfile, "workspaces", "0123456789abcdef", "chats.json");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    const legacyText = JSON.stringify(chatHistory(["legacy"]));
    fs.writeFileSync(legacyFile, legacyText);
    assert.equal((await store.listLegacy(identity)).length, 0, "unscoped login-named history cannot establish ownership");
    const scopeRoot = path.dirname(store.file(identity));
    const { main: exportLegacy } = require("./export-legacy-history");
    exportLegacy(["--source", legacyFile, "--binding", path.join(scopeRoot, "import-target.json"), "--confirm-owner", identity.userId, "--confirm-project", identity.projectName]);
    const list = await store.listLegacy(identity);
    assert.equal(list.length, 1);
    assert.equal(list[0].chatCount, 1);
    const migrated = await store.importLegacy(identity, "/application-a", list[0].id, saved.history);
    assert.equal(migrated.chats.find((chat) => chat.id === "legacy").backendThreadId, null);
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyText, "migration leaves old plugin source intact");
    assert.equal((await store.listLegacy(identity)).length, 0, "migration manifest prevents duplicate imports");
    assert.ok(fs.readdirSync(path.join(scopeRoot, "imports")).some((name) => name.endsWith(".bak")));
    const foreign = identityFromConsole("https://other.example", project.id, { ...user, id: "other-user", "user-list-id": "other-list" }, project);
    await another.load(foreign, "/workspace");
    const foreignRoot = path.dirname(another.file(foreign));
    fs.mkdirSync(path.join(foreignRoot, "imports"), { recursive: true });
    const archive = fs.readdirSync(path.join(scopeRoot, "imports")).find((name) => name.endsWith(".json"));
    fs.copyFileSync(path.join(scopeRoot, "imports", archive), path.join(foreignRoot, "imports", archive));
    assert.equal((await another.listLegacy(foreign)).length, 0, "even an uploaded/copied foreign export cannot cross user/realm scope");
    const malformed = clone(migrated);
    malformed.transcripts.a.push({ id: "broken", kind: "message", role: "assistant", createdAt: "2026-09-08", recoverableText: "must-not-disappear" });
    assert.throws(() => validateHistory(malformed), /Повреждено сообщение/);

    const serviceRoot = path.join(root, "service");
    const logger = { info() {}, warn() {}, error() {} };
    const service = new ChatHistoryService({ globalStorageUri: { fsPath: "/storage" } }, serviceRoot, logger, () => identity, (error) => assert.fail(error));
    await service.load(identity.userKey);
    for (let i = 0; i < 9; i++) {
      service.scheduleSave(identity.userKey, chatHistory([`stream-${i}`]));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const serviceFile = new ProjectHistoryStore(serviceRoot, normalizeHistory).file(identity);
    assert.ok(fs.existsSync(serviceFile), "continuous streaming does not indefinitely postpone persistence");
    await service.flush(); service.dispose();
    assert.equal(JSON.parse(fs.readFileSync(serviceFile, "utf8")).history.chats[0].id, "stream-8");
    const big = chatHistory(Array.from({ length: 240 }, (_, index) => `item-${index}`));
    let found = await searchHistory(big, "Result", 0);
    assert.equal(found.items.length, 50); assert.equal(found.nextOffset, 50);
    found = await searchHistory(big, "item-239");
    assert.equal(found.items[0].itemId, "message-item-239", "search covers history outside the current viewport");
    console.log("RC identity/history checks passed: verified ownership, redeploy scope, isolation, corruption guard, backups, concurrent writers/conflicts, explicit migration, bounded streaming persistence, full-history search.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

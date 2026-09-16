/* Source-only fixtures: no dist build, Element server, remote Git or real worktrees. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const Module = require("node:module");
const ts = require("typescript");

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-rc-features-")));
const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
const originalExecFile = cp.execFile;
const gitCalls = [];
let gitHook;
let sequence = 0;
let passed = 0;
let failed = 0;
const native = { commands: [], shown: [], threads: [], providers: new Map(), documents: [], names: [], handler: undefined, diagnostics: [] };

class Uri {
  constructor(scheme, value) { this.scheme = scheme; this.path = value; this.fsPath = value; }
  static file(value) { return new Uri("file", value); }
  static from({ scheme, path: value }) { return new Uri(scheme, value); }
  toString() { return `${this.scheme}:${this.path}`; }
}
class Range { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } }
class MarkdownString { constructor() { this.value = ""; } appendText(text) { this.value += text; return this; } }
const fake = {
  Uri, Range, MarkdownString, CommentMode: { Preview: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  workspace: {
    get textDocuments() { return native.documents; },
    registerTextDocumentContentProvider(scheme, provider) { native.providers.set(scheme, provider); return { dispose() { if (native.providers.get(scheme) === provider) native.providers.delete(scheme); } }; },
    async openTextDocument(uri) { return { uri, getText: () => native.providers.get(uri.scheme)?.provideTextDocumentContent(uri) ?? "" }; }
  },
  commands: {
    async getCommands() { return native.names; },
    async executeCommand(command, ...args) { native.commands.push({ command, args }); return native.handler ? native.handler(command, args) : command === "com.e1c.g5rt.lsp.request" ? [] : undefined; }
  },
  window: { async showTextDocument(document) { native.shown.push(document); }, async showWarningMessage(message) { native.shown.push(message); } },
  comments: { createCommentController() { return { createCommentThread(uri, range, comments) { const thread = { uri, range, comments, dispose() { this.disposed = true; } }; native.threads.push(thread); return thread; }, dispose() {} }; } },
  languages: { getDiagnostics() { return native.diagnostics; } }
};

Module._load = function(request, parent, isMain) { return request === "vscode" ? fake : originalLoad.call(this, request, parent, isMain); };
Module._extensions[".ts"] = function(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } });
  module._compile(output.outputText, filename);
};
cp.execFile = function(file, args, options, callback) {
  assert.equal(file, "git");
  assert.ok(Array.isArray(args));
  assert.ok(!options.shell);
  gitCalls.push({ args, env: options.env });
  return originalExecFile(file, args, options, (error, stdout, stderr) => {
    if (gitHook) gitHook(args, error);
    callback(error, stdout, stderr);
  });
};
const { PluginFeatureService } = require("../src/pluginFeatureService.ts");
const { DiffArtifactService } = require("../src/diffArtifactService.ts");
const { safeFile, safeRelative } = require("../src/featureSafety.ts");

function git(root, ...args) {
  return cp.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(sandbox, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
}
function put(root, relative, text) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function resetNative() {
  Object.assign(native, { commands: [], shown: [], threads: [], documents: [], names: ["vscode.diff", "com.e1c.g5rt.lsp.request", "g5rt.commands.applicationMenu.openApplication"], handler: undefined, diagnostics: [] });
  fake.comments = { createCommentController() { return { createCommentThread(uri, range, comments) { const thread = { uri, range, comments, dispose() { this.disposed = true; } }; native.threads.push(thread); return thread; }, dispose() {} }; } };
}
function fixture({ unborn = false, sha256 = false, options = {} } = {}) {
  resetNative();
  const home = path.join(sandbox, String(sequence++));
  const root = path.join(home, "project");
  const scope = path.join(home, "scope");
  const artifacts = path.join(scope, "sessions", "one", "browser", "artifacts");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  git(root, "init", "-q", ...(sha256 ? ["--object-format=sha256"] : []));
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  if (!unborn) {
    put(root, "file.txt", "first unchanged line\nbefore\nlast unchanged line\n");
    put(root, "other.txt", "other before\n");
    git(root, "add", "--", "file.txt", "other.txt");
    git(root, "commit", "-qm", "fixture base");
  }
  const current = { root, scope, artifacts };
  const diff = new DiffArtifactService({ info() {} });
  const service = new PluginFeatureService({ getWorkspaceRoot: () => current.root, getScopeRoot: () => current.scope, getBrowserArtifactsRoot: () => current.artifacts, diffArtifacts: diff, commandTimeoutMs: 500, ...options });
  return { root, scope, artifacts, current, service, diff, dispose() { service.dispose(); diff.dispose(); } };
}
async function run(name, fn) {
  try { await fn(); passed++; console.log(`ok ${passed}: ${name}`); }
  catch (error) { failed++; console.error(`FAIL: ${name}`); console.error(error.stack || error); }
  finally { gitHook = undefined; }
}
async function item(f, relative = "file.txt", layer = "worktree") {
  const result = await f.service.handle("review.list", {}, "chat-a");
  assert.equal(result.ok, true, JSON.stringify(result));
  const entry = result.items.find(value => value.path === relative && value.layer === layer);
  assert.ok(entry, `${relative}/${layer}: ${JSON.stringify(result)}`);
  return entry;
}
function action(entry) { return { id: entry.id, revision: entry.revision, confirmed: true }; }
function changed(f, value = "after") { put(f.root, "file.txt", `first unchanged line\n${value}\nlast unchanged line\n`); }

async function main() {
  await run("Russian feature guidance preserves structured error/status contracts", async () => {
    const f = fixture();
    try {
      const actions = await f.service.handle("project.actions", {}, "chat-a");
      assert.equal(actions.ok, true);
      for (const entry of actions.items) {
        assert.match(entry.label, /[А-Яа-яЁё]/);
        if (entry.reason) assert.match(entry.reason, /[А-Яа-яЁё]/);
      }
      const nested = path.join(f.root, "nested"); fs.mkdirSync(nested); f.current.root = nested;
      const result = await f.service.handle("review.list", {}, "chat-a");
      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.equal(result.error.category, "needs-attention");
      assert.match(result.message, /корневой каталог Git-репозитория/);
      assert.match(result.message, /родительских каталогах/);
      assert.equal(result.error.message, result.message);
    } finally { f.dispose(); }
  });
  await run("full index/disk snapshots include unchanged lines and native immutable URIs", async () => {
    const f = fixture();
    try {
      changed(f);
      const entry = await item(f);
      const result = await f.service.handle("review.open", { id: entry.id }, "chat-a");
      assert.equal(result.review.full, true);
      assert.equal(result.review.before.text, git(f.root, "show", ":file.txt"));
      assert.equal(result.review.after.text, fs.readFileSync(path.join(f.root, "file.txt"), "utf8"));
      const opened = native.commands.find(value => value.command === "vscode.diff");
      assert.equal(opened.args[0].scheme, "codex-diff-before");
      assert.equal(opened.args[1].scheme, "codex-diff-after");
      changed(f, "later");
      assert.equal(f.diff.provideTextDocumentContent(opened.args[1]), result.review.after.text);
    } finally { f.dispose(); }
  });
  await run("stage only reviewed revision, preserve other staged content and working files", async () => {
    const f = fixture();
    try {
      put(f.root, "other.txt", "other staged\n"); git(f.root, "add", "other.txt");
      changed(f);
      const entry = await item(f);
      const result = await f.service.handle("review.stage", action(entry), "chat-a");
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(git(f.root, "show", ":file.txt"), fs.readFileSync(path.join(f.root, "file.txt"), "utf8"));
      assert.equal(git(f.root, "show", ":other.txt"), "other staged\n");
      assert.equal(fs.existsSync(path.join(f.root, ".git", "index.lock")), false);
      assert.equal(fs.readdirSync(path.join(f.root, ".git")).some(name => name.startsWith("codex-review-")), false);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, false);
    } finally { f.dispose(); }
  });
  await run("revert restores index rather than HEAD and retains private recovery bytes", async () => {
    const f = fixture();
    try {
      changed(f, "staged"); git(f.root, "add", "file.txt"); changed(f, "working");
      const entry = await item(f);
      const result = await f.service.handle("review.revert", action(entry), "chat-a");
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), /staged/);
      assert.match(git(f.root, "show", ":file.txt"), /staged/);
      const backup = path.join(f.scope, "review-recovery", `${result.recoveryId}.json`);
      const stored = JSON.parse(fs.readFileSync(backup, "utf8"));
      assert.match(Buffer.from(stored.contentBase64, "base64").toString(), /working/);
      if (process.platform !== "win32") assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
      const staged = await item(f, "file.txt", "index");
      assert.equal(staged.canRevert, false);
      assert.equal((await f.service.handle("review.revert", action(staged), "chat-a")).status, "unsupported");
    } finally { f.dispose(); }
  });
  await run("added, deleted and unborn-repository revisions stage/revert safely", async () => {
    const f = fixture({ unborn: true });
    try {
      put(f.root, "fresh.txt", "brand new\n");
      let entry = await item(f, "fresh.txt");
      assert.equal(entry.change, "added");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.equal(git(f.root, "show", ":fresh.txt"), "brand new\n");
      fs.unlinkSync(path.join(f.root, "fresh.txt"));
      entry = await item(f, "fresh.txt");
      assert.equal((await f.service.handle("review.revert", action(entry), "chat-a")).ok, true);
      assert.equal(fs.readFileSync(path.join(f.root, "fresh.txt"), "utf8"), "brand new\n");
      fs.unlinkSync(path.join(f.root, "fresh.txt"));
      entry = await item(f, "fresh.txt");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.equal(git(f.root, "ls-files"), "");
      put(f.root, "untracked.txt", "recover me\n");
      entry = await item(f, "untracked.txt");
      const result = await f.service.handle("review.revert", action(entry), "chat-a");
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(f.root, "untracked.txt")), false);
      assert.equal(Buffer.from(JSON.parse(fs.readFileSync(path.join(f.scope, "review-recovery", `${result.recoveryId}.json`))).contentBase64, "base64").toString(), "recover me\n");
    } finally { f.dispose(); }
  });
  await run("explicit confirmation, revision tokens, IDs and chat/scope validation", async () => {
    const f = fixture();
    try {
      changed(f);
      const entry = await item(f);
      const indexBefore = fs.readFileSync(path.join(f.root, ".git", "index"));
      for (const payload of [{ id: entry.id, revision: entry.revision }, { ...action(entry), confirmed: "true" }, { ...action(entry), id: "../file.txt" }, { ...action(entry), revision: "stale" }]) {
        assert.equal((await f.service.handle("review.stage", payload, "chat-a")).ok, false);
      }
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-b")).ok, false);
      f.current.scope = path.join(f.scope, "other-user"); fs.mkdirSync(f.current.scope);
      assert.equal((await f.service.handle("review.open", { id: entry.id }, "chat-a")).ok, false);
      f.current.scope = undefined;
      const unauthenticated = await f.service.handle("review.list", {}, "chat-a");
      assert.equal(unauthenticated.status, "blocked");
      assert.equal(unauthenticated.error.category, "needs-attention");
      assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), indexBefore);
    } finally { f.dispose(); }
  });
  await run("dirty editor buffer is never saved, replaced, reverted or staged", async () => {
    const f = fixture();
    try {
      changed(f);
      native.documents = [{ uri: Uri.file(path.join(f.root, "file.txt")), isDirty: true, getText: () => "unsaved private editor text" }];
      const entry = await item(f);
      assert.equal(entry.canStage, false);
      for (const command of ["review.stage", "review.revert"]) assert.equal((await f.service.handle(command, action(entry), "chat-a")).status, "blocked");
      assert.equal(native.documents[0].getText(), "unsaved private editor text");
      assert.match(git(f.root, "show", ":file.txt"), /before/);
      assert.match(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), /after/);
      const open = await f.service.handle("review.open", { id: entry.id }, "chat-a");
      assert.ok(!JSON.stringify(open).includes("unsaved private editor text"));
    } finally { f.dispose(); }
  });
  await run("file, index and HEAD changes reject stale review mutations", async () => {
    const f = fixture();
    try {
      changed(f);
      let entry = await item(f);
      changed(f, "concurrent");
      assert.equal((await f.service.handle("review.revert", action(entry), "chat-a")).status, "conflict");
      entry = await item(f);
      put(f.root, "other.txt", "new staged content"); git(f.root, "add", "other.txt");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "conflict");
      entry = await item(f);
      git(f.root, "commit", "--allow-empty", "-qm", "new head");
      assert.equal((await f.service.handle("review.revert", action(entry), "chat-a")).status, "conflict");
      assert.match(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), /concurrent/);
    } finally { f.dispose(); }
  });
  await run("race after blob creation cannot overwrite concurrent file edits or dirty buffers", async () => {
    const f = fixture();
    try {
      changed(f);
      let entry = await item(f);
      gitHook = args => { if (args.includes("hash-object")) { gitHook = undefined; changed(f, "raced edit"); } };
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "conflict");
      assert.match(git(f.root, "show", ":file.txt"), /before/);
      entry = await item(f);
      gitHook = args => { if (args.includes("hash-object")) { gitHook = undefined; native.documents = [{ uri: Uri.file(path.join(f.root, "file.txt")), isDirty: true }]; } };
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "blocked");
      assert.equal(fs.existsSync(path.join(f.root, ".git", "index.lock")), false);
    } finally { f.dispose(); }
  });
  await run("preexisting index lock is preserved and concurrent stage is single-winner", async () => {
    const f = fixture();
    try {
      changed(f);
      let entry = await item(f);
      const lock = path.join(f.root, ".git", "index.lock");
      fs.writeFileSync(lock, "other Git operation");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "blocked");
      assert.equal(fs.readFileSync(lock, "utf8"), "other Git operation"); fs.unlinkSync(lock);
      entry = await item(f);
      const results = await Promise.all([f.service.handle("review.stage", action(entry), "chat-a"), f.service.handle("review.stage", action(entry), "chat-a")]);
      assert.equal(results.filter(value => value.ok).length, 1);
      assert.equal(fs.existsSync(lock), false);
    } finally { f.dispose(); }
  });
  await run("repo boundary, symlink parents, git metadata and option-like paths are guarded", async () => {
    const f = fixture();
    try {
      for (const candidate of ["../outside", "/tmp/outside", "C:/outside", ".git/config", "sub/.GIT/config", "sub/../../outside", "a\\b", "a\nb"]) assert.throws(() => safeRelative(candidate));
      const outside = path.join(sandbox, "outside.txt"); fs.writeFileSync(outside, "outside remains\n");
      fs.symlinkSync(sandbox, path.join(f.root, "escape"));
      assert.throws(() => safeFile(f.root, "escape/outside.txt"));
      fs.symlinkSync(outside, path.join(f.root, "linked.txt"));
      const symlink = await item(f, "linked.txt");
      assert.equal(symlink.canOpen, false);
      const tricky = "--flag ; touch INJECTED $(x) [*].txt";
      put(f.root, tricky, "literal path\n");
      const entry = await item(f, tricky);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.equal(git(f.root, "show", `:${tricky}`), "literal path\n");
      assert.equal(fs.existsSync(path.join(f.root, "INJECTED")), false);
      assert.equal(fs.readFileSync(outside, "utf8"), "outside remains\n");
      fs.mkdirSync(path.join(f.root, "nested")); f.current.root = path.join(f.root, "nested");
      assert.equal((await f.service.handle("review.list", {}, "chat-a")).status, "blocked");
    } finally { f.dispose(); }
  });
  await run("binary, large, hardlinked and content-conversion files are not destructively handled", async () => {
    const f = fixture();
    try {
      put(f.root, "binary.bin", Buffer.from([0, 255, 1]));
      put(f.root, "large.txt", Buffer.alloc(600 * 1024, 97));
      put(f.root, ".gitattributes", "file.txt text eol=lf\n"); changed(f);
      fs.linkSync(path.join(f.root, "other.txt"), path.join(f.root, "linked-hard.txt"));
      for (const relative of ["binary.bin", "large.txt", "linked-hard.txt"]) assert.equal((await item(f, relative)).canOpen, false);
      const entry = await item(f);
      assert.equal(entry.canStage, false);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "unsupported");
    } finally { f.dispose(); }
  });
  await run("rename is two explicit path revisions without implicit whole-repo staging", async () => {
    const f = fixture();
    try {
      fs.renameSync(path.join(f.root, "file.txt"), path.join(f.root, "renamed.txt"));
      const added = await item(f, "renamed.txt");
      const removed = await item(f, "file.txt");
      assert.equal(added.change, "added"); assert.equal(removed.change, "deleted");
      assert.equal((await f.service.handle("review.stage", action(added), "chat-a")).ok, true);
      assert.match(git(f.root, "ls-files"), /file.txt/);
      assert.equal((await f.service.handle("review.stage", action(removed), "chat-a")).status, "conflict");
    } finally { f.dispose(); }
  });
  await run("review discovery never executes repository clean/process filters", async () => {
    const f = fixture();
    try {
      const marker = path.join(f.scope, "filter-executed");
      const filter = path.join(f.scope, "filter.cjs");
      fs.writeFileSync(filter, `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker)},"executed");process.stdout.write(fs.readFileSync(0));`);
      git(f.root, "config", "filter.fixture.clean", `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`);
      put(f.root, ".gitattributes", "file.txt filter=fixture\n");
      changed(f);
      const entry = await item(f);
      assert.equal(entry.canOpen, true); assert.equal(entry.canStage, false);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "unsupported");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(gitCalls.some(call => call.args.includes("status") || call.args.includes("diff-files")), false);
    } finally { f.dispose(); }
  });
  await run("partial-clone configuration is rejected before lazy fetching objects", async () => {
    const f = fixture();
    try {
      git(f.root, "config", "remote.fake.promisor", "true");
      git(f.root, "config", "remote.fake.url", "https://never-contact.invalid/repo");
      const before = gitCalls.length;
      const result = await f.service.handle("review.list", {}, "chat-a");
      assert.equal(result.status, "unsupported");
      assert.equal(gitCalls.slice(before).some(call => call.args.includes("cat-file")), false);
    } finally { f.dispose(); }
  });
  await run("revert preserves restricted permissions and honours core.filemode=false on stage", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    try {
      changed(f); fs.chmodSync(path.join(f.root, "file.txt"), 0o600);
      let entry = await item(f);
      assert.equal((await f.service.handle("review.revert", action(entry), "chat-a")).ok, true);
      assert.equal(fs.statSync(path.join(f.root, "file.txt")).mode & 0o777, 0o600);
      git(f.root, "config", "core.filemode", "false");
      changed(f); fs.chmodSync(path.join(f.root, "file.txt"), 0o700);
      entry = await item(f);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.match(git(f.root, "ls-files", "--stage", "--", "file.txt"), /^100644 /);
      assert.equal(fs.statSync(path.join(f.root, "file.txt")).mode & 0o777, 0o700);
    } finally { f.dispose(); }
  });
  await run("scope revoked while staging leaves original index and working files intact", async () => {
    const f = fixture();
    try {
      changed(f); const entry = await item(f);
      const before = fs.readFileSync(path.join(f.root, ".git", "index"));
      gitHook = args => { if (args.includes("hash-object")) { gitHook = undefined; f.current.scope = undefined; } };
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "conflict");
      assert.deepEqual(fs.readFileSync(path.join(f.root, ".git", "index")), before);
      assert.match(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), /after/);
      assert.equal(fs.existsSync(path.join(f.root, ".git", "index.lock")), false);
    } finally { f.dispose(); }
  });
  await run("inherited Git environment cannot redirect review to another repository", async () => {
    const f = fixture();
    const previous = process.env.GIT_DIR;
    try {
      changed(f);
      process.env.GIT_DIR = path.join(sandbox, "not-this-repository");
      const entry = await item(f);
      assert.equal(entry.canStage, true);
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.equal(gitCalls.at(-1).env.GIT_DIR, undefined);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
      f.dispose();
    }
  });
  await run("replaced owned index lock is neither committed nor removed", async () => {
    const f = fixture();
    try {
      changed(f); const entry = await item(f);
      const lock = path.join(f.root, ".git", "index.lock");
      gitHook = args => { if (args.includes("hash-object")) { gitHook = undefined; fs.renameSync(lock, `${lock}.old`); fs.writeFileSync(lock, "replacement lock"); } };
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).status, "conflict");
      assert.equal(fs.readFileSync(lock, "utf8"), "replacement lock");
      assert.match(git(f.root, "show", ":file.txt"), /before/);
    } finally { f.dispose(); }
  });
  await run("unborn SHA-256 index supports explicit add and deletion without SHA-1 assumptions", async () => {
    const f = fixture({ unborn: true, sha256: true });
    try {
      put(f.root, "fresh.txt", "sha256 file\n");
      let entry = await item(f, "fresh.txt");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.match(git(f.root, "ls-files", "--stage"), /^100644 [a-f\d]{64} /);
      fs.unlinkSync(path.join(f.root, "fresh.txt"));
      entry = await item(f, "fresh.txt");
      assert.equal((await f.service.handle("review.stage", action(entry), "chat-a")).ok, true);
      assert.equal(git(f.root, "ls-files"), "");
    } finally { f.dispose(); }
  });
  await run("changed symbolic HEAD with identical commit is a stale review", async () => {
    const f = fixture();
    try {
      changed(f); const entry = await item(f);
      const head = git(f.root, "rev-parse", "HEAD").trim();
      fs.writeFileSync(path.join(f.root, ".git", "HEAD"), `${head}\n`);
      assert.equal((await f.service.handle("review.revert", action(entry), "chat-a")).status, "conflict");
      assert.match(fs.readFileSync(path.join(f.root, "file.txt"), "utf8"), /after/);
    } finally { f.dispose(); }
  });
  await run("review list pages retain valid IDs even with large complete snapshots", async () => {
    const f = fixture({ unborn: true });
    try {
      for (let i = 0; i < 20; i++) put(f.root, `large-${i}.txt`, "x".repeat(500 * 1024));
      const list = await f.service.handle("review.list", {}, "chat-a");
      assert.equal(list.ok, true); assert.equal(list.truncated, true); assert.ok(list.nextOffset > 0);
      for (const entry of [list.items[0], list.items.at(-1)]) {
        const open = await f.service.handle("review.open", { id: entry.id }, "chat-a");
        assert.equal(open.ok, true); assert.equal(open.review.after.previewTruncated, true);
        assert.ok(open.review.after.text.length <= 24000); assert.equal(open.review.after.bytes, 500 * 1024);
      }
      const next = await f.service.handle("review.list", { offset: list.nextOffset }, "chat-a");
      assert.equal(next.ok, true); assert.equal(next.items.length + list.items.length, 20);
    } finally { f.dispose(); }
  });
  await run("native revision comments and explicit follow-up route only to originating chat", async () => {
    const sent = [];
    const f = fixture({ options: { onReviewComment: async (...args) => { sent.push(args); } } });
    try {
      changed(f); const entry = await item(f);
      await f.service.handle("review.open", { id: entry.id }, "chat-a");
      const args = { id: entry.id, revision: entry.revision, line: 2, text: "Check this condition [link](command:bad)", sendToChat: false };
      const local = await f.service.handle("review.comment", args, "chat-a");
      assert.equal(local.comment.native, true); assert.equal(sent.length, 0);
      assert.equal(native.threads[0].uri.scheme, "codex-diff-after");
      assert.equal(native.threads[0].comments[0].body.isTrusted, false);
      assert.equal((await f.service.handle("review.comment", { ...args, sendToChat: true }, "chat-a")).comment.sentToChat, true);
      await f.service.handle("review.comment", { ...args, sendToChat: true }, "chat-a");
      assert.equal(sent.length, 1); assert.equal(sent[0][0], "chat-a");
      assert.equal(sent[0][2].revision, entry.revision);
      assert.equal((await f.service.handle("review.comment", { ...args, line: -1 }, "chat-a")).ok, false);
      assert.equal((await f.service.handle("review.comment", args, "chat-b")).ok, false);
    } finally { f.dispose(); }
  });
  await run("missing native comments/diff support retains usable in-chat review", async () => {
    const f = fixture();
    try {
      fake.comments = undefined; native.names = [];
      changed(f); const entry = await item(f);
      const result = await f.service.handle("review.open", { id: entry.id }, "chat-a");
      assert.equal(result.ok, true); assert.equal(result.opened, false); assert.match(result.review.after.text, /after/);
      const note = await f.service.handle("review.comment", { ...action(entry), line: 1, text: "Review note", sendToChat: true }, "chat-a");
      assert.equal(note.comment.native, false); assert.equal(note.comment.sentToChat, false); assert.match(note.followUp, /Review note/);
    } finally { f.dispose(); }
  });
  await run("failure of optional native command probing does not block the in-chat review", async () => {
    const f = fixture();
    const original = fake.commands.getCommands;
    try {
      fake.commands.getCommands = async () => { throw new Error("native command bridge unavailable"); };
      changed(f); const entry = await item(f);
      const result = await f.service.handle("review.open", { id: entry.id }, "chat-a");
      assert.equal(result.ok, true); assert.equal(result.opened, false);
    } finally { fake.commands.getCommands = original; f.dispose(); }
  });
  await run("timed-out comment delivery stays pending and cannot submit duplicate follow-ups", async () => {
    let finish;
    let count = 0;
    const f = fixture({ options: { commandTimeoutMs: 50, onReviewComment: () => { count++; return new Promise(resolve => { finish = resolve; }); } } });
    try {
      changed(f); const entry = await item(f);
      const args = { ...action(entry), line: 1, text: "slow follow-up", sendToChat: true };
      const result = await f.service.handle("review.comment", args, "chat-a");
      assert.equal(result.comment.sentToChat, false); assert.equal(result.comment.sendingToChat, true);
      await f.service.handle("review.comment", args, "chat-a"); assert.equal(count, 1);
      finish(); await new Promise(resolve => setImmediate(resolve));
      const completed = await f.service.handle("review.comment", args, "chat-a");
      assert.equal(completed.comment.sentToChat, true); assert.equal(completed.comment.sendingToChat, false); assert.equal(count, 1);
    } finally { f.dispose(); }
  });
  await run("recorded patch remains honestly labelled fragment; supplied full snapshot opens native diff", async () => {
    const f = fixture();
    try {
      await f.diff.openDiff({ id: "diff", title: "changes" }, { path: "file.txt", diff: "@@ -2,1 +2,1 @@\n-before\n+after", truncated: true });
      assert.equal(native.commands.filter(value => value.command === "vscode.diff").length, 0);
      assert.match(native.shown[0].getText(), /fragment; not full-file revisions \(truncated\)/);
      const full = new DiffArtifactService({ info() {} }, async () => ({ path: "file.txt", beforeText: "full before\n", afterText: "full after\n" }));
      await full.openDiff({ id: "diff" }, { path: "file.txt" });
      assert.equal(native.commands.at(-1).command, "vscode.diff"); full.dispose();
    } finally { f.dispose(); }
  });
  await run("project capability list does not launch LSP, terminals, publication or worktrees", async () => {
    const f = fixture();
    try {
      const result = await f.service.handle("project.actions", {}, "chat-a");
      assert.equal(result.items.find(value => value.id === "openApplication").available, true);
      assert.equal(result.items.find(value => value.id === "worktree").available, false);
      assert.equal(native.commands.length, 0);
      native.names = [];
      assert.equal((await f.service.handle("project.action.run", { id: "openApplication", confirmed: true }, "chat-a")).status, "unsupported");
      for (const id of ["rebuild", "worktree", "git.branch", "shell", "g5rt.commands.applicationMenu.openApplication"]) assert.equal((await f.service.handle("project.action.run", { id, confirmed: true }, "chat-a")).ok, false);
    } finally { f.dispose(); }
  });
  await run("verified bounded readiness, cached diagnostics and explicit app open", async () => {
    const f = fixture();
    try {
      native.diagnostics = [[Uri.file(path.join(f.root, "file.txt")), [{ severity: 0, range: new Range(4, 0, 4, 1), message: "Type error" }]], [Uri.file(path.join(sandbox, "outside.txt")), [{ severity: 0, range: new Range(0, 0, 0, 1), message: "outside" }]]];
      const result = await f.service.handle("project.action.run", { id: "diagnostics", confirmed: true }, "chat-a");
      assert.equal(result.diagnostics.errors, 1); assert.equal(result.diagnostics.buildRequested, false); assert.equal(result.diagnostics.freshness, "current-IDE-cache");
      assert.deepEqual(native.commands[0], { command: "com.e1c.g5rt.lsp.request", args: ["navigator/uiClientApplications"] });
      const open = await f.service.handle("project.action.run", { id: "openApplication", confirmed: true }, "chat-a");
      assert.equal(open.status, "dispatched");
      assert.equal(native.commands.at(-1).command, "g5rt.commands.applicationMenu.openApplication");
      assert.equal(native.commands.at(-1).args.length, 0);
    } finally { f.dispose(); }
  });
  await run("late readiness cannot dispatch application after timeout; duplicate request remains blocked", async () => {
    let resolveReady;
    const f = fixture({ options: { commandTimeoutMs: 50, isProjectReady: () => new Promise(resolve => { resolveReady = resolve; }) } });
    try {
      const args = { id: "openApplication", confirmed: true };
      const timeout = await f.service.handle("project.action.run", args, "chat-a");
      assert.equal(timeout.status, "timeout"); assert.equal(timeout.error.category, "deadline-exceeded");
      assert.equal((await f.service.handle("project.action.run", args, "chat-a")).status, "blocked");
      resolveReady(true); await new Promise(resolve => setImmediate(resolve));
      assert.equal(native.commands.length, 0);
    } finally { f.dispose(); }
  });
  await run("scope change during readiness blocks the eventual action", async () => {
    let resolveReady;
    const f = fixture({ options: { isProjectReady: () => new Promise(resolve => { resolveReady = resolve; }) } });
    try {
      const pending = f.service.handle("project.action.run", { id: "openApplication", confirmed: true }, "chat-a");
      await new Promise(resolve => setImmediate(resolve));
      f.current.scope = undefined;
      resolveReady(true);
      assert.equal((await pending).status, "conflict"); assert.equal(native.commands.length, 0);
    } finally { f.dispose(); }
  });
  await run("unready Element and unsupported actions never dispatch even when commands exist", async () => {
    const f = fixture({ options: { isProjectReady: async () => false } });
    try {
      assert.equal((await f.service.handle("project.action.run", { id: "openApplication", confirmed: true }, "chat-a")).status, "blocked");
      assert.equal((await f.service.handle("project.action.run", { id: "openApplication" }, "chat-a")).status, "blocked");
      assert.equal(native.commands.length, 0);
    } finally { f.dispose(); }
  });
  await run("browser IDs are scope/chat/session bound and previews redact credential fields", async () => {
    const f = fixture();
    try {
      put(f.artifacts, "console.log", "normal event\nAuthorization: Bearer SECRET-A\nCookie: session=SECRET-B\npassword=SECRET-C\nhttps://user:SECRET-D@example.invalid/path?token=SECRET-E\n");
      put(f.artifacts, "network.har", JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "https://user:SECRET-F@example.invalid/private/SECRET-G?token=SECRET-H", headers: [{ name: "Cookie", value: "SECRET-I" }], postData: { text: "SECRET-J" } }, response: { status: 200, content: { text: "SECRET-K" } } }] } }));
      put(f.artifacts, "storage-state.json", "secret config");
      const list = await f.service.handle("browser.artifacts.list", {}, "chat-a");
      assert.equal(list.ok, true); assert.equal(list.items.length, 2);
      assert.ok(!JSON.stringify(list).includes(f.scope));
      for (const artifact of list.items) {
        const result = await f.service.handle("browser.artifacts.open", { id: artifact.id }, "chat-a");
        assert.equal(result.ok, true); assert.ok(!/SECRET-/.test(JSON.stringify(result)), JSON.stringify(result));
        assert.equal((await f.service.handle("browser.artifacts.open", { id: artifact.id }, "chat-b")).ok, false);
      }
      const id = list.items[0].id;
      f.current.artifacts = path.join(f.scope, "sessions", "two", "browser", "artifacts"); fs.mkdirSync(f.current.artifacts, { recursive: true });
      assert.equal((await f.service.handle("browser.artifacts.open", { id }, "chat-a")).ok, false);
      assert.equal((await f.service.handle("browser.artifacts.open", { id: "../../console.log", path: "/etc/passwd" }, "chat-a")).ok, false);
    } finally { f.dispose(); }
  });
  await run("artifact symlink escapes and root substitution are rejected without exposing file bytes", async () => {
    const f = fixture();
    try {
      const secret = path.join(sandbox, "outside-secret.log"); fs.writeFileSync(secret, "do not expose");
      fs.symlinkSync(secret, path.join(f.artifacts, "escape.log"));
      put(f.artifacts, "valid.log", "safe event\n");
      const list = await f.service.handle("browser.artifacts.list", {}, "chat-a");
      assert.equal(list.items.length, 1);
      const file = path.join(f.artifacts, "valid.log"); fs.unlinkSync(file); fs.symlinkSync(secret, file);
      assert.equal((await f.service.handle("browser.artifacts.open", { id: list.items[0].id }, "chat-a")).ok, false);
      f.current.artifacts = sandbox;
      assert.equal((await f.service.handle("browser.artifacts.list", {}, "chat-a")).status, "blocked");
    } finally { f.dispose(); }
  });
  await run("artifact changes and giant payloads are guarded; raster data previews work on HTTP", async () => {
    const f = fixture();
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lTQAAAAASUVORK5CYII=", "base64");
      put(f.artifacts, "shot.png", png); put(f.artifacts, "large.log", "bounded event\n".repeat(100000)); put(f.artifacts, "giant.png", Buffer.alloc(600 * 1024));
      const list = await f.service.handle("browser.artifacts.list", {}, "chat-a");
      for (const artifact of list.items) {
        const result = await f.service.handle("browser.artifacts.open", { id: artifact.id }, "chat-a");
        assert.equal(result.ok, true); assert.ok(JSON.stringify(result).length < 400_000);
        if (artifact.name === "shot.png") assert.match(result.preview.dataUrl, /^data:image\/png;base64,/);
        if (artifact.name === "large.log") assert.equal(result.preview.truncated, true);
        if (artifact.name === "giant.png") assert.equal(result.preview.kind, "unavailable");
      }
      const log = list.items.find(value => value.name === "large.log"); put(f.artifacts, "large.log", "changed");
      assert.equal((await f.service.handle("browser.artifacts.open", { id: log.id }, "chat-a")).status, "conflict");
    } finally { f.dispose(); }
  });
  await run("artifact enumeration is capped and unknown JSON fields are never dumped", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 110; i++) put(f.artifacts, `${String(i).padStart(3, "0")}.json`, JSON.stringify({ opaque: "UNKNOWN-SECRET", body: "PRIVATE BODY" }));
      const list = await f.service.handle("browser.artifacts.list", {}, "chat-a");
      assert.equal(list.items.length, 100); assert.equal(list.truncated, true);
      const result = await f.service.handle("browser.artifacts.open", { id: list.items[0].id }, "chat-a");
      assert.equal(result.preview.kind, "summary"); assert.ok(!JSON.stringify(result).includes("UNKNOWN-SECRET"));
    } finally { f.dispose(); }
  });
  await run("oversized credential lines are fully redacted, not exposed after a partial regex match", async () => {
    const f = fixture();
    try {
      put(f.artifacts, "console.log", `Authorization: Bearer ${"SECRET".repeat(2500)}\nnext event\n`);
      const list = await f.service.handle("browser.artifacts.list", {}, "chat-a");
      const result = await f.service.handle("browser.artifacts.open", { id: list.items[0].id }, "chat-a");
      assert.equal(result.ok, true); assert.ok(!JSON.stringify(result).includes("SECRET")); assert.match(result.preview.text, /next event/);
    } finally { f.dispose(); }
  });
  await run("Git subprocesses have literal paths, no inherited Git redirection or remote commands", async () => {
    assert.ok(gitCalls.length > 10);
    for (const call of gitCalls) {
      assert.equal(call.env.GIT_LITERAL_PATHSPECS, "1"); assert.equal(call.env.GIT_TERMINAL_PROMPT, "0"); assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
      const root = call.args[call.args.indexOf("-C") + 1]; assert.ok(root.startsWith(sandbox + path.sep));
      for (const prohibited of ["push", "fetch", "pull", "branch", "worktree", "checkout", "reset", "clean", "submodule"]) assert.equal(call.args.includes(prohibited), false, JSON.stringify(call.args));
    }
  });
}

main().catch(error => { failed++; console.error(error.stack || error); }).finally(() => {
  cp.execFile = originalExecFile;
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs; else delete Module._extensions[".ts"];
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`rc-features-check: ${passed} passed, ${failed} failed; temp fixtures removed; no dist/server/worktrees used.`);
  process.exitCode = failed ? 1 : 0;
});

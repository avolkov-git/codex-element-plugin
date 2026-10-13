const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const test = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");

const codeA = "method FromA()\r\n    return 1\r\n;\r\n";
const codeB = codeA.replace("FromA", "FromB");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const unavailable = error => error?.code === "unavailable";
const emptyContext = () => ({ cacheable: false, links: [], snippets: [], documentationQueries: [], diagnostics: [], providers: [], hovers: [] });

// Explicit readiness here models the semantic aggregate contract, not a live LSP.
async function readyContext(request) {
  const result = emptyContext();
  const selected = request.selected.find(item => /\.(xbsl|ya?ml)$/i.test(item.path));
  if (!selected) return result;
  const source = await request.readFile(selected.path);
  result.cacheable = true;
  result.selection = { intent: "implementation", maxDepth: 2, budgetChars: 32000, omittedRanges: 0 };
  result.providers.push({ path: selected.path, ast: /\.xbsl$/i.test(selected.path) ? "ready" : "not-applicable", lsp: "ready" });
  result.snippets.push({ path: selected.path, startLine: 1, endLine: source.endLine, text: source.text,
    source: /\.xbsl$/i.test(selected.path) ? "native-ast" : "yaml", hash: hash(source.text),
    fromOpenDocument: source.fromOpenDocument, truncated: false, purpose: "implementation", depth: 0 });
  result.links.push({ from: { path: selected.path, startLine: 1, endLine: 1 }, name: "FromA", kind: "definition",
    confidence: "lsp", targets: [{ path: selected.path, startLine: 1, endLine: 3 }] });
  result.hovers.push({ path: selected.path, line: 1, text: "method FromA()" });
  result.documentationQueries.push("String");
  return result;
}

function fixture(t, options = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-cache-")));
  const rootA = path.join(temporary, "A");
  const rootB = path.join(temporary, "B");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const fileA = path.join(rootA, "Form.xbsl");
  const fileB = path.join(rootB, "Form.xbsl");
  fs.writeFileSync(fileA, codeA);
  fs.writeFileSync(fileB, codeB);
  for (const [relative, text] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(rootA, relative)), { recursive: true });
    fs.writeFileSync(path.join(rootA, relative), text);
  }
  const listeners = new Map();
  const event = name => listener => {
    const group = listeners.get(name) ?? new Set();
    group.add(listener);
    listeners.set(name, group);
    return { dispose: () => group.delete(listener) };
  };
  const documents = [];
  const reads = [];
  const requests = [];
  const logs = [];
  const hooks = {};
  const workspace = {
    textDocuments: documents, workspaceFolders: [{ uri: uri(rootA) }],
    onDidChangeWorkspaceFolders: event("workspace"),
    onDidChangeTextDocument: event("edit"),
    onDidOpenTextDocument: event("open"),
    onDidCloseTextDocument: event("close"),
    createFileSystemWatcher() {
      const subscriptions = [];
      const subscribe = name => listener => {
        const disposable = event(name)(listener);
        subscriptions.push(disposable);
        return disposable;
      };
      return { dispose: () => subscriptions.forEach(item => item.dispose()),
        onDidCreate: subscribe("create"), onDidChange: subscribe("files"), onDidDelete: subscribe("delete") };
    },
  };
  const mockFs = { ...fs, promises: new Proxy(fs.promises, {
    get(target, operation) {
      const implementation = target[operation];
      if (typeof implementation !== "function") return implementation;
      return async (...args) => {
        if (operation === "readFile") reads.push(String(args[0]));
        await hooks.before?.(operation, args);
        const result = await implementation.apply(target, args);
        await hooks.after?.(operation, args, result);
        return result;
      };
    },
  }) };
  const vscode = { workspace, Uri: { file: uri }, RelativePattern: class {} };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode, fs: mockFs });
  const logger = { info: message => logs.push(message), warn: message => logs.push(message), error: message => logs.push(message) };
  const service = new ProjectContextService({}, path.join(temporary, "config"), logger, {
    async buildContext(request) {
      requests.push(request);
      f.lastResult = await f.build(request);
      return f.lastResult;
    },
  });
  const f = {
    temporary, rootA, rootB, fileA, fileB, service, documents, reads, requests, logs, hooks, listeners,
    build: readyContext,
    search(query = "FromA", searchOptions = {}, profile = "user") { return service.searchTool(profile, query, searchOptions); },
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    switchRoot(root, notify = true) {
      workspace.workspaceFolders = [{ uri: uri(root) }];
      if (notify) f.emit("workspace");
    },
    open(text = codeA, notify = true) {
      const document = { uri: uri(fileA), text, version: 1, isDirty: text !== codeA, isClosed: false, getText() { return this.text; } };
      documents.push(document);
      if (notify) f.emit("open", document);
      return document;
    },
    hits() { return logs.filter(message => message === "Project semantic cache: hit.").length; },
    misses() { return logs.filter(message => message === "Project semantic cache: miss.").length; },
  };
  t.after(() => { service.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return f;
}

test("repeated successful neighbourhood skips providers but revalidates sources and returns isolated clones", async t => {
  const f = fixture(t);
  const first = await f.search();
  const expected = JSON.stringify(first.semantic);
  first.semantic.snippets[0].text = "caller mutation";
  first.semantic.links[0].targets[0].path = "elsewhere";
  f.lastResult.providers[0].lsp = "unavailable";
  f.reads.length = 0;
  const second = await f.search();
  assert.equal(JSON.stringify(second.semantic), expected);
  assert.deepEqual(f.reads, [f.fileA]);
  second.semantic.hovers[0].text = "another mutation";
  second.semantic.documentationQueries.push("bad");
  assert.equal(JSON.stringify((await f.search()).semantic), expected);
  assert.equal(f.requests.length, 1);
  assert.equal(f.hits(), 2);
  assert.equal(f.misses(), 1);
});

test("YAML not-applicable AST and imported implementation neighbourhoods can be cached", async t => {
  const f = fixture(t, { files: { "Form.yaml": "Name: Form\nType: Form\n", "Form.xbsl": `import Example\n${codeA}` } });
  await f.search("FromA");
  await f.search("FromA");
  const yaml = await f.search("Form.yaml");
  assert.equal(yaml.semantic.providers[0].ast, "not-applicable");
  await f.search("Form.yaml");
  assert.equal(f.requests.length, 2);
  assert.equal(f.hits(), 2);
});

test("real semantic aggregation retries partial supplemental LSP, then caches the complete implementation", async t => {
  const code = "method FromA()\n    One()\n    Two()\n    Three()\n    Four()\n;\n";
  const f = fixture(t, { files: { "Form.xbsl": code } });
  const { ProjectSemanticService } = loadSource("src/projectSemanticService.ts", {
    vscode: { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) } },
  });
  const calls = ["One", "Two", "Three", "Four"].map((name, i) => {
    const startOffset = code.indexOf(name);
    return { kind: "StaticMethodInvocation", startOffset, endOffset: startOffset + name.length + 2,
      startLine: i + 2, endLine: i + 2, attributes: {}, role: "statements",
      children: [{ kind: "StaticVariableAccess", role: "prefix", startOffset, endOffset: startOffset + name.length,
        startLine: i + 2, endLine: i + 2, attributes: { name, namespace: [] }, children: [] }] };
  });
  const method = { kind: "Method", role: "methods", startOffset: 0, endOffset: code.length,
    startLine: 1, endLine: 6, attributes: { name: "FromA" }, children: calls };
  const root = { kind: "Module", startOffset: 0, endOffset: code.length, startLine: 1, endLine: 7,
    attributes: {}, children: [method] };
  let ready = false;
  let inspections = 0;
  let supplemental = 0;
  const semantic = new ProjectSemanticService({ parse: async () => ({ status: "ready", root, diagnostics: [] }) }, {
    async inspect(document, positions) {
      inspections++;
      if (positions.length === 1) supplemental++;
      return { status: !ready && positions.length === 1 ? "partial" : "ready", sourceHash: hash(code), truncated: false,
        symbols: [], queries: positions.map(position => ({ position, hover: "method FromA()",
          definitions: [{ uri: document.toString(), startLine: 1, endLine: 6 }] })) };
    },
  }, { info() {}, warn() {}, error() {} });
  f.build = request => semantic.buildContext(request);
  const partial = await f.search();
  assert.equal(partial.semantic.providers[0].lsp, "ready");
  assert.equal(partial.semantic.cacheable, false);
  await f.search();
  assert.equal(f.requests.length, 2);
  assert.ok(supplemental >= 2);
  ready = true;
  const complete = await f.search();
  assert.equal(complete.semantic.cacheable, true);
  assert.equal(complete.semantic.selection.intent, "implementation");
  const before = inspections;
  await f.search();
  assert.equal(inspections, before);
  assert.equal(f.requests.length, 3);
  assert.equal(f.hits(), 1);
});

test("hits validate consulted and returned dependencies, not every indexed XBSL/YAML file", async t => {
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Other${i}.xbsl`, `method Other${i}()\n;\n`]));
  Object.assign(files, { "ReadOnly.xbsl": "method ReadOnly()\n;\n", "Target.xbsl": "method Target()\n;\n",
    "Provider.yaml": "Name: Provider\n", "Hover.xbsl": "method Hover()\n;\n", "Snippet.xbsl": "method Snippet()\n;\n" });
  const f = fixture(t, { files });
  f.build = async request => {
    const result = await readyContext(request);
    await request.readFile("ReadOnly.xbsl");
    result.links[0].targets.push({ path: "Target.xbsl", startLine: 1, endLine: 2 });
    result.providers.push({ path: "Provider.yaml", ast: "not-applicable", lsp: "ready" });
    result.hovers.push({ path: "Hover.xbsl", line: 1, text: "hover" });
    result.snippets.push({ ...result.snippets[0], path: "Snippet.xbsl", text: files["Snippet.xbsl"], hash: hash(files["Snippet.xbsl"]) });
    return result;
  };
  await f.search();
  f.reads.length = 0;
  await f.search();
  assert.deepEqual(f.reads.map(file => path.basename(file)).sort(),
    ["Form.xbsl", "ReadOnly.xbsl", "Target.xbsl", "Provider.yaml", "Hover.xbsl", "Snippet.xbsl"].sort());
  assert.equal(f.requests.length, 1);
});

test("same-size disk rewrites preserving mtime invalidate the hash and force a fresh index", async t => {
  const f = fixture(t);
  const timestamp = new Date("2025-01-01T00:00:00.000Z");
  fs.utimesSync(f.fileA, timestamp, timestamp);
  await f.search();
  const before = fs.statSync(f.fileA);
  fs.writeFileSync(f.fileA, codeB);
  fs.utimesSync(f.fileA, before.atime, before.mtime);
  assert.equal(fs.statSync(f.fileA).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(f.fileA).size, before.size);
  await assert.rejects(f.search(), unavailable);
  assert.equal(f.service.semanticCache.size, 0);
  assert.equal(f.requests.length, 1);
  const fresh = await f.search("FromB");
  assert.equal(fresh.semantic.snippets[0].hash, hash(codeB));
  assert.ok(fresh.chunks.every(chunk => !chunk.preview.includes("FromA")));
  const persisted = JSON.parse(fs.readFileSync(fresh.indexPath, "utf8"));
  assert.equal(persisted.files.find(file => file.path === "Form.xbsl").hash, hash(codeB));
});

test("a changed linked file outside selected chunks is hash-checked on a hit", async t => {
  const f = fixture(t, { files: { "Other.xbsl": codeB } });
  f.build = async request => {
    const result = await readyContext(request);
    result.links[0].targets.push({ path: "Other.xbsl", startLine: 1, endLine: 3 });
    return result;
  };
  await f.search();
  fs.writeFileSync(path.join(f.rootA, "Other.xbsl"), codeA);
  await assert.rejects(f.search(), unavailable);
  assert.equal(f.hits(), 0);
});

test("cache validation cannot bypass symlink containment checks", async t => {
  const f = fixture(t);
  await f.search();
  fs.unlinkSync(f.fileA);
  fs.symlinkSync(f.fileB, f.fileA);
  f.reads.length = 0;
  await assert.rejects(f.search(), error => error?.code === "unsafePath");
  assert.equal(f.reads.includes(f.fileB), false);
  assert.equal(f.service.semanticCache.size, 0);
  assert.equal(f.hits(), 0);
});

test("missing cached sources fail closed and evict the entry", async t => {
  const f = fixture(t);
  await f.search();
  fs.unlinkSync(f.fileA);
  await assert.rejects(f.search());
  assert.equal(f.hits(), 0);
  assert.equal(f.service.semanticCache.size, 0);
});

test("buffer opening, edits, reverts and closing cannot reuse another buffer snapshot", async t => {
  const f = fixture(t);
  await f.search("Form.xbsl");
  const document = f.open(codeA, false);
  assert.equal((await f.search("Form.xbsl")).semantic.snippets[0].fromOpenDocument, true);
  await f.search("Form.xbsl");
  assert.equal(f.requests.length, 2);
  document.text = codeB;
  document.version++;
  assert.equal((await f.search("Form.xbsl")).semantic.snippets[0].text, codeB);
  document.text = codeA;
  document.version++;
  assert.equal((await f.search("Form.xbsl")).semantic.snippets[0].text, codeA);
  document.text = codeB; // Hash also catches hosts that fail to increment version.
  assert.equal((await f.search("Form.xbsl")).semantic.snippets[0].text, codeB);
  document.isClosed = true;
  f.emit("close", document);
  assert.equal((await f.search("Form.xbsl")).semantic.snippets[0].fromOpenDocument, false);
  assert.equal(f.requests.length, 6);
});

test("editor events clear the cache even when text and version are reverted", async t => {
  const f = fixture(t);
  const document = f.open();
  await f.search();
  document.text = codeB;
  f.emit("edit", { document });
  document.text = codeA;
  f.emit("edit", { document });
  assert.equal(f.service.semanticCache.size, 0);
  await f.search();
  assert.equal(f.requests.length, 2);
});

test("exact normalized query, options and selected ranges are part of the cache key", async t => {
  const f = fixture(t);
  await f.search("FromA details");
  await f.search("FromA details");
  await f.search(" details FromA ");
  await f.search("froma details");
  await f.search("FromA details", { maxItems: 1 });
  await f.search("FromA details", { maxPreviewChars: 120 });
  assert.equal(f.requests.length, 5);
  await f.search(" FromA details ");
  assert.equal(f.requests.length, 5); // Preserve the public query.trim() contract.
  f.service.cache.chunks[0].endLine++;
  await f.search("FromA details");
  assert.equal(f.requests.length, 6);
});

test("profiles, workspace roots and workspace revisions never share entries", async t => {
  const f = fixture(t);
  await f.search("Form.xbsl");
  await f.search("Form.xbsl", {}, "other-profile");
  await f.search("Form.xbsl", {}, "user");
  assert.equal(f.requests.length, 3);
  await assert.rejects(f.service.searchTool(undefined, "Form.xbsl"), unavailable);
  f.switchRoot(f.rootB, false);
  const second = await f.search("Form.xbsl");
  assert.equal(second.workspaceRoot, f.rootB);
  assert.equal(second.semantic.snippets[0].text, codeB);
  f.switchRoot(f.rootA);
  await f.search("Form.xbsl");
  f.switchRoot(f.rootB);
  f.switchRoot(f.rootA);
  assert.equal(f.service.semanticCache.size, 0);
  await f.search("Form.xbsl");
  assert.equal(f.requests.length, 6);
});

test("source hashes in a newer index distinguish otherwise identical requests", async t => {
  const f = fixture(t, { files: { "Other.xbsl": codeB } });
  await f.search();
  // Simulate a replacement index snapshot with unchanged selected chunks and no watcher event.
  f.service.cache.files.find(file => file.path === "Other.xbsl").hash = hash(codeA);
  await f.search();
  assert.equal(f.requests.length, 2);
});

for (const event of ["create", "files", "delete"]) {
  test(`${event} source events invalidate cached context but excluded paths do not`, async t => {
    const f = fixture(t);
    await f.search();
    f.emit(event, uri(path.join(f.rootA, "node_modules/pkg/index.js")));
    await f.search();
    assert.equal(f.requests.length, 1);
    f.emit(event, uri(f.fileA));
    assert.equal(f.service.semanticCache.size, 0);
    await f.search();
    assert.equal(f.requests.length, 2);
  });
}

for (const mutation of ["workspace", "files", "buffer", "dispose"]) {
  test(`${mutation} changes during hit validation cannot publish cached snippets`, async t => {
    const f = fixture(t);
    const document = mutation === "buffer" ? f.open() : undefined;
    await f.search();
    f.hooks.after = (operation, args) => {
      if (operation !== "realpath" || args[0] !== f.fileA) return;
      f.hooks.after = undefined;
      if (mutation === "workspace") f.switchRoot(f.rootB);
      if (mutation === "files") f.emit("files", uri(f.fileA));
      if (mutation === "buffer") { document.text = codeB; document.version++; }
      if (mutation === "dispose") f.service.dispose();
    };
    await assert.rejects(f.search(), unavailable);
    assert.equal(f.hits(), 0);
    assert.equal(f.service.semanticCache.size, 0);
  });
}

const ineligible = {
  "missing aggregate readiness": result => { delete result.cacheable; },
  "incomplete supplemental LSP": result => { result.cacheable = false; },
  "empty snippets": result => { result.snippets = []; },
  "empty snippet text": result => { result.snippets[0].text = ""; },
  "empty providers": result => { result.providers = []; },
  "truncated snippet": result => { result.snippets[0].truncated = true; },
  "diagnostics": result => { result.diagnostics.push("provider error"); },
  "context limit": result => { result.selection.omittedRanges = 1; },
  "unavailable AST": result => { result.providers[0].ast = "unavailable"; },
  "failed AST": result => { result.providers[0].ast = "error"; },
  "partial LSP": result => { result.providers[0].lsp = "partial"; },
  "empty LSP": result => { result.providers[0].lsp = "empty"; },
  "unavailable LSP": result => { result.providers[0].lsp = "unavailable"; },
  "timeout LSP": result => { result.providers[0].lsp = "timeout"; },
  "budget-exhausted LSP": result => { result.providers[0].lsp = "budget-exhausted"; },
  "stale snippet hash": result => { result.snippets[0].hash = hash(codeB); },
};
for (const [name, mutate] of Object.entries(ineligible)) {
  test(`${name} is retried without requiring a file event`, async t => {
    const f = fixture(t);
    f.build = async request => { const result = await readyContext(request); mutate(result); return result; };
    await f.search();
    await f.search();
    assert.equal(f.requests.length, 2);
    assert.equal(f.service.semanticCache.size, 0);
    f.build = readyContext;
    await f.search();
    await f.search();
    assert.equal(f.requests.length, 3);
    assert.equal(f.hits(), 1);
  });
}

test("thrown provider errors are not cached", async t => {
  const f = fixture(t);
  f.build = async () => { throw new Error("provider timeout"); };
  await assert.rejects(f.search(), /provider timeout/);
  f.build = readyContext;
  await f.search();
  await f.search();
  assert.equal(f.requests.length, 2);
});

test("caught source read failures cannot become cached completed facts", async t => {
  const f = fixture(t);
  f.build = async request => {
    const result = await readyContext(request);
    try { await request.readFile("missing.xbsl"); } catch { /* Simulate a provider catching an optional read. */ }
    return result;
  };
  await f.search();
  await f.search();
  assert.equal(f.requests.length, 2);
  assert.equal(f.service.semanticCache.size, 0);
});

test("TTL is at most five seconds, is not sliding and is checked after source validation", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const f = fixture(t);
  await f.search();
  now += 4000;
  await f.search();
  assert.equal(f.requests.length, 1);
  now += 1000;
  await f.search();
  assert.equal(f.requests.length, 2);
  f.hooks.after = (operation, args) => {
    if (operation === "readFile" && args[0] === f.fileA) {
      f.hooks.after = undefined;
      now += 5000;
    }
  };
  await f.search();
  assert.equal(f.requests.length, 3);
  assert.equal(f.hits(), 1);
});

test("slow provider results are not stored after the readiness window expires", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const f = fixture(t);
  f.build = async request => { const result = await readyContext(request); now += 5000; return result; };
  await f.search();
  await f.search();
  assert.equal(f.requests.length, 2);
  assert.equal(f.service.semanticCache.size, 0);
});

test("LRU storage is bounded to eight entries and evicts the least recently used", async t => {
  t.mock.method(Date, "now", () => 1000000);
  const f = fixture(t);
  for (let i = 0; i < 8; i++) await f.search(`FromA variant${i}`);
  assert.equal(f.service.semanticCache.size, 8);
  await f.search("FromA variant0");
  await f.search("FromA variant8");
  await f.search("FromA variant0");
  assert.equal(f.requests.length, 9);
  await f.search("FromA variant1");
  assert.equal(f.requests.length, 10);
  assert.equal(f.service.semanticCache.size, 8);
});

test("serialized payload memory is bounded to two MiB and oversized entries are skipped", async t => {
  const f = fixture(t);
  let payloadSize = 300000;
  f.build = async request => {
    const result = await readyContext(request);
    result.hovers[0].text = "x".repeat(payloadSize);
    return result;
  };
  for (let i = 0; i < 5; i++) await f.search(`FromA variant${i}`);
  assert.ok(f.service.semanticCache.size <= 3);
  assert.ok([...f.service.semanticCache.values()].reduce((sum, entry) => sum + entry.bytes, 0) <= 2 * 1024 * 1024);
  await f.search("FromA variant4");
  assert.equal(f.requests.length, 5);
  payloadSize = 2 * 1024 * 1024;
  await f.search("FromA oversized");
  await f.search("FromA oversized");
  assert.equal(f.requests.length, 7);
});

test("neighbourhoods needing more than ten validation paths are not cached", async t => {
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Other${i}.xbsl`, `method Other${i}()\n;\n`]));
  const f = fixture(t, { files });
  f.build = async request => {
    const result = await readyContext(request);
    result.links[0].targets.push(...Object.keys(files).map(file => ({ path: file, startLine: 1, endLine: 2 })));
    return result;
  };
  await f.search();
  await f.search();
  assert.equal(f.requests.length, 2);
  assert.equal(f.service.semanticCache.size, 0);
});

test("dispose clears retained values, unregisters observers and blocks in-flight repopulation", async t => {
  const f = fixture(t);
  await f.search();
  assert.equal(f.service.semanticCache.size, 1);
  f.service.dispose();
  assert.equal(f.service.semanticCache.size, 0);
  assert.ok([...f.listeners.values()].every(group => group.size === 0));
  f.build = async request => { const result = await readyContext(request); f.service.dispose(); return result; };
  await assert.rejects(f.search("FromA new"), unavailable);
  assert.equal(f.service.semanticCache.size, 0);
});

test("unknown identifiers return no hits while intentional overview retrieval remains available", async t => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`Other${i}.xbsl`, `method Other${i}()\n;\n`]));
  const f = fixture(t, { files });
  // The exact benchmark identifier and an overview request, encoded to keep this test ASCII.
  const query = "\u0411\u0435\u043d\u0447\u043c\u0430\u0440\u043a\u041d\u0435\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439\u041c\u0435\u0442\u043e\u04347429";
  const missing = await f.search(query);
  assert.equal(missing.query, query);
  assert.equal(missing.chunks.length, 0);
  assert.equal(missing.semantic.snippets.length, 0);
  assert.equal(missing.semantic.diagnostics.length, 0);
  await f.search(query);
  assert.equal(f.requests.length, 2); // No negative fact is cached.
  const overview = await f.search("\u043e\u0431\u0437\u043e\u0440");
  assert.equal(overview.chunks.length, 5);
  assert.ok(overview.totalChunks > overview.chunks.length);
});

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");

const codeA = "method FromA()\r\n    return 1\r\n;\r\n";
const codeB = "method FromB()\n    return 2\n;\n";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const semanticResult = () => ({ links: [], snippets: [], documentationQueries: [], diagnostics: [], providers: [], hovers: [] });
const unavailable = error => error?.code === "unavailable";
const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Operation remained blocked")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

function pauseIo(f, phase, matches) {
  const reached = gate(), release = gate();
  let paused = false;
  f.hooks[phase] = async (operation, args) => {
    if (!paused && matches(operation, args)) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
  };
  return { reached: reached.promise, release: release.resolve };
}

test("rule targets retain indexed XBSL and object modules without guessing ambiguous element kinds", () => {
  const { projectRuleTargets } = loadSource("src/projectContextService.ts", { vscode: {} });
  const element = kind => ({ element: { kind } });
  const files = [
    { path: "Form.yaml", structure: element("Component") }, { path: "Form.xbsl" }, { path: "Form.Объект.xbsl" },
    { path: "Ambiguous.yaml", structure: element("Component") }, { path: "Ambiguous.yml", structure: element("Module") },
    { path: "Ambiguous.xbsl" }, { path: "CodeOnly.xbsl" }
  ];
  const targets = projectRuleTargets(files, ["Form.xbsl", "Form.Объект.xbsl", "Ambiguous.xbsl", "CodeOnly.xbsl", "Missing.xbsl", "Form.xbsl"]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), [
    { path: "Form.xbsl", elementKind: "Component" }, { path: "Form.Объект.xbsl", elementKind: "Component" },
    { path: "Ambiguous.xbsl" }, { path: "CodeOnly.xbsl" }
  ]);
});

test("rule targets resolve known module families without assigning kinds to arbitrary suffixes", () => {
  const { projectRuleTargets } = loadSource("src/projectContextService.ts", { vscode: {} });
  const files = [
    { path: "register/Status.yaml", structure: { element: { kind: "Register" } } },
    { path: "register/Status.НаборЗаписей.xbsl" }, { path: "register/Status.RecordSet.xbsl" },
    { path: "constant/Settings.yml", structure: { element: { kind: "Constant" } } },
    { path: "constant/Settings.Запись.xbsl" }, { path: "constant/Settings.Record.xbsl" },
    { path: "constant/Settings.Custom.XBSL" }, { path: "elsewhere/Status.НаборЗаписей.xbsl" }
  ];
  const modules = files.filter(file => /\.xbsl$/i.test(file.path)).map(file => file.path);
  const targets = projectRuleTargets(files, modules);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), modules.map(filePath => ({ path: filePath,
    ...(filePath.startsWith("register/") ? { elementKind: "Register" }
      : filePath.startsWith("constant/") && !filePath.includes(".Custom.") ? { elementKind: "Constant" } : {})
  })));
  assert.deepEqual(Array.from(projectRuleTargets(files, ["register/Status.yaml", "constant/Settings.yml"]), target => target.path),
    files.slice(0, -2).map(file => file.path));
});

function fixture(t, options = {}) {
  // IO race hooks compare with the native canonical paths used by the service.
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "project-snapshot-")));
  const rootA = path.join(temporary, "A");
  const rootB = path.join(temporary, "B");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const fileA = path.join(rootA, "Form.xbsl");
  const fileB = path.join(rootB, "Form.xbsl");
  fs.writeFileSync(fileA, options.codeA ?? codeA);
  fs.writeFileSync(fileB, codeB);
  const listeners = new Map();
  const event = name => listener => {
    const group = listeners.get(name) ?? new Set();
    group.add(listener);
    listeners.set(name, group);
    return { dispose: () => group.delete(listener) };
  };
  const documents = [];
  const calls = [];
  const hooks = { before: undefined, after: undefined };
  const workspace = {
    textDocuments: documents, workspaceFolders: [{ uri: uri(rootA) }],
    onDidChangeWorkspaceFolders: event("workspace"),
    onDidOpenTextDocument: event("open"), onDidChangeTextDocument: event("edit"),
    onDidCloseTextDocument: event("close"), onDidSaveTextDocument: event("save"),
    createFileSystemWatcher: () => ({
      dispose() {}, onDidCreate: event("create"), onDidChange: event("files"), onDidDelete: event("delete"),
    }),
  };
  const mockFs = { ...fs, promises: new Proxy(fs.promises, {
    get(target, operation) {
      const implementation = target[operation];
      if (typeof implementation !== "function") return implementation;
      return async (...args) => {
        calls.push({ operation, args });
        await hooks.before?.(operation, args);
        const result = await implementation.apply(target, args);
        await hooks.after?.(operation, args, result);
        return result;
      };
    },
  }) };
  const vscode = { workspace, Uri: { file: uri }, RelativePattern: class {} };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode, fs: mockFs });
  const semantic = options.semantic ? { buildContext: request => options.semantic(f, request) } : undefined;
  const service = new ProjectContextService({}, path.join(temporary, "config"), logger, semantic);
  const f = {
    rootA, rootB, fileA, fileB, service, documents, calls, hooks,
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    switchRoot(root, notify = true) {
      workspace.workspaceFolders = [{ uri: uri(root) }];
      if (notify) f.emit("workspace");
    },
    open(text = codeA, isDirty = true, file = fileA) {
      const document = { uri: uri(file), text, version: 1, isDirty, isClosed: false, getText() { return this.text; } };
      documents.push(document);
      return document;
    },
  };
  t.after(() => { service.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return f;
}

test("change snapshots are detached and force-refresh detects stat-preserving shell rewrites", async t => {
  const f = fixture(t);
  const before = await f.service.captureChangeSnapshot("user", true);
  const stat = fs.statSync(f.fileA);
  const changed = codeA.replace("FromA", "FromZ");
  fs.writeFileSync(f.fileA, changed);
  fs.utimesSync(f.fileA, stat.atime, stat.mtime);
  const after = await f.service.captureChangeSnapshot("user", true);
  assert.equal(before.files[0].hash, hash(codeA));
  assert.equal(after.files[0].hash, hash(changed));
  assert.equal(before.isCurrent(), true, "baseline scope survives expected file edits");
  assert.equal((await after.readFile("Form.xbsl")).text, changed);
  await assert.rejects(before.readFile("Form.xbsl"), unavailable);
});

for (const cancellable of [false, true]) {
  test(`overlapping forced refresh rereads edits after the previous scan (signal: ${cancellable})`, async t => {
    const f = fixture(t);
    const baseline = await f.service.captureChangeSnapshot("user", true);
    const blocked = pauseIo(f, "after", (op, args) => op === "readFile" && args[0] === f.fileA);
    const controller = new AbortController();
    const background = f.service.captureChangeSnapshot("user", true, cancellable ? controller.signal : undefined);
    let fresh;
    try {
      await promptly(blocked.reached);
      const changed = codeA.replace("FromA", "FromZ");
      const stat = fs.statSync(f.fileA);
      fs.writeFileSync(f.fileA, changed);
      fs.utimesSync(f.fileA, stat.atime, stat.mtime);
      const reads = f.calls.filter(call => call.operation === "readFile" && call.args[0] === f.fileA).length;
      fresh = f.service.captureChangeSnapshot("user", true, cancellable ? controller.signal : undefined);
      blocked.release();
      await promptly(background);
      const after = await promptly(fresh);
      assert.equal(baseline.files[0].hash, hash(codeA));
      assert.equal(after.files[0].hash, hash(changed));
      assert.equal((await after.readFile("Form.xbsl")).text, changed);
      assert.ok(f.calls.filter(call => call.operation === "readFile" && call.args[0] === f.fileA).length > reads);
    } finally {
      blocked.release();
      await Promise.allSettled([background, fresh]);
    }
  });
}

for (const state of ["empty-on-disk", "new-on-disk", "missing-on-disk", "same-as-index"]) {
  test(`new dirty buffer invalidates snapshot freshness (${state})`, async t => {
    const f = fixture(t);
    const file = state === "same-as-index" ? f.fileA : path.join(f.rootA, "New.yaml");
    const text = state === "same-as-index" ? codeA : "Name: New\nElementKind: Structure\n";
    if (state === "empty-on-disk") fs.writeFileSync(file, "");
    const before = await f.service.captureChangeSnapshot("user", true);
    if (state === "new-on-disk") fs.writeFileSync(file, text);
    const doc = f.open(text, true, file);
    f.emit("open", doc);
    f.emit("edit", { document: doc });
    assert.equal(before.isContentCurrent(), false, "new dirty buffers are part of the freshness guard, including unindexed paths");
    assert.equal(before.isCurrent(), true, "baseline workspace identity survives edits");
    await assert.rejects(before.readFile("Form.xbsl"), unavailable);
    if (state !== "missing-on-disk") {
      const after = await f.service.captureChangeSnapshot("user", true);
      assert.equal(after.files.find(entry => entry.path === path.basename(file)).hash, hash(text));
    }
  });
}

test("new dirty buffer during semantic analysis cannot publish an obsolete source set", async t => {
  const f = fixture(t, { semantic: async f => {
    const doc = f.open("Name: New\nElementKind: Structure\n", true, path.join(f.rootA, "New.yaml"));
    f.emit("open", doc);
    return semanticResult();
  } });
  fs.writeFileSync(path.join(f.rootA, "New.yaml"), "");
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
});

test("excluded new buffers do not invalidate change snapshots", async t => {
  const f = fixture(t);
  const snapshot = await f.service.captureChangeSnapshot("user", true);
  for (const file of [path.join(f.rootA, ".env.local"), path.join(f.rootA, "dist/Generated.xbsl"), f.fileB]) {
    const doc = f.open(codeB, true, file);
    f.emit("open", doc);
  }
  assert.equal(snapshot.isContentCurrent(), true);
});

test("pre-cancelled snapshot requests perform no IO and do not dirty a warm index", async t => {
  const f = fixture(t);
  await f.service.captureChangeSnapshot("user");
  const controller = new AbortController();
  controller.abort();
  const calls = f.calls.length;
  await assert.rejects(f.service.captureChangeSnapshot("user", true, controller.signal), unavailable);
  await f.service.listSymbolsTool("user");
  assert.equal(f.calls.length, calls);
});

for (const phase of ["load", "readdir", "stat", "readFile"]) {
  test(`cancelling stalled ${phase} releases the refresh queue without late publication`, async t => {
    const f = fixture(t);
    await f.service.captureChangeSnapshot("user", true);
    const matches = (op, args) => phase === "load"
      ? op === "readFile" && String(args[0]).endsWith("project-index-v3.json")
      : op === phase && args[0] === (phase === "readdir" ? f.rootA : f.fileA);
    const blocked = pauseIo(f, phase === "load" ? "before" : "after", matches);
    const controller = new AbortController();
    const pending = f.service.captureChangeSnapshot(phase === "load" ? "other" : "user", true, controller.signal);
    const rejection = assert.rejects(pending, unavailable);
    try {
      await promptly(blocked.reached);
      controller.abort();
      await promptly(rejection);
      const changed = codeA.replace("FromA", "FromZ");
      fs.writeFileSync(f.fileA, changed);
      const fresh = await promptly(f.service.listSymbolsTool("user"));
      assert.ok(fresh.symbols.some(symbol => symbol.name === "FromZ"), "next caller finishes before releasing the obsolete IO");
      const calls = f.calls.length;
      blocked.release();
      await tick(); await tick();
      const warm = await f.service.captureChangeSnapshot("user");
      assert.equal(warm.files[0].hash, hash(changed));
      assert.equal(f.calls.length, calls, "late IO cannot resume scanning or replace the current cache");
      const persisted = JSON.parse(fs.readFileSync(fresh.indexPath, "utf8"));
      assert.equal(persisted.files[0].hash, hash(changed));
    } finally {
      controller.abort(); blocked.release(); await rejection;
      await tick();
    }
  });
}

test("cancelling a queued caller neither cancels nor bypasses another caller's refresh", async t => {
  const f = fixture(t);
  await f.service.captureChangeSnapshot("user", true);
  const blocked = pauseIo(f, "after", (op, args) => op === "readFile" && args[0] === f.fileA);
  const activeController = new AbortController(), queuedController = new AbortController();
  const active = f.service.captureChangeSnapshot("user", true, activeController.signal);
  let queued, next;
  try {
    await promptly(blocked.reached);
    queued = f.service.captureChangeSnapshot("user", true, queuedController.signal);
    const rejected = assert.rejects(queued, unavailable);
    queuedController.abort();
    await promptly(rejected);
    const calls = f.calls.length;
    next = f.service.captureChangeSnapshot("user", true);
    await tick();
    assert.equal(f.calls.length, calls, "the next caller cannot bypass the still-running refresh");
    blocked.release();
    assert.equal((await promptly(active)).files[0].hash, hash(codeA));
    assert.equal((await promptly(next)).files[0].hash, hash(codeA));
  } finally {
    activeController.abort(); blocked.release();
    await Promise.allSettled([active, queued, next]);
  }
});

test("cancellable refreshes never start an uninterruptible index publication", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const snapshot = await f.service.captureChangeSnapshot("user", true, controller.signal);
  assert.equal(snapshot.files[0].hash, hash(codeA));
  assert.ok(!f.calls.some(call => ["mkdir", "writeFile", "rename"].includes(call.operation)));
  controller.abort();
  assert.equal((await snapshot.readFile("Form.xbsl")).text, codeA, "completed snapshots do not retain the capture deadline");
});

test("ordinary requests lazily persist a completed cancellable refresh without rescanning", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  await f.service.captureChangeSnapshot("user", true, controller.signal);
  const before = f.calls.length;
  const result = await f.service.listSymbolsTool("user");
  assert.ok(f.calls.slice(before).some(call => call.operation === "rename"));
  assert.ok(!f.calls.slice(before).some(call => ["readFile", "readdir", "stat"].includes(call.operation)));
  assert.equal(JSON.parse(fs.readFileSync(result.indexPath, "utf8")).files[0].hash, hash(codeA));
});

test("cancelling overlay path validation stops additional IO without poisoning the disk index", async t => {
  const f = fixture(t);
  f.open(codeB);
  const blocked = pauseIo(f, "after", op => op === "realpath");
  const controller = new AbortController();
  const pending = f.service.captureChangeSnapshot("user", true, controller.signal);
  const rejected = assert.rejects(pending, unavailable);
  try {
    await promptly(blocked.reached);
    controller.abort();
    await promptly(rejected);
    const snapshot = await promptly(f.service.captureChangeSnapshot("user"));
    assert.equal(snapshot.files[0].hash, hash(codeB));
    const calls = f.calls.length;
    blocked.release(); await tick();
    assert.equal(f.calls.length, calls);
  } finally { controller.abort(); blocked.release(); await rejected; }
});

for (const phase of ["realpath", "stat", "readFile"]) {
  test(`snapshot read cancellation stops stalled ${phase} and leaves independent readers usable`, async t => {
    const f = fixture(t);
    const snapshot = await f.service.captureChangeSnapshot("user", true);
    const blocked = pauseIo(f, "after", (op, args) => op === phase
      && args[0] === (phase === "realpath" ? f.rootA : f.fileA));
    const controller = new AbortController();
    const pending = snapshot.readFile("Form.xbsl", controller.signal);
    const rejected = assert.rejects(pending, unavailable);
    try {
      await promptly(blocked.reached);
      controller.abort();
      await promptly(rejected);
      assert.equal((await promptly(snapshot.readFile("Form.xbsl"))).text, codeA);
      assert.equal(snapshot.isContentCurrent(), true);
      const calls = f.calls.length;
      blocked.release(); await tick();
      assert.equal(f.calls.length, calls, "cancelled reads cannot resume hash validation or more IO");
    } finally { controller.abort(); blocked.release(); await rejected; }
  });
}

test("change snapshot rejects workspace away/back and non-snapshot paths", async t => {
  const f = fixture(t);
  const snapshot = await f.service.captureChangeSnapshot("user");
  await assert.rejects(snapshot.readFile("../B/Form.xbsl"));
  f.switchRoot(f.rootB); f.switchRoot(f.rootA);
  assert.equal(snapshot.isCurrent(), false);
  await assert.rejects(snapshot.readFile("Form.xbsl"), unavailable);
});

test("change snapshots honor unsaved editor text and exclude its mutation after capture", async t => {
  const f = fixture(t);
  const doc = f.open(codeA.replace("FromA", "Local"));
  const snapshot = await f.service.captureChangeSnapshot("user", true);
  assert.equal(snapshot.files[0].hash, hash(doc.text));
  assert.equal((await snapshot.readFile("Form.xbsl")).text, doc.text);
  doc.text = codeB; doc.version++;
  assert.equal(snapshot.isCurrent(), true, "baseline scope remains usable");
  assert.equal(snapshot.isContentCurrent(), false, "result revision must be invalidated even before any reads");
  await assert.rejects(snapshot.readFile("Form.xbsl"), unavailable);
});

test("full reads preserve raw CRLF bytes and the hash used by Language Server", async t => {
  const f = fixture(t);
  const result = await f.service.readFileTool("user", { filePath: "Form.xbsl" });
  assert.equal(result.text, codeA);
  assert.equal(hash(result.text), hash(fs.readFileSync(f.fileA, "utf8")));
  assert.equal(result.truncated, false);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 4);
  assert.equal(result.totalLines, 4);
  assert.equal(result.fromOpenDocument, false);
});

test("full editor reads preserve mixed line endings and do not invent a final newline", async t => {
  const f = fixture(t);
  const text = "method Unsaved()\r\n    return 3\n;";
  f.open(text);
  const result = await f.service.readFileTool("user", { filePath: "Form.xbsl", startLine: 1, endLine: 3 });
  assert.equal(result.text, text);
  assert.equal(hash(result.text), hash(text));
  assert.equal(result.fromOpenDocument, true);
  const partial = await f.service.readFileTool("user", { filePath: "Form.xbsl", startLine: 2, endLine: 2 });
  assert.equal(partial.text, "    return 3");
  assert.equal(partial.startLine, 2);
  assert.equal(partial.endLine, 2);
});

test("semantic reads use the same raw source revision as the index", async t => {
  let observed;
  const f = fixture(t, { semantic: async (_f, request) => {
    const source = await request.readFile("Form.xbsl");
    observed = { raw: source.text, indexHash: request.files.find(file => file.path === "Form.xbsl").hash };
    return semanticResult();
  } });
  await f.service.searchTool("user", "FromA");
  assert.equal(observed.raw, codeA);
  assert.equal(hash(observed.raw), observed.indexHash);
});

test("open buffers remain authoritative when the workspace path contains a symlink", async t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.rootA), "AliasA");
  fs.symlinkSync(f.rootA, alias, process.platform === "win32" ? "junction" : "dir");
  f.switchRoot(alias);
  const text = codeA.replace("FromA", "Unsaved");
  f.open(text, true, path.join(alias, "Form.xbsl"));
  const result = await f.service.readFileTool("user", { filePath: "Form.xbsl" });
  assert.equal(result.fromOpenDocument, true);
  assert.equal(result.text, text);
  const search = await f.service.searchTool("user", "Unsaved");
  assert.ok(search.chunks.some(chunk => chunk.preview.includes("Unsaved")));
});

test("workspace change during initial index loading rejects search before reading another workspace", async t => {
  const f = fixture(t);
  f.hooks.before = (operation, args) => {
    if (operation === "readFile" && String(args[0]).endsWith("project-index-v3.json")) {
      f.hooks.before = undefined;
      f.switchRoot(f.rootB);
    }
  };
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  assert.equal(f.calls.some(call => call.args[0] === f.fileB), false);
});

test("captured semantic read refuses a changed workspace even when the provider catches the error", async t => {
  let readError;
  const f = fixture(t, { semantic: async (f, request) => {
    f.switchRoot(f.rootB);
    try { await request.readFile("Form.xbsl"); } catch (error) { readError = error; }
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  assert.equal(readError.code, "unavailable");
  assert.equal(f.calls.some(call => call.args[0] === f.fileB), false);
});

test("search verifies the captured root after the final semantic await", async t => {
  let readText;
  const f = fixture(t, { semantic: async (f, request) => {
    readText = (await request.readFile("Form.xbsl")).text;
    f.switchRoot(f.rootB, false);
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  assert.equal(readText, codeA);
});

test("switching A to B and back still invalidates the in-flight request", async t => {
  const f = fixture(t, { semantic: async f => {
    f.switchRoot(f.rootB);
    f.switchRoot(f.rootA);
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
});

test("listSymbols does not return an overlay resolved after the workspace changed", async t => {
  const f = fixture(t);
  await f.service.searchTool("user", "FromA");
  f.open(codeA.replace("FromA", "Unsaved"));
  f.hooks.after = (operation, args) => {
    if (operation === "realpath" && args[0] === f.rootA) {
      f.hooks.after = undefined;
      f.switchRoot(f.rootB);
    }
  };
  await assert.rejects(f.service.listSymbolsTool("user", { query: "Unsaved" }), unavailable);
});

test("standalone read rejects a workspace change while file content is being read", async t => {
  const f = fixture(t);
  await f.service.searchTool("user", "FromA");
  f.hooks.after = (operation, args) => {
    if (operation === "readFile" && args[0] === f.fileA) {
      f.hooks.after = undefined;
      f.switchRoot(f.rootB);
    }
  };
  await assert.rejects(f.service.readFileTool("user", { filePath: "Form.xbsl" }), unavailable);
});

test("an edit during semantic analysis invalidates old snippets and old search chunks", async t => {
  const f = fixture(t, { semantic: async (f, request) => {
    const source = await request.readFile("Form.xbsl");
    assert.equal(source.text, codeA);
    f.documents[0].text = codeB;
    // Also catch hosts/mocks that did not increment the document version.
    return semanticResult();
  } });
  f.open();
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
});

test("buffer changes during overlay path resolution invalidate listSymbols", async t => {
  const f = fixture(t);
  await f.service.searchTool("user", "FromA");
  const document = f.open(codeA.replace("FromA", "Unsaved"));
  f.hooks.after = (operation, args) => {
    if (operation === "realpath" && args[0] === f.fileA) {
      f.hooks.after = undefined;
      document.text = codeB;
      document.version += 1;
    }
  };
  await assert.rejects(f.service.listSymbolsTool("user", { query: "Unsaved" }), unavailable);
});

test("clean editor buffers override an older disk index, but are not persisted", async t => {
  const f = fixture(t);
  const first = await f.service.searchTool("user", "FromA");
  f.open(codeB, false);
  const symbols = await f.service.listSymbolsTool("user", { query: "FromB" });
  assert.ok(symbols.symbols.some(symbol => symbol.name === "FromB"));
  assert.ok(symbols.symbols.every(symbol => symbol.name !== "FromA"));
  const search = await f.service.searchTool("user", "FromB");
  assert.ok(search.chunks.some(chunk => chunk.preview.includes("FromB")));
  assert.ok(search.chunks.every(chunk => !chunk.preview.includes("FromA")));
  assert.equal(fs.readFileSync(first.indexPath, "utf8").includes("FromB"), false);
});

test("empty and oversized editor buffers cannot fall back to stale disk declarations", async t => {
  const f = fixture(t);
  await f.service.searchTool("user", "FromA");
  const document = f.open("");
  assert.equal((await f.service.listSymbolsTool("user", { query: "FromA" })).symbols.length, 0);
  document.text = " ".repeat(256 * 1024 + 1);
  document.version += 1;
  const search = await f.service.searchTool("user", "FromA");
  assert.equal(search.chunks.length, 0);
});

test("newly opened buffers are checked against selected index revisions", async t => {
  const f = fixture(t, { semantic: async f => {
    f.open(codeB, false);
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
});

test("opening an unchanged document for LSP does not invalidate the request", async t => {
  const f = fixture(t, { semantic: async f => {
    f.open(codeA, false);
    return semanticResult();
  } });
  const result = await f.service.searchTool("user", "FromA");
  assert.ok(result.chunks.length > 0);
});

test("a detected disk revision mismatch invalidates search even if semantic catches it", async t => {
  let readError;
  const f = fixture(t, { semantic: async (f, request) => {
    fs.writeFileSync(f.fileA, codeB);
    try { await request.readFile("Form.xbsl"); } catch (error) { readError = error; }
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  assert.equal(readError.code, "unavailable");
});

test("a same-size rewrite with preserved mtime is reindexed after a hash mismatch", async t => {
  let changed = false;
  let observed;
  const updated = codeA.replace("FromA", "FromB");
  const f = fixture(t, { semantic: async (f, request) => {
    if (!changed) {
      changed = true;
      const stat = fs.statSync(f.fileA);
      fs.writeFileSync(f.fileA, updated);
      fs.utimesSync(f.fileA, stat.atime, stat.mtime);
      const next = fs.statSync(f.fileA);
      assert.equal(next.size, stat.size);
      assert.equal(next.mtimeMs, stat.mtimeMs);
    }
    try {
      const source = await request.readFile("Form.xbsl");
      observed = { source: source.text, hash: request.files.find(file => file.path === "Form.xbsl").hash };
    } catch (error) { assert.equal(error.code, "unavailable"); }
    return semanticResult();
  } });
  // Whole-second timestamps round-trip exactly on every supported filesystem.
  const timestamp = new Date("2025-01-01T00:00:00.000Z");
  fs.utimesSync(f.fileA, timestamp, timestamp);
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  const result = await f.service.searchTool("user", "FromB");
  assert.equal(observed.source, updated);
  assert.equal(observed.hash, hash(updated));
  assert.ok(result.chunks.some(chunk => chunk.preview.includes("FromB")));
  assert.ok(result.chunks.every(chunk => !chunk.preview.includes("FromA")));
  const persisted = JSON.parse(fs.readFileSync(result.indexPath, "utf8"));
  assert.equal(persisted.files.find(file => file.path === "Form.xbsl").hash, hash(updated));
});

test("filesystem changes during semantic analysis invalidate the captured index", async t => {
  const f = fixture(t, { semantic: async f => {
    f.emit("files");
    return semanticResult();
  } });
  await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
});

for (const event of ["create", "files", "delete"]) {
  test(`excluded watcher ${event} events do not cancel context or dirty the index`, async t => {
    const f = fixture(t, { semantic: async f => {
      for (const relative of [".git/index.lock", "node_modules/pkg/index.js", "dist/bundle.js", "nested/.env.local", "private.key", "assets/image.PNG"]) {
        f.emit(event, uri(path.join(f.rootA, relative)));
      }
      f.emit(event, uri(f.fileB));
      f.emit(event, { ...uri(f.fileA), scheme: "git" });
      return semanticResult();
    } });
    const result = await f.service.searchTool("user", "FromA");
    assert.ok(result.chunks.some(chunk => chunk.preview.includes("FromA")));
    const scans = f.calls.filter(call => call.operation === "readdir").length;
    await f.service.listSymbolsTool("user");
    assert.equal(f.calls.filter(call => call.operation === "readdir").length, scans);
  });

  test(`source watcher ${event} events still invalidate the captured context`, async t => {
    const f = fixture(t, { semantic: async f => {
      f.emit(event, uri(f.fileA));
      return semanticResult();
    } });
    await assert.rejects(f.service.searchTool("user", "FromA"), unavailable);
  });
}

test("read validates an editor opened with newer text during disk IO", async t => {
  const f = fixture(t);
  await f.service.searchTool("user", "FromA");
  f.hooks.after = (operation, args) => {
    if (operation === "readFile" && args[0] === f.fileA) {
      f.hooks.after = undefined;
      f.open(codeB);
    }
  };
  await assert.rejects(f.service.readFileTool("user", { filePath: "Form.xbsl" }), unavailable);
});

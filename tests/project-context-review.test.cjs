const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const test = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");

const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const uri = file => ({ scheme: "file", fsPath: file, toString: () => pathToFileURL(file).href });
const method = (name, marker) => `method ${name}()\n    return "${marker}"\n;`;
const sql = "-- PostInvoice migration\nUPDATE invoices SET ledger = 4100;\n";
const changedSql = sql.replace("4100", "5100");
const unavailable = error => error?.code === "unavailable";
const preview = result => result.chunks.map(chunk => chunk.preview).join("\n");
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

function fixture(t, files = {}, options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-context-review-")));
  const root = path.join(home, "workspace");
  fs.mkdirSync(root);
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  for (const [relative, text] of Object.entries(files)) write(relative, text);
  const listeners = new Map(), reads = [], hooks = {}, logs = [], documents = [];
  const event = name => listener => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return { dispose() { listeners.get(name).delete(listener); } };
  };
  const workspace = {
    workspaceFolders: [{ uri: uri(root) }], textDocuments: documents,
    onDidChangeWorkspaceFolders: event("workspace"), onDidOpenTextDocument: event("open"),
    onDidChangeTextDocument: event("edit"), onDidCloseTextDocument: event("close"),
    ...(options.saveEvent === false ? {} : { onDidSaveTextDocument: event("save") }),
    createFileSystemWatcher() {
      return { dispose() {}, onDidCreate: event("create"), onDidChange: event("change"), onDidDelete: event("delete") };
    },
  };
  const vscode = { workspace, RelativePattern: class {}, Uri: { file: uri, parse: text => uri(fileURLToPath(text)) } };
  const mockFs = { ...fs, promises: new Proxy(fs.promises, { get(target, operation) {
    const implementation = target[operation];
    if (typeof implementation !== "function") return implementation;
    return async (...args) => {
      if (operation === "readFile") reads.push(String(args[0]));
      await hooks.before?.(operation, args);
      const result = await implementation.apply(target, args);
      await hooks.after?.(operation, args, result);
      return result;
    };
  } }) };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode, fs: mockFs });
  let semantic;
  if (options.semantic) {
    const { ProjectSemanticService } = loadSource("src/projectSemanticService.ts", { vscode });
    semantic = new ProjectSemanticService({ parse: async () => ({ status: "unavailable", diagnostics: [] }) },
      { inspect: async () => ({ status: "ready", symbols: [], queries: [] }) }, logger);
  }
  const service = new ProjectContextService({}, path.join(home, "config"), {
    info: message => logs.push(message), warn() {}, error() {},
  }, semantic);
  const f = {
    home, root, workspace, service, reads, hooks, logs, documents, write,
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value); },
    changed(relative, type = "change") { f.emit(type, uri(path.join(root, relative))); },
    search(query, profile = "finance", opts = {}) { return service.searchTool(profile, query, opts); },
    open(relative, text) {
      const doc = { uri: uri(path.join(root, relative)), text, version: 1, isDirty: true, isClosed: false,
        getText() { return this.text; } };
      documents.push(doc); f.emit("open", doc); return doc;
    },
    close(doc) { doc.isClosed = true; documents.splice(documents.indexOf(doc), 1); f.emit("close", doc); },
  };
  t.after(() => { service.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return f;
}

function stableTime(file) {
  const timestamp = new Date("2026-09-01T00:00:00Z");
  fs.utimesSync(file, timestamp, timestamp);
}

function replaceSameStat(f, relative, text) {
  const file = path.join(f.root, relative), before = fs.statSync(file);
  f.write(relative, text); fs.utimesSync(file, before.atime, before.mtime);
  const after = fs.statSync(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  f.changed(relative);
}

test("watcher same-stat changes refresh only the changed source and survive profile reload", async t => {
  const relative = "migrations/017-ledger.sql";
  const f = fixture(t, { [relative]: sql, "invoices/Posting.xbsl": method("PostInvoice", "unchanged") });
  stableTime(path.join(f.root, relative));
  await f.search("PostInvoice", "audit"); await f.search("PostInvoice", "finance");
  replaceSameStat(f, relative, changedSql);
  f.reads.length = 0;
  assert.ok(preview(await f.search("PostInvoice")).includes("5100"));
  assert.deepEqual(f.reads.filter(file => file.startsWith(f.root)), [path.join(f.root, relative)]);
  assert.ok(preview(await f.search("PostInvoice", "audit")).includes("5100"));
  assert.ok(preview(await f.search("PostInvoice", "finance")).includes("5100"));
  f.reads.length = 0; await f.search("PostInvoice");
  assert.equal(f.reads.length, 0, "a stable warm index does not reread the project");
});

test("non-snippet type registry is refreshed before semantic resolution and caching", async t => {
  const target = "migrations/LedgerType.yaml";
  const f = fixture(t, {
    "project.yaml": "Name: Invoices\nElementKind: Project\n",
    "invoices/InvoiceCard.yaml": "Name: InvoiceCard\nElementKind: Component\nType: InvoiceLedger\n",
    [target]: "Name: DormantLedger\nElementKind: Structure\n",
  }, { semantic: true });
  stableTime(path.join(f.root, target));
  const first = await f.search("InvoiceCard", "finance", { maxItems: 1 });
  assert.ok(first.semantic.links.some(link => link.name === "InvoiceLedger" && !link.targets.length));
  assert.ok(first.semantic.providers.every(provider => provider.path !== target));
  await f.search("InvoiceCard", "finance", { maxItems: 1 });
  replaceSameStat(f, target, "Name: InvoiceLedger\nElementKind: Structure\n");
  for (let i = 0; i < 2; i++) {
    const result = await f.search("InvoiceCard", "finance", { maxItems: 1 });
    assert.ok(result.semantic.links.some(link => link.name === "InvoiceLedger" && link.targets.some(item => item.path === target)));
  }
  assert.ok(f.logs.filter(line => line === "Project semantic cache: hit.").length >= 2);
});

for (const phase of ["writeFile", "rename"]) {
  test(`index publication rejects a file event during ${phase} before mixing a newer buffer`, async t => {
    const relative = "migrations/017-ledger.sql", code = "invoices/Posting.xbsl";
    const f = fixture(t, { [relative]: sql, [code]: method("PostInvoice", "disk") });
    await f.search("PostInvoice"); f.changed(relative);
    let queued;
    f.hooks.after = async (operation, args) => {
      if (operation !== phase || !String(args[0]).endsWith(".tmp")) return;
      f.hooks.after = undefined;
      f.write(relative, changedSql); f.changed(relative);
      f.open(code, method("PostInvoice", "edited"));
      queued = settled(f.search("PostInvoice", "audit"));
    };
    await assert.rejects(f.search("PostInvoice"), unavailable);
    assert.ok(queued, "publication barrier was exercised");
    const next = await queued;
    assert.ifError(next.error);
    assert.ok(preview(next.value).includes("5100")); assert.ok(preview(next.value).includes("edited"));
    const again = await f.search("PostInvoice");
    assert.ok(preview(again).includes("5100")); assert.ok(!preview(again).includes("4100"));
    const persisted = fs.readFileSync(again.indexPath, "utf8");
    assert.ok(persisted.includes("5100")); assert.ok(!persisted.includes("edited"));
  });
}

test("repeated changes during scan fail once per request without an unbounded rebuild loop", async t => {
  const f = fixture(t, { "invoices/Posting.xbsl": method("PostInvoice", "disk") });
  let scans = 0;
  f.hooks.after = operation => { if (operation === "readdir") { scans++; f.changed("invoices/Posting.xbsl"); } };
  await assert.rejects(f.search("PostInvoice"), unavailable);
  assert.equal(scans, 1);
  f.hooks.after = undefined;
  assert.ok((await f.search("PostInvoice")).chunks.length);
});

test("interrupted loading cannot assign another workspace index to the current cache path", async t => {
  const relative = "invoices/Posting.xbsl", original = method("PostInvoice", "left"), other = method("PostInvoice", "next");
  const f = fixture(t, { [relative]: original });
  const secondRoot = path.join(f.home, "other-workspace"), secondFile = path.join(secondRoot, relative);
  fs.mkdirSync(path.dirname(secondFile), { recursive: true }); fs.writeFileSync(secondFile, other);
  stableTime(path.join(f.root, relative)); stableTime(secondFile);
  const switchRoot = root => { f.workspace.workspaceFolders = [{ uri: uri(root) }]; f.emit("workspace"); };
  switchRoot(secondRoot); await f.search("PostInvoice", "audit");
  switchRoot(f.root); await f.search("PostInvoice");
  switchRoot(secondRoot);
  f.hooks.after = (operation, args) => {
    if (operation !== "readFile" || !String(args[0]).endsWith("project-index-v3.json")) return;
    f.hooks.after = undefined; switchRoot(f.root);
  };
  await assert.rejects(f.search("PostInvoice", "audit"), unavailable);
  const restored = await f.search("PostInvoice");
  assert.equal(restored.workspaceRoot, f.root);
  assert.ok(preview(restored).includes('"left"')); assert.ok(!preview(restored).includes('"next"'));
});

for (const saveEvent of [true, false]) {
  test(`saved buffer close refreshes listSymbols without watcher (save event API: ${saveEvent})`, async t => {
    const relative = "invoices/Posting.xbsl", before = method("PostInvoice", "disk"), after = method("PostInvoice", "paid");
    const f = fixture(t, { [relative]: before }, { saveEvent });
    stableTime(path.join(f.root, relative));
    await f.search("PostInvoice");
    const doc = f.open(relative, after);
    assert.ok(preview(await f.search("PostInvoice")).includes("paid"));
    const stat = fs.statSync(doc.uri.fsPath);
    f.write(relative, after); fs.utimesSync(doc.uri.fsPath, stat.atime, stat.mtime);
    doc.isDirty = false; f.emit("save", doc); f.close(doc);
    const symbols = await f.service.listSymbolsTool("finance", { query: "PostInvoice" });
    assert.ok(symbols.symbols.length); assert.ok(symbols.symbols.every(item => item.preview.includes("paid")));
    assert.ok(preview(await f.search("PostInvoice")).includes("paid"));
    const index = JSON.parse(fs.readFileSync(symbols.indexPath, "utf8"));
    assert.equal(index.files.find(file => file.path === relative).hash, hash(after));
  });
}

test("discarding an edited buffer on close restores disk content without persisting the overlay", async t => {
  const relative = "invoices/Posting.xbsl", before = method("PostInvoice", "disk");
  const f = fixture(t, { [relative]: before });
  await f.search("PostInvoice");
  const doc = f.open(relative, method("PostInvoice", "unsaved"));
  const edited = await f.search("PostInvoice");
  assert.ok(preview(edited).includes("unsaved"));
  assert.ok(!fs.readFileSync(edited.indexPath, "utf8").includes("unsaved"));
  f.close(doc);
  const symbols = await f.service.listSymbolsTool("finance", { query: "PostInvoice" });
  assert.ok(symbols.symbols.every(item => item.preview.includes("disk")));
});

test("compacting the bounded event history still invalidates older profile indexes", async t => {
  const relative = "migrations/017-ledger.sql", f = fixture(t, { [relative]: sql });
  stableTime(path.join(f.root, relative));
  await f.search("PostInvoice", "audit"); await f.search("PostInvoice");
  replaceSameStat(f, relative, changedSql);
  // Events for files that disappeared before the scan do not require retained fixtures.
  for (let i = 0; i < 1201; i++) f.changed(`migrations/transient-${i}.sql`, "delete");
  assert.ok(preview(await f.search("PostInvoice")).includes("5100"));
  assert.ok(preview(await f.search("PostInvoice", "audit")).includes("5100"));
});

test("exact symbol wins over prefix filenames and duplicate ranges consume one slot", async t => {
  const files = { "invoices/Posting.xbsl": method("PostInvoice", "EXACT") };
  for (const suffix of ["Archive", "Audit", "Print", "Export", "Preview", "Draft"]) {
    files[`invoices/PostInvoiceFor${suffix}.xbsl`] = method(`PostInvoiceFor${suffix}`, suffix);
  }
  const f = fixture(t, files);
  const one = await f.search("PostInvoice", "finance", { maxItems: 1 });
  assert.equal(one.chunks[0].path, "invoices/Posting.xbsl");
  assert.ok(one.chunks[0].preview.includes("EXACT"));
  const all = await f.search("PostInvoice");
  assert.equal(all.chunks.length, 7);
  assert.equal(new Set(all.chunks.map(chunk => `${chunk.path}:${chunk.startLine}:${chunk.endLine}`)).size, all.chunks.length);
});

test("range deduplication keeps distinct symbols and does not collapse different declarations", async t => {
  const f = fixture(t, {
    "invoices/Entry.yaml": "{Name: InvoiceEntry, ElementKind: Structure, Fields: [{Name: TaxAmount}, {Name: NetAmount}, {Name: taxAmount}]}",
    "invoices/Posting.xbsl": `${method("PostInvoice", "post")}\n${method("ReverseInvoice", "reverse")}`,
  });
  const yaml = await f.search("InvoiceEntry TaxAmount NetAmount");
  const chunks = yaml.chunks.filter(chunk => chunk.path.endsWith(".yaml"));
  assert.equal(chunks.length, 1);
  for (const name of ["InvoiceEntry", "TaxAmount", "NetAmount", "taxAmount"]) assert.ok(chunks[0].symbols.includes(name));
  const symbols = await f.service.listSymbolsTool("finance", { filePath: "invoices/Entry.yaml" });
  for (const name of ["InvoiceEntry", "TaxAmount", "NetAmount", "taxAmount"]) assert.ok(symbols.symbols.some(symbol => symbol.name === name));
  const code = await f.search("PostInvoice ReverseInvoice");
  assert.ok(code.chunks.some(chunk => chunk.startLine === 1 && chunk.endLine === 3));
  assert.ok(code.chunks.some(chunk => chunk.startLine === 4 && chunk.endLine === 6));
});

test("trailing punctuation is removed without losing qualified identifiers or paths", async t => {
  const name = "\u0420\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u0442\u044c\u0421\u0443\u043c\u043c\u0443";
  const f = fixture(t, {
    "invoices/Posting.xbsl": method(name, "BODY"),
    "migrations/Qualified.sql": "-- Accounting::PostInvoice\nSELECT 1;",
    "migrations/Other.sql": "-- Other::PostInvoice\nSELECT 2;",
  });
  for (const suffix of ["", ",", ":", ".", "...", ";"]) {
    const found = await f.search(`${name}${suffix}`);
    assert.ok(preview(found).includes("BODY"), suffix);
  }
  for (const query of ["invoices/Posting.xbsl:", "invoices\\Posting.xbsl."]) {
    const found = await f.search(query);
    assert.equal(found.chunks[0].path, "invoices/Posting.xbsl");
  }
  const qualified = await f.search("Accounting::PostInvoice:");
  assert.ok(qualified.chunks.length); assert.ok(qualified.chunks.every(chunk => chunk.path === "migrations/Qualified.sql"));
  assert.equal((await f.search("AbsentQuarterSymbol:")).chunks.length, 0);
});

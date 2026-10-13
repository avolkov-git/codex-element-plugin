const assert = require("node:assert/strict");
const test = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");

const SYMBOLS = "vscode.executeDocumentSymbolProvider";
const DEFINITION = "vscode.executeDefinitionProvider";
const HOVER = "vscode.executeHoverProvider";
const BRIDGE = "com.e1c.g5rt.lsp.request";
const COMMANDS = [BRIDGE, SYMBOLS, DEFINITION, HOVER];
const uri = (path = "/project/Form.xbsl") => ({ scheme: "file", path, fsPath: path, toString: () => `file://${path}` });
const range = (line = 2, endLine = 5) => ({ start: { line, character: 1 }, end: { line: endLine, character: 3 } });
const symbol = (name = "Save") => ({ name, kind: 5, range: range(), selectionRange: range(2, 2), children: [] });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  const events = new Map();
  const subscriptions = [];
  const event = (name) => (listener) => {
    const listeners = events.get(name) || new Set();
    events.set(name, listeners);
    listeners.add(listener);
    const subscription = { disposed: false, dispose() { this.disposed = true; listeners.delete(listener); } };
    subscriptions.push(subscription);
    return subscription;
  };
  const document = {
    uri: uri(), version: 1, isClosed: false, languageId: "xbsl",
    text: "method Save()\n    value = 1\n;\n\n\n\n",
    get lineCount() { return this.text.split("\n").length; },
    getText() { return this.text; },
    lineAt(index) { return { text: this.text.split("\n")[index] }; },
  };
  const calls = [];
  const extension = { isActive: true, packageJSON: { name: "1c-appengine-plugin", publisher: "1c-soft", version: "9.1.9" } };
  const handlers = {
    [SYMBOLS]: () => [symbol()],
    [DEFINITION]: () => [{ uri: uri("/project/Shared.xbsl"), range: range(8, 10) }],
    [HOVER]: () => [{ contents: [{ value: "`Save(): Number`" }] }],
    ...options.handlers,
  };
  const watcher = {
    onDidChange: event("file-change"), onDidCreate: event("file-create"), onDidDelete: event("file-delete"),
    disposed: false, dispose() { this.disposed = true; },
  };
  const mock = {
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    extensions: {
      getExtension(id) { assert.equal(id, "1c-soft.1c-appengine-plugin"); return options.noExtension ? undefined : extension; },
      onDidChange: event("extension-change"),
    },
    workspace: {
      textDocuments: options.closed ? [] : [document],
      openTextDocument: options.openTextDocument || (async () => document),
      onDidChangeTextDocument: event("document-change"), onDidCloseTextDocument: event("document-close"),
      onDidChangeWorkspaceFolders: event("workspace-change"),
      createFileSystemWatcher(pattern) { assert.equal(pattern, "**/*.{xbsl,yaml,yml}"); return watcher; },
    },
    commands: {
      getCommands: options.getCommands || (async () => options.commands || COMMANDS),
      executeCommand(command, ...args) {
        calls.push({ command, args });
        assert.ok([SYMBOLS, DEFINITION, HOVER].includes(command), `unexpected mutating/native command: ${command}`);
        return Promise.resolve(handlers[command]?.(...args));
      },
    },
  };
  const { ElementLanguageService } = loadSource("src/elementLanguageService.ts", { vscode: mock });
  const service = new ElementLanguageService(logger);
  return { service, document, calls, mock, extension, handlers, watcher, subscriptions,
    fire(name) { for (const listener of events.get(name) || []) listener({ document }); } };
}

test("requires the active native extension and native bridge, never activates or starts it", async (t) => {
  for (const options of [{ noExtension: true }, { commands: [SYMBOLS, DEFINITION, HOVER] }, {}]) {
    const f = fixture(options);
    t.after(() => f.service.dispose());
    if (!options.noExtension && !options.commands) f.extension.isActive = false;
    const result = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
    assert.equal(result.status, "unavailable");
    assert.equal(result.absenceConfirmed, false);
    assert.equal(f.calls.length, 0);
  }
});

test("does not query a similarly named third-party extension or unrelated language", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  f.extension.packageJSON.publisher = "other";
  assert.equal((await f.service.inspect(uri())).status, "unavailable");
  f.extension.packageJSON.publisher = "1c-soft";
  f.document.languageId = "javascript";
  assert.equal((await f.service.inspect(uri())).status, "unavailable");
  assert.equal((await f.service.inspect(uri("/project/file.js"))).status, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("flattens document symbols with exact one-based lines and unchanged exclusive character offsets", async (t) => {
  const root = symbol("Module");
  root.children.push(symbol("Save"));
  const f = fixture({ handlers: { [SYMBOLS]: () => [root, { name: "Legacy", kind: 11, containerName: "Container", location: { uri: uri(), range: range(12, 15) } }] } });
  t.after(() => f.service.dispose());
  const result = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  assert.equal(result.status, "ready");
  assert.deepEqual(Array.from(result.symbols, (item) => item.name), ["Module", "Save", "Legacy"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.symbols[1])), {
    name: "Save", kind: 5, containerName: "Module", startLine: 3, endLine: 6, startCharacter: 1, endCharacter: 3,
    selectionRange: { startLine: 3, endLine: 3, startCharacter: 1, endCharacter: 3 },
  });
  assert.equal(result.symbols[2].startLine, 13);
  assert.equal(result.sourceDocumentVersion, 1);
  assert.match(result.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(result.nativeExtensionVersion, "9.1.9");
  assert.equal(result.source, "vscode-language-api");
  assert.equal(result.absenceConfirmed, false);
  assert.equal(result.queries[0].definitions[0].startLine, 9);
  assert.equal(result.queries[0].hover, "Save(): Number");
  assert.deepEqual(f.calls[1].args[1], new f.mock.Position(0, 7));
});

test("empty replies remain partial and are retried without claiming that a symbol is absent", async (t) => {
  const f = fixture({ handlers: { [SYMBOLS]: () => [], [DEFINITION]: () => undefined, [HOVER]: () => [] } });
  t.after(() => f.service.dispose());
  const first = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  assert.equal(first.status, "partial");
  assert.equal(first.capabilities.documentSymbols, "empty");
  assert.equal(first.queries[0].definitionState, "empty");
  assert.equal(first.queries[0].hoverState, "empty");
  assert.equal(first.absenceConfirmed, false);
  f.handlers[SYMBOLS] = () => [symbol()];
  const second = await f.service.inspect(uri());
  assert.equal(second.status, "ready");
  assert.equal(f.calls.filter((item) => item.command === SYMBOLS).length, 2);
});

test("bounds selected queries and skips out-of-document positions", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const positions = [{ line: -1, character: 0 }, { line: 0, character: 1000 }, ...Array.from({ length: 20 }, (_, character) => ({ line: 0, character }))];
  const result = await f.service.inspect(uri(), positions);
  assert.equal(result.truncated, true);
  assert.equal(result.status, "partial");
  assert.equal(result.queries.length, 3);
  assert.equal(f.calls.filter((item) => item.command === HOVER).length, 3);
});

test("same-document concurrent requests are deduplicated, distinct query sets are not mixed", async (t) => {
  const wait = deferred();
  const f = fixture({ handlers: { [SYMBOLS]: () => wait.promise } });
  t.after(() => f.service.dispose());
  const first = f.service.inspect(uri());
  const second = f.service.inspect(uri());
  const different = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  assert.equal(different.status, "unavailable");
  await tick();
  assert.equal(f.calls.length, 1);
  wait.resolve([symbol()]);
  assert.deepEqual(await first, await second);
});

test("cache is keyed by content and version, including unsaved buffers, and is not caller-mutable", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const first = await f.service.inspect(uri());
  first.symbols[0].name = "mutated";
  assert.equal((await f.service.inspect(uri())).symbols[0].name, "Save");
  assert.equal(f.calls.length, 1);
  f.document.version += 1;
  await f.service.inspect(uri());
  assert.equal(f.calls.length, 2);
  f.document.text += "// unsaved edit, even if a host fails to increment the version\n";
  const changed = await f.service.inspect(uri());
  assert.notEqual(first.sourceHash, changed.sourceHash);
  assert.equal(f.calls.length, 3);
});

test("changes in dependencies and workspace invalidate semantic cache", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.inspect(uri());
  for (const name of ["document-change", "file-change", "file-create", "file-delete", "document-close", "workspace-change", "extension-change"]) {
    f.fire(name);
    await f.service.inspect(uri());
  }
  assert.equal(f.calls.length, 8);
});

test("an edit while a provider is running discards every earlier semantic result", async (t) => {
  const wait = deferred();
  const f = fixture({ handlers: { [SYMBOLS]: () => wait.promise } });
  t.after(() => f.service.dispose());
  const pending = f.service.inspect(uri());
  await tick();
  f.document.text += "// changed";
  f.document.version = 2;
  wait.resolve([symbol()]);
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.equal(result.sourceDocumentVersion, 2);
  assert.equal(result.symbols.length, 0);
  assert.equal(result.sourceHash, undefined);
});

test("a dependency changed during inspection also discards the response", async (t) => {
  const wait = deferred();
  const f = fixture({ handlers: { [SYMBOLS]: () => wait.promise } });
  t.after(() => f.service.dispose());
  const pending = f.service.inspect(uri());
  await tick();
  f.fire("file-change");
  wait.resolve([symbol()]);
  assert.equal((await pending).status, "unavailable");
});

test("hung providers time out and cannot pile up, even across different documents", async (t) => {
  const wait = deferred();
  const f = fixture({ handlers: { [SYMBOLS]: () => wait.promise } });
  t.after(() => f.service.dispose());
  const started = Date.now();
  const result = await f.service.inspect(uri());
  assert.equal(result.status, "unavailable");
  assert.equal(result.capabilities.documentSymbols, "timeout");
  assert.ok(Date.now() - started < 4000);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.service.inspect(uri())).capabilities.documentSymbols, "cooldown");
  }
  const secondUri = uri("/project/Other.xbsl");
  f.mock.workspace.textDocuments.push({ ...f.document, uri: secondUri });
  assert.equal((await f.service.inspect(secondUri)).capabilities.documentSymbols, "cooldown");
  assert.equal(f.calls.length, 1);
  wait.resolve([symbol()]);
  await tick();
  assert.equal((await f.service.inspect(uri())).capabilities.documentSymbols, "cooldown");
  assert.equal(f.calls.length, 1);
});

test("native command discovery has a timeout and never launches providers when it hangs", async (t) => {
  let discoveries = 0;
  const f = fixture({ getCommands() { discoveries += 1; return new Promise(() => {}); } });
  t.after(() => f.service.dispose());
  assert.equal((await f.service.inspect(uri())).status, "unavailable");
  assert.equal((await f.service.inspect(uri())).status, "unavailable");
  assert.equal(discoveries, 1);
  assert.equal(f.calls.length, 0);
});

test("provider rejection preserves successful evidence as partial and is cooled down", async (t) => {
  const f = fixture({ handlers: { [DEFINITION]: () => { throw new Error("provider unavailable"); } } });
  t.after(() => f.service.dispose());
  const result = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  assert.equal(result.status, "partial");
  assert.equal(result.queries[0].definitionState, "unavailable");
  assert.equal(result.symbols.length, 1);
  assert.equal((await f.service.inspect(uri(), [{ line: 0, character: 7 }])).queries[0].definitionState, "cooldown");
});

test("normalizes LocationLink and removes executable hover markup while preserving type notation", async (t) => {
  const f = fixture({ handlers: {
    [DEFINITION]: () => [{ targetUri: uri("/project/Type.xbsl"), targetRange: range(10, 15), targetSelectionRange: range(10, 10) }],
    [HOVER]: () => [{ contents: [
      { value: "<script>alert(1)</script><b>Save</b>\n[open](command:evil)\n`items_by_id: Array<Number>`" },
      { language: "xbsl", value: "method Save()" },
    ] }],
  } });
  t.after(() => f.service.dispose());
  const result = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  const query = result.queries[0];
  assert.equal(query.definitions[0].startLine, 11);
  assert.equal(query.definitions[0].endLine, 16);
  assert.equal(query.definitions[0].selectionRange.endLine, 11);
  assert.doesNotMatch(query.hover, /<script|alert\(1\)|command:|<b>/);
  assert.match(query.hover, /items_by_id: Array<Number>/);
  assert.match(query.hover, /method Save\(\)/);
});

test("rejects foreign document symbols and unsafe definition schemes; bounds malformed trees", async (t) => {
  const cyclic = symbol("Loop");
  cyclic.children = [cyclic, ...Array.from({ length: 600 }, (_, i) => symbol(`Child${i}`))];
  const f = fixture({ handlers: {
    [SYMBOLS]: () => [{ name: "Foreign", kind: 5, location: { uri: uri("/other.xbsl"), range: range() } }, cyclic],
    [DEFINITION]: () => [{ uri: { scheme: "command", toString: () => "command:run" }, range: range() }],
  } });
  t.after(() => f.service.dispose());
  const result = await f.service.inspect(uri(), [{ line: 0, character: 7 }]);
  assert.equal(result.status, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.symbols.length, 500);
  assert.ok(result.symbols.every((item) => item.name !== "Foreign"));
  assert.equal(result.queries[0].definitions.length, 0);
});

test("supports YAML via already active native providers without showing an editor", async (t) => {
  const f = fixture({ closed: true });
  t.after(() => f.service.dispose());
  f.document.uri = uri("/project/Form.yaml");
  f.document.languageId = "yaml";
  const result = await f.service.inspect(f.document.uri);
  assert.equal(result.status, "ready");
  assert.equal(f.calls.length, 1);
});

test("dispose releases listeners and resolves current waits without issuing further commands", async () => {
  const wait = deferred();
  const f = fixture({ handlers: { [SYMBOLS]: () => wait.promise } });
  const pending = f.service.inspect(uri());
  await tick();
  f.service.dispose();
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.equal(result.symbols.length, 0);
  assert.ok(f.subscriptions.every((subscription) => subscription.disposed));
  assert.equal(f.watcher.disposed, true);
  assert.equal((await f.service.inspect(uri())).status, "unavailable");
  wait.resolve([symbol()]);
  await tick();
  assert.equal(f.calls.length, 1);
});

test("construction and disposal before inspect need no VS Code subscriptions or watchers", () => {
  const { ElementLanguageService } = loadSource("src/elementLanguageService.ts", { vscode: {} });
  const service = new ElementLanguageService(logger);
  service.dispose();
});

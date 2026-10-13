const assert = require("node:assert/strict");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { test } = require("node:test");
const { loadSource, logger, root: pluginRoot } = require("./service-test-utils.cjs");

// These are retrieval contract tests, not validation of a running IDE or LSP.
const workspaceRoot = "/workspace";
const uri = (file) => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const vscode = { Uri: {
  file: uri,
  parse(value) {
    const parsed = new URL(value);
    return parsed.protocol === "file:" ? uri(fileURLToPath(parsed)) : { scheme: parsed.protocol.slice(0, -1) };
  },
} };
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts");
const { ProjectSemanticService, formatSemanticContext } = loadSource("src/projectSemanticService.ts", { vscode });
const unavailableAst = { parse: async () => ({ status: "unavailable", diagnostics: [], reason: "fixture: no native parser" }) };
const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const lines = (...values) => values.join("\n");

function inputFor(sources, query, selected) {
  const reads = [];
  const input = {
    workspaceRoot, query,
    files: Object.entries(sources).map(([file, text]) => ({ path: file, hash: hash(text), structure: analyzeProjectStructure(file, text) })),
    selected: selected ?? [{ path: Object.keys(sources).find((file) => file.endsWith(".xbsl")), startLine: 1, endLine: 1, symbols: [] }],
    async readFile(file) {
      reads.push(file);
      assert.ok(Object.hasOwn(sources, file), `Unexpected read: ${file}`);
      return { text: sources[file], startLine: 1, endLine: sources[file].split("\n").length, truncated: false, fromOpenDocument: false };
    },
  };
  return { input, reads };
}

function positionAt(text, line, token) {
  const sourceLine = text.split("\n")[line - 1];
  const character = sourceLine.indexOf(token);
  assert.ok(character >= 0, `Missing ${token} on line ${line}`);
  return { line: line - 1, character };
}

function languageFor(sources, facts = [], transform = (file, reply) => reply) {
  const calls = [];
  const served = new Set();
  const prepared = facts.map((fact) => ({ ...fact, position: positionAt(sources[fact.path], fact.line, fact.token) }));
  return {
    calls, served,
    async inspect(document, positions) {
      const file = path.relative(workspaceRoot, document.fsPath).split(path.sep).join("/");
      calls.push({ path: file, positions: Array.from(positions, (position) => ({ ...position })) });
      // Never return an occurrence merely because its file was inspected.
      const queries = Array.from(positions, (position) => {
        const fact = prepared.find((item) => item.path === file && item.position.line === position.line && item.position.character === position.character);
        if (fact) served.add(`${file}:${fact.line}:${fact.token}`);
        return { position, definitions: fact?.definitions ?? [], hover: fact?.hover ?? "",
          definitionState: fact?.definitions?.length ? "responded" : "empty", hoverState: fact?.hover ? "responded" : "empty" };
      });
      return transform(file, { status: "ready", sourceHash: hash(sources[file]), symbols: [], queries });
    },
  };
}

function definition(sources, file, line, name, outer = {}) {
  const position = positionAt(sources[file], line, name);
  return { uri: pathToFileURL(path.join(workspaceRoot, file)).href,
    startLine: line, endLine: line, startCharacter: position.character, endCharacter: position.character + name.length,
    ...outer,
    selectionRange: { startLine: line, endLine: line, startCharacter: position.character, endCharacter: position.character + name.length },
  };
}

function node(text, kind, startLine, endLine, attributes = {}, children = [], role, startCharacter = 0, endCharacter) {
  const sourceLines = text.split("\n");
  const offset = (line) => sourceLines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0);
  return { kind, startLine, endLine, startOffset: offset(startLine) + startCharacter,
    endOffset: offset(endLine) + (endCharacter ?? sourceLines[endLine - 1].length), attributes, children, role };
}

function callNode(text, line, name, receiver) {
  const column = positionAt(text, line, receiver ? `${receiver}.${name}` : name).character;
  const nameColumn = column + (receiver ? receiver.length + 1 : 0);
  const nameNode = node(text, receiver ? "FeatureName" : "StaticVariableAccess", line, line, { name, namespace: [] }, [],
    receiver ? "name" : "prefix", nameColumn, nameColumn + name.length);
  const prefix = receiver ? node(text, "DynamicVariableAccess", line, line, {}, [
    node(text, "StaticVariableAccess", line, line, { name: receiver, namespace: [] }, [], "source", column, column + receiver.length), nameNode,
  ], "prefix", column, nameColumn + name.length) : nameNode;
  return node(text, receiver ? "DynamicMethodInvocation" : "StaticMethodInvocation", line, line, {}, [prefix], "statements", column);
}

function moduleTree(text, methods) {
  return node(text, "Module", 1, text.split("\n").length, {}, methods.map((method) => node(text, "Method", method.start, method.end,
    { name: method.name }, [...(method.children ?? []), ...(method.calls ?? []).map((call) => callNode(text, ...call))], "methods")));
}

function parserFor(t, sources, specs, real = false, lexicalFiles = []) {
  if (real) {
    const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");
    const ast = new NativeXbslAstService(pluginRoot, logger, { parserJarPath: realJar, timeoutMs: 30000 });
    const parsed = [];
    t.after(() => {
      ast.dispose();
      assert.ok(parsed.length > 0, "Real-parser coverage must not silently fall back to lexical analysis");
      for (const result of parsed) {
        assert.equal(result.status, "ready", result.reason);
        assert.equal(result.partial, false, JSON.stringify(result.diagnostics));
      }
    });
    return { async parse(text, options) {
      const result = await ast.parse(text, options);
      parsed.push(result);
      return result;
    } };
  }
  const roots = new Map(Object.entries(specs).filter(([file]) => !lexicalFiles.includes(file))
    .map(([file, methods]) => [sources[file], moduleTree(sources[file], methods)]));
  return { parse: async (text) => roots.has(text)
    ? { status: "ready", root: roots.get(text), diagnostics: [], parserVersion: "fixture" }
    : unavailableAst.parse(text) };
}

function fullSnippet(result, file, start, end, text) {
  const snippet = result.snippets.find((item) => item.path === file && item.startLine <= start && item.endLine >= end);
  assert.ok(snippet, `Missing full declaration ${file}:${start}-${end}; snippets: ${JSON.stringify(Array.from(result.snippets,
    (item) => ({ path: item.path, start: item.startLine, end: item.endLine, truncated: item.truncated })))}`);
  assert.equal(snippet.truncated, false, `${file} must fit without truncation`);
  assert.ok(snippet.text.includes(text), `Incomplete declaration in ${file}`);
  return snippet;
}

function chainFixture() {
  const sources = {
    "UI/Entry.xbsl": lines("метод Start()", "    Bridge()", ";"),
    "Services/Middle.xbsl": lines("// target file", "метод Unrelated()", "    Ignore()", ";", "@НаКлиенте", "метод Bridge()", "    Finish()", ";"),
    "Storage/Leaf.xbsl": lines("// leaf", "метод Finish()", "    Beyond()", '    возврат "leaf-body"', ";", "метод Neighbor()", "    возврат", ";"),
    "Storage/Beyond.xbsl": lines("метод Beyond()", '    возврат "third-hop"', ";"),
    "Services/Ignore.xbsl": lines("метод Ignore()", "    возврат", ";"),
  };
  const specs = {
    "UI/Entry.xbsl": [{ name: "Start", start: 1, end: 3, calls: [[2, "Bridge"]] }],
    "Services/Middle.xbsl": [{ name: "Unrelated", start: 2, end: 4, calls: [[3, "Ignore"]] }, { name: "Bridge", start: 5, end: 8, calls: [[7, "Finish"]] }],
    "Storage/Leaf.xbsl": [{ name: "Finish", start: 2, end: 5, calls: [[3, "Beyond"]] }, { name: "Neighbor", start: 6, end: 8 }],
  };
  const facts = [
    { path: "UI/Entry.xbsl", line: 2, token: "Bridge", definitions: [definition(sources, "Services/Middle.xbsl", 6, "Bridge", { startLine: 1, endLine: 8 })] },
    { path: "Services/Middle.xbsl", line: 7, token: "Finish", definitions: [definition(sources, "Storage/Leaf.xbsl", 2, "Finish", { startLine: 1, endLine: 8 })] },
    { path: "Services/Middle.xbsl", line: 3, token: "Ignore", definitions: [definition(sources, "Services/Ignore.xbsl", 1, "Ignore")] },
    { path: "Storage/Leaf.xbsl", line: 3, token: "Beyond", definitions: [definition(sources, "Storage/Beyond.xbsl", 1, "Beyond")] },
  ];
  return { sources, specs, facts };
}

for (const mode of ["fixture AST", "lexical leaf", "real AST"]) {
  test(`${mode}: two-hop definitions expand selectionRange and do not traverse unrelated bodies or a third hop`, { skip: mode === "real AST" && !realJar }, async (t) => {
    const { sources, specs, facts } = chainFixture();
    const { input, reads } = inputFor(sources, "Why does Start fail?");
    const language = languageFor(sources, facts);
    const ast = parserFor(t, sources, specs, mode === "real AST", mode === "lexical leaf" ? ["Storage/Leaf.xbsl"] : []);
    const result = await new ProjectSemanticService(ast, language, logger).buildContext(input);
    assert.ok(language.served.has("UI/Entry.xbsl:2:Bridge"));
    assert.ok(language.served.has("Services/Middle.xbsl:7:Finish"), "Second-hop call must actually be requested");
    assert.equal(language.served.has("Services/Middle.xbsl:3:Ignore"), false);
    fullSnippet(result, "UI/Entry.xbsl", 1, 3, sources["UI/Entry.xbsl"]);
    fullSnippet(result, "Services/Middle.xbsl", 5, 8, lines("@НаКлиенте", "метод Bridge()", "    Finish()", ";"));
    const leaf = fullSnippet(result, "Storage/Leaf.xbsl", 2, 5, lines("метод Finish()", "    Beyond()", '    возврат "leaf-body"', ";"));
    assert.equal(leaf.source, mode === "lexical leaf" ? "lexical" : "native-ast");
    assert.equal(leaf.depth, 2);
    assert.equal(leaf.text.includes("Neighbor"), false);
    for (const [name, file, startLine, endLine] of [["Bridge", "Services/Middle.xbsl", 5, 8], ["Finish", "Storage/Leaf.xbsl", 2, 5]]) {
      const link = result.links.find((item) => item.kind === "definition" && item.name === name);
      assert.equal(link?.confidence, "lsp");
      assert.ok(link.targets.some((target) => target.path === file && target.startLine === startLine && target.endLine === endLine));
    }
    assert.equal(reads.includes("Storage/Beyond.xbsl"), false);
    assert.equal(reads.includes("Services/Ignore.xbsl"), false);
    assert.ok(result.snippets.every((snippet) => snippet.depth <= result.selection.maxDepth));
  });
}

test("cyclic definitions terminate without duplicate bodies or repeated position requests", async (t) => {
  const sources = { "A.xbsl": lines("метод Start()", "    Again()", ";"), "B.xbsl": lines("метод Again()", "    Start()", ";") };
  const specs = { "A.xbsl": [{ name: "Start", start: 1, end: 3, calls: [[2, "Again"]] }], "B.xbsl": [{ name: "Again", start: 1, end: 3, calls: [[2, "Start"]] }] };
  const language = languageFor(sources, [
    { path: "A.xbsl", line: 2, token: "Again", definitions: [definition(sources, "B.xbsl", 1, "Again")] },
    { path: "B.xbsl", line: 2, token: "Start", definitions: [definition(sources, "A.xbsl", 1, "Start")] },
  ]);
  const { input, reads } = inputFor(sources, "Start");
  const result = await new ProjectSemanticService(parserFor(t, sources, specs), language, logger).buildContext(input);
  for (const file of Object.keys(sources)) {
    fullSnippet(result, file, 1, 3, sources[file]);
    assert.equal(result.snippets.filter((snippet) => snippet.path === file).length, 1, "A cycle must not duplicate its declaration");
    assert.ok(reads.filter((read) => read === file).length <= 2, "Only initial read and final validation are needed");
  }
  const positions = language.calls.flatMap((call) => call.positions.map((position) => `${call.path}:${position.line}:${position.character}`));
  assert.equal(new Set(positions).size, positions.length);
  assert.ok(result.links.some((link) => link.from.path === "B.xbsl" && link.targets.some((target) => target.path === "A.xbsl")));
});

test("ambiguous definitions preserve both full alternatives without inventing a binding", async (t) => {
  const sources = { "Entry.xbsl": lines("метод Start()", "    Resolve()", ";"),
    "One.xbsl": lines("метод Resolve()", '    возврат "one"', ";"), "Two.xbsl": lines("метод Resolve()", '    возврат "two"', ";") };
  const specs = { "Entry.xbsl": [{ name: "Start", start: 1, end: 3, calls: [[2, "Resolve"]] }] };
  const first = definition(sources, "One.xbsl", 1, "Resolve");
  const language = languageFor(sources, [{ path: "Entry.xbsl", line: 2, token: "Resolve", definitions: [first, first, definition(sources, "Two.xbsl", 1, "Resolve")] }]);
  const { input } = inputFor(sources, "Start");
  const result = await new ProjectSemanticService(parserFor(t, sources, specs), language, logger).buildContext(input);
  const link = result.links.find((item) => item.kind === "definition" && item.name === "Resolve");
  assert.equal(link?.confidence, "ambiguous");
  assert.deepEqual(new Set(Array.from(link.targets, (target) => target.path)), new Set(["One.xbsl", "Two.xbsl"]));
  assert.equal(link.targets.length, 2, "An identical provider target is not a third alternative");
  for (const file of ["One.xbsl", "Two.xbsl"]) fullSnippet(result, file, 1, 3, sources[file]);
  assert.equal(result.links.some((item) => item.kind === "native-call" && item.name === "Resolve"), false);
});

test("definitions cannot read an outside path, a sibling-prefix path, a non-file URI, or an unindexed workspace file", async (t) => {
  const sources = { "Entry.xbsl": lines("метод Start()", "    Load()", ";"), "Allowed.xbsl": lines("метод Load()", "    возврат", ";") };
  const allowed = definition(sources, "Allowed.xbsl", 1, "Load");
  const forbidden = ["file:///outside/Secret.xbsl", "file:///workspace-other/Secret.xbsl", "file:///workspace/%2e%2e/Secret.xbsl",
    "file:///workspace/Unindexed.xbsl", "untitled:Secret.xbsl", "https://example.invalid/Secret.xbsl"];
  const language = languageFor(sources, [{ path: "Entry.xbsl", line: 2, token: "Load",
    definitions: [allowed, ...forbidden.map((uri) => ({ ...allowed, uri }))] }]);
  const { input, reads } = inputFor(sources, "Start");
  const ast = parserFor(t, sources, { "Entry.xbsl": [{ name: "Start", start: 1, end: 3, calls: [[2, "Load"]] }] });
  const result = await new ProjectSemanticService(ast, language, logger).buildContext(input);
  fullSnippet(result, "Allowed.xbsl", 1, 3, sources["Allowed.xbsl"]);
  assert.deepEqual(new Set(reads), new Set(Object.keys(sources)), "Even rejected reads count as a boundary violation");
  const link = result.links.find((item) => item.kind === "definition");
  assert.equal(link?.confidence, "lsp");
  assert.deepEqual(Array.from(link.targets, (target) => target.path), ["Allowed.xbsl"]);
  assert.ok(language.calls.every((call) => Object.hasOwn(sources, call.path)));
});

for (const staleMode of ["initial provider hash", "supplemental provider hash", "final text", "final truncation"]) {
  test(`a dependency with stale ${staleMode} contributes no snippet, hover, or link`, async (t) => {
    const { sources, specs, facts } = chainFixture();
    const dependency = "Services/Middle.xbsl";
    facts.find((fact) => fact.path === dependency && fact.token === "Finish").hover = "stale dependency hover";
    const language = languageFor(sources, facts, (file, reply) => {
      const staleReply = staleMode === "initial provider hash"
        || (staleMode === "supplemental provider hash" && reply.queries.some((query) => query.position.line === 6));
      return file === dependency && staleReply ? { ...reply, sourceHash: hash("new editor revision") } : reply;
    });
    const { input, reads } = inputFor(sources, "Start");
    const read = input.readFile;
    input.readFile = async (file) => {
      const snapshot = await read(file);
      if (file === dependency && reads.filter((item) => item === file).length > 1) {
        if (staleMode === "final text") snapshot.text += "\n// changed";
        if (staleMode === "final truncation") snapshot.truncated = true;
      }
      return snapshot;
    };
    const result = await new ProjectSemanticService(parserFor(t, sources, specs), language, logger).buildContext(input);
    assert.ok(language.calls.some((call) => call.path === dependency), "Exercise a genuinely inspected dependency");
    if (staleMode !== "initial provider hash") assert.ok(language.served.has(`${dependency}:7:Finish`), "Exercise the dependency's requested call site");
    fullSnippet(result, "UI/Entry.xbsl", 1, 3, sources["UI/Entry.xbsl"]);
    assert.equal(result.snippets.some((snippet) => snippet.path === dependency), false);
    assert.equal(result.hovers.some((hover) => hover.path === dependency), false);
    assert.equal(result.links.some((link) => link.from.path === dependency || link.targets.some((target) => target.path === dependency)), false);
    assert.equal(result.documentationQueries.length, 0);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes(dependency)));
  });
}

function signatureFixture() {
  const code = lines("@НаКлиенте", "метод Compute(", "    Values: Массив<Строка>,", "    Flag: Булево", "): Число",
    "    знч Local: Дата = Неопределено", "    Worker()", "    возврат 42", ";");
  const type = (line, name) => {
    const column = positionAt(code, line, name).character;
    return node(code, "TypeName", line, line, { name }, [], "types", column, column + name.length);
  };
  const children = [
    node(code, "Parameter", 3, 3, { name: "Values" }, [type(3, "Массив"), type(3, "Строка")], "parameters"),
    node(code, "Parameter", 4, 4, { name: "Flag" }, [type(4, "Булево")], "parameters"),
    { ...type(5, "Число"), role: "returnTypes" },
    node(code, "DeclareVariableStatement", 6, 6, { name: "Local" }, [type(6, "Дата")], "statements"),
    node(code, "ReturnStatement", 8, 8, {}, [], "statements"),
  ];
  const sources = { "Entry.xbsl": code, "Worker.xbsl": lines("метод Worker()", "    возврат", ";") };
  const specs = { "Entry.xbsl": [{ name: "Compute", start: 1, end: 9, children, calls: [[7, "Worker"]] }] };
  const facts = [{ path: "Entry.xbsl", line: 7, token: "Worker", definitions: [definition(sources, "Worker.xbsl", 1, "Worker")] }];
  return { sources, specs, facts };
}

for (const real of [false, true]) {
  test(`${real ? "real" : "fixture"} AST: signature retains multiline parameters and return types; behavior retains the full body`, { skip: real && !realJar }, async (t) => {
    const { sources, specs, facts } = signatureFixture();
    const ast = parserFor(t, sources, specs, real);
    for (const query of ["Show Compute signature", "Why does Compute fail with this signature?", "Как работает Compute?"]) {
      const declarationOnly = query === "Show Compute signature";
      const { input, reads } = inputFor(sources, query);
      const result = await new ProjectSemanticService(ast, languageFor(sources, facts), logger).buildContext(input);
      assert.equal(result.selection.intent, declarationOnly ? "declaration" : "implementation");
      const expected = sources["Entry.xbsl"].split("\n").slice(0, declarationOnly ? 5 : 9).join("\n");
      const snippet = fullSnippet(result, "Entry.xbsl", 1, declarationOnly ? 5 : 9, expected);
      assert.equal(snippet.purpose, declarationOnly ? "declaration" : "implementation");
      assert.equal(snippet.text.includes("возврат 42"), !declarationOnly);
      for (const name of ["Массив", "Строка", "Булево", "Число"]) assert.ok(result.documentationQueries.includes(name), `Missing signature type ${name}`);
      assert.equal(result.documentationQueries.includes("Дата"), !declarationOnly);
      assert.equal(reads.includes("Worker.xbsl"), !declarationOnly);
      if (!declarationOnly) fullSnippet(result, "Worker.xbsl", 1, 3, sources["Worker.xbsl"]);
    }
  });
}

test("lexical signature fallback retains multiline types without guessing a one-line declaration", async () => {
  const { sources } = signatureFixture();
  const { input } = inputFor(sources, "Compute signature");
  const result = await new ProjectSemanticService(unavailableAst, languageFor(sources), logger).buildContext(input);
  const snippet = fullSnippet(result, "Entry.xbsl", 2, 5, lines("метод Compute(", "    Values: Массив<Строка>,", "    Flag: Булево", "): Число"));
  assert.equal(snippet.source, "lexical");
  assert.equal(snippet.purpose, "declaration");
});

test("overlapping selected, named, YAML, and repeated LSP ranges publish each declaration once", async (t) => {
  const sources = { "Form.yaml": lines("ВидЭлемента: КомпонентИнтерфейса", "Имя: Form", "ПриНажатии: Start"),
    "Form.xbsl": lines("метод Start()", "    Helper()", "    Helper()", ";", "метод Helper()", "    возврат", ";") };
  const target = definition(sources, "Form.xbsl", 5, "Helper");
  const language = languageFor(sources, [2, 3].map((line) => ({ path: "Form.xbsl", line, token: "Helper", definitions: [target, target] })),
    (file, reply) => file.endsWith(".xbsl") ? { ...reply, symbols: [
      { name: "Start", kind: 5, startLine: 1, endLine: 4, selectionRange: definition(sources, file, 1, "Start").selectionRange },
      { name: "Helper", kind: 5, startLine: 5, endLine: 7, selectionRange: target.selectionRange },
    ] } : reply);
  const { input } = inputFor(sources, "Start Helper", [
    { path: "Form.yaml", startLine: 1, endLine: 3, symbols: [] },
    { path: "Form.xbsl", startLine: 1, endLine: 7, symbols: ["Start", "Helper"] },
    { path: "Form.xbsl", startLine: 2, endLine: 6, symbols: ["Helper"] },
  ]);
  const ast = parserFor(t, sources, { "Form.xbsl": [{ name: "Start", start: 1, end: 4, calls: [[2, "Helper"], [3, "Helper"]] }, { name: "Helper", start: 5, end: 7 }] });
  const result = await new ProjectSemanticService(ast, language, logger).buildContext(input);
  for (const [start, end] of [[1, 4], [5, 7]]) fullSnippet(result, "Form.xbsl", start, end, sources["Form.xbsl"].split("\n").slice(start - 1, end).join("\n"));
  for (const declarationLine of [1, 5]) assert.equal(result.snippets.filter((snippet) => snippet.path === "Form.xbsl" && snippet.startLine <= declarationLine && snippet.endLine >= declarationLine).length, 1);
  const definitions = result.links.filter((link) => link.kind === "definition" && link.name === "Helper");
  assert.deepEqual(new Set(Array.from(definitions, (link) => link.from.startLine)), new Set([2, 3]), "Distinct call-site evidence must survive snippet deduplication");
});

for (const noise of ["large dependency", "noisy YAML"]) {
  test(`full named methods survive the context budget before ${noise}`, async (t) => {
    const body = (name) => lines(`метод ${name}()`, `    // ${"x".repeat(5500)}`, ...(name === "Start" ? ["    Huge()"] : []), `    // end-${name}`, ";");
    const code = lines(body("Start"), body("Save"));
    const sources = { "Z/Logic.xbsl": code, "Z/Huge.xbsl": lines("метод Huge()", `    // ${"z".repeat(26000)}`, "    возврат", ";") };
    const selected = [{ path: "Z/Logic.xbsl", startLine: 1, endLine: 9, symbols: ["Start", "Save"] }];
    if (noise === "noisy YAML") {
      sources["A/Screen.yaml"] = lines("ВидЭлемента: КомпонентИнтерфейса", "Имя: Screen", `Описание: ${"noise ".repeat(5000)}`);
      selected.unshift({ path: "A/Screen.yaml", startLine: 1, endLine: 3, symbols: ["Screen"] });
    }
    const language = languageFor(sources, [{ path: "Z/Logic.xbsl", line: 3, token: "Huge", definitions: [definition(sources, "Z/Huge.xbsl", 1, "Huge")] }]);
    const { input } = inputFor(sources, "Why do Start and Save in Logic fail in Screen?", selected);
    const ast = parserFor(t, sources, { "Z/Logic.xbsl": [{ name: "Start", start: 1, end: 5, calls: [[3, "Huge"]] }, { name: "Save", start: 6, end: 9 }] });
    const result = await new ProjectSemanticService(ast, language, logger).buildContext(input);
    fullSnippet(result, "Z/Logic.xbsl", 1, 5, body("Start"));
    fullSnippet(result, "Z/Logic.xbsl", 6, 9, body("Save"));
    assert.ok(result.snippets.some((snippet) => snippet.truncated) || result.selection.omittedRanges > 0, "The fixture must actually exceed the context budget");
  });
}

test("the formatter omits an oversized declaration whole, still includes a later fitting body, and reports the omission", () => {
  const hugeBody = lines("метод Huge()", `    // ${"x".repeat(6000)}`, "    // huge-end", ";");
  const smallBody = lines("метод Small()", "    возврат 42", ";");
  const context = { snippets: [hugeBody, smallBody].map((text, index) => ({ path: index ? "Small.xbsl" : "Huge.xbsl",
    startLine: 1, endLine: text.split("\n").length, text, source: "native-ast", hash: hash(text),
    fromOpenDocument: false, truncated: false, purpose: "implementation" })),
    links: [], providers: [], diagnostics: [], hovers: [], documentationQueries: [] };
  const output = formatSemanticContext(context, 2000);
  assert.ok(output.length <= 2000);
  assert.equal(output.includes("метод Huge()"), false, "An omitted declaration must not leak a misleading partial prefix");
  assert.ok(output.includes(smallBody), "One oversized method must not prevent a later complete method from fitting");
  assert.match(output, /project\.readFile/, "Omitted context needs an actionable continuation notice");
  const unlimited = formatSemanticContext(context);
  assert.ok(unlimited.includes(hugeBody));
  assert.ok(unlimited.includes(smallBody));
});

test("formatter budgets never silently slice a method or hide a retrieval truncation flag", () => {
  const body = lines("метод Start()", `    // ${"body ".repeat(300)}`, "    // complete-tail", ";");
  const context = { snippets: [{ path: "Entry.xbsl", startLine: 1, endLine: 4, text: body,
    source: "native-ast", hash: hash(body), fromOpenDocument: true, truncated: false, purpose: "implementation" }],
    links: [], providers: [], diagnostics: [], hovers: [], documentationQueries: [] };
  for (const budget of [80, 500, 1200, 4000]) {
    const output = formatSemanticContext(context, budget);
    assert.ok(output.length <= budget, `Output exceeds ${budget} characters`);
    if (output.includes("метод Start()")) assert.ok(output.includes(body), `Method sliced at budget ${budget}`);
    else assert.equal(output.includes("Entry.xbsl:1-4"), false, "Do not publish a header for an omitted body");
  }
  context.snippets[0].truncated = true;
  assert.match(formatSemanticContext(context, 4000), /НЕПОЛНЫЙ ФРАГМЕНТ/);
});

test("long diagnostics cannot hide both a method and its output-omission notice", () => {
  const body = lines("метод Start()", "    возврат", ";");
  const context = { snippets: [{ path: "Entry.xbsl", startLine: 1, endLine: 3, text: body,
    source: "native-ast", hash: hash(body), fromOpenDocument: false, truncated: false, purpose: "implementation" }],
    links: [], providers: [], diagnostics: [`Parser warning: ${"x".repeat(2400)}`], hovers: [], documentationQueries: [],
    selection: { intent: "implementation", maxDepth: 2, budgetChars: 32000, omittedRanges: 0 } };
  const output = formatSemanticContext(context, 2000);
  assert.ok(output.length <= 2000);
  assert.match(output, /глубина до 2/);
  if (!output.includes(body)) {
    assert.match(output, /Не включено в лимит вывода целых участков: 1/,
      "A clipped diagnostic header must not consume the space reserved for the actual omitted-method count");
  }
});

for (const limitation of ["clipped snippet", "omitted ranges"]) {
  test(`project tool truncation metadata includes retrieval ${limitation}, even when formatting fits`, async () => {
    const { ProjectToolsService } = loadSource("src/projectToolsService.ts", { vscode });
    const { toContextBlock } = loadSource("src/contextTools.ts");
    const clipped = limitation === "clipped snippet";
    const text = clipped ? lines("метод Start()", "    // partial", "[Фрагмент обрезан: метод показан не целиком]")
      : lines("метод Start()", "    возврат", ";");
    const semantic = { snippets: [{ path: "Entry.xbsl", startLine: 1, endLine: clipped ? 100 : 3, text,
      source: "native-ast", hash: hash(text), fromOpenDocument: false, truncated: clipped, purpose: "implementation" }],
      links: [], providers: [], diagnostics: [], hovers: [], documentationQueries: [],
      selection: { intent: "implementation", maxDepth: 2, budgetChars: 32000, omittedRanges: clipped ? 0 : 2 } };
    const project = new ProjectToolsService({ searchTool: async () => ({ workspaceRoot, query: "Start", totalFiles: 1,
      totalChunks: 1, updatedAt: "now", semantic, chunks: [{ path: "Entry.xbsl", startLine: 1, endLine: 3,
        preview: "index preview", chunkId: "entry", score: 1, symbols: ["Start"], keywords: [], language: "xbsl" }] }) }, logger, () => "user");
    const result = await project.search({ chatId: "stage2", query: "Start", reason: "retrieval truncation regression" });
    assert.equal(result.ok, true);
    assert.ok(result.blocks[0].text.includes(text), "The tool formatter must not be the source of truncation in this fixture");
    assert.equal(result.blocks[0].text.endsWith("…"), false);
    assert.equal(result.metadata.contextSelection.omittedRanges, semantic.selection.omittedRanges);
    assert.equal(result.stats.truncated, true, "Tool/worklog stats must not call incomplete retrieval complete");
    assert.equal(toContextBlock(result.blocks[0]).metadata.truncated, true, "The prompt block must retain the same limitation");
  });
}

for (const real of [false, true]) {
  for (const shadow of ["none", "parameter", "local variable"]) {
    test(`${real ? "real" : "fixture"} AST: explicit shared-module receiver with ${shadow} shadow`, { skip: real && !realJar }, async (t) => {
      const code = lines(shadow === "parameter" ? "метод Start(Worker: Строка)" : "метод Start()",
        ...(shadow === "local variable" ? ['    знч Worker = "local"'] : []), "    Worker.Execute()", ";");
      const callLine = shadow === "local variable" ? 3 : 2;
      const sources = {
        "project.yaml": "Имя: Root\n", "UI/Entry.xbsl": code,
        "Services/Worker.yaml": lines("ВидЭлемента: ОбщийМодуль", "Имя: Worker"),
        "Services/Worker.xbsl": lines("метод Execute()", '    возврат "shared-module"', ";"),
        "Nested/project.yaml": "Имя: Nested\n",
        "Nested/Worker.yaml": lines("ВидЭлемента: ОбщийМодуль", "Имя: Worker"),
        "Nested/Worker.xbsl": lines("метод Execute()", '    возврат "wrong-project"', ";"),
      };
      const children = shadow === "none" ? [] : [node(code, shadow === "parameter" ? "Parameter" : "DeclareVariableStatement",
        shadow === "parameter" ? 1 : 2, shadow === "parameter" ? 1 : 2, { name: "Worker" }, [], shadow === "parameter" ? "parameters" : "statements")];
      const specs = { "UI/Entry.xbsl": [{ name: "Start", start: 1, end: callLine + 1, calls: [[callLine, "Execute", "Worker"]], children }] };
      const { input, reads } = inputFor(sources, "Start");
      const language = languageFor(sources);
      const result = await new ProjectSemanticService(parserFor(t, sources, specs, real), language, logger).buildContext(input);
      const links = result.links.filter((link) => link.kind === "module-call" && link.name === "Execute");
      if (shadow === "none") {
        assert.ok(links.some((link) => link.confidence === "candidate" && link.targets.some((target) => target.path === "Services/Worker.xbsl")));
        fullSnippet(result, "Services/Worker.xbsl", 1, 3, sources["Services/Worker.xbsl"]);
      } else {
        assert.equal(links.length, 0, "An object receiver shadowing a module is not a module-call candidate");
        assert.equal(reads.includes("Services/Worker.xbsl"), false, "Do not inspect a falsely inferred dependency");
      }
      assert.equal(reads.includes("Nested/Worker.xbsl"), false);
      assert.equal(result.links.some((link) => link.confidence === "lsp"), false, "Syntax-only inference is never an LSP fact");
    });
  }
}

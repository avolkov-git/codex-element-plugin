const assert = require("node:assert/strict");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");
const test = require("node:test");
const { root: pluginRoot, loadSource, logger } = require("./service-test-utils.cjs");

const workspaceRoot = path.resolve("/reference-limits-workspace");
const file = "Entry.xbsl";
const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;
const hash = text => createHash("sha256").update(text).digest("hex");
const uri = fsPath => ({ scheme: "file", fsPath, path: fsPath, toString: () => pathToFileURL(fsPath).href });
const vscode = { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) } };
const { ProjectSemanticService } = loadSource("src/projectSemanticService.ts", { vscode });
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts");

function position(text, line, name) {
  const character = text.split("\n")[line - 1].indexOf(name);
  assert.ok(character >= 0, `Missing ${name} on line ${line}`);
  return { line: line - 1, character };
}

function node(text, kind, startLine, endLine, attributes = {}, children = [], role, startCharacter = 0, endCharacter) {
  const lines = text.split("\n");
  const offset = line => lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0);
  return { kind, startLine, endLine, startOffset: offset(startLine) + startCharacter,
    endOffset: offset(endLine) + (endCharacter ?? lines[endLine - 1].length), attributes, children, role };
}

function call(text, line, name) {
  const column = position(text, line, name).character;
  return node(text, "StaticMethodInvocation", line, line, {}, [
    node(text, "StaticVariableAccess", line, line, { name, namespace: [] }, [], "prefix", column, column + name.length),
  ], "statements", column, column + name.length + 2);
}

function pointer(text, line, context = "") {
  const name = "ReceivePulse", column = position(text, line, name).character;
  const ampersand = text.split("\n")[line - 1].indexOf("&");
  assert.ok(ampersand >= 0);
  return node(text, "MethodRef", line, line, {
    ctor: false, explicitObjectCtx: context === "this", explicitGlobalCtx: context === "global",
  }, [node(text, "StaticVariableAccess", line, line, { name, namespace: [] }, [], "first", column, column + name.length)],
  "initializer", ampersand, column + name.length);
}

function declaration(text, line, name, initializer) {
  return node(text, "DeclareVariableStatement", line, initializer.endLine, { name }, [initializer], "statements", 4);
}

function parameter(text, line, name) {
  const column = position(text, line, name).character;
  const typeColumn = position(text, line, "Object").character;
  const type = node(text, "TypeName", line, line, { name: "Object", namespace: [] }, [], "typeNames", typeColumn, typeColumn + 6);
  return node(text, "Parameter", line, line, { name }, [
    node(text, "CompoundTypeName", line, line, {}, [type], "types", typeColumn, typeColumn + 6),
  ], "parameters", column, typeColumn + 6);
}

function fixture(text, methods) {
  const tree = node(text, "Module", 1, text.split("\n").length, {}, methods.map(method =>
    node(text, "Method", method.start, method.end, { name: method.name }, method.children ?? [], "methods")));
  return { text, tree, methods };
}

function repeatedCallsFixture() {
  const lines = ["method Wire()", ...Array.from({ length: 100 }, (_, index) => `${" ".repeat(4 + index % 3)}Repeat()`),
    "    Late()", ";", "", "method Repeat()", "    return 1", ";", "",
    "method Late()", '    return "late-dependency-body"', ";"];
  const text = lines.join("\n");
  return fixture(text, [
    { name: "Wire", start: 1, end: 103,
      children: [...Array.from({ length: 100 }, (_, index) => call(text, index + 2, "Repeat")), call(text, 102, "Late")] },
    { name: "Repeat", start: 105, end: 107 },
    { name: "Late", start: 109, end: 111 },
  ]);
}

function pointerFixture({ nested = false, outerParameter = false, context = "" } = {}) {
  const lines = [`method Wire(${outerParameter ? "ReceivePulse: Object" : ""})`,
    `    val Listener = &${context ? `${context}.` : ""}ReceivePulse`];
  if (nested) lines.push("    val Callback = method(ReceivePulse: Object) ->",
    "        val InnerListener = &ReceivePulse", "        ReceivePulse()", "    ;");
  lines.push(";");
  const end = lines.length;
  lines.push("", "method ReceivePulse()", '    return "callback-target-body"', ";");
  const text = lines.join("\n");
  const children = [declaration(text, 2, "Listener", pointer(text, 2, context))];
  if (outerParameter) children.push(parameter(text, 1, "ReceivePulse"));
  if (nested) {
    const lambda = node(text, "Lambda", 3, 6, {}, [parameter(text, 3, "ReceivePulse"),
      declaration(text, 4, "InnerListener", pointer(text, 4)), call(text, 5, "ReceivePulse")],
    "initializer", position(text, 3, "method").character);
    children.push(declaration(text, 3, "Callback", lambda));
  }
  return fixture(text, [{ name: "Wire", start: 1, end, children }, { name: "ReceivePulse", start: end + 2, end: end + 4 }]);
}

function parser(t, source, real) {
  if (!real) return { async parse(text) {
    assert.equal(text, source.text, "Fixture parser must not silently accept an unknown file");
    return { status: "ready", partial: false, root: source.tree, diagnostics: [], parserVersion: "reference-limits-fixture",
      semanticBound: false, referencesExcluded: true };
  } };
  const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");
  const native = new NativeXbslAstService(pluginRoot, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  const results = [];
  t.after(() => {
    native.dispose();
    assert.ok(results.length, "Native mode must really parse the source");
    for (const result of results) {
      assert.equal(result.status, "ready", result.reason);
      assert.equal(result.partial, false, JSON.stringify(result.diagnostics));
      assert.equal(result.diagnostics.length, 0);
      assert.equal(result.semanticBound, false);
    }
  });
  return { async parse(text, options) {
    const result = await native.parse(text, options);
    results.push(result);
    return result;
  } };
}

async function build(t, source, real) {
  const inspections = [];
  // Both modes exercise fallback without any definition provider, not a live IDE/LSP.
  const language = { async inspect(document, positions) {
    assert.equal(document.fsPath, path.join(workspaceRoot, file));
    inspections.push(...Array.from(positions, point => ({ ...point })));
    return { status: "unavailable", sourceHash: hash(source.text), symbols: [], queries: [], reason: "Offline fallback test" };
  } };
  const service = new ProjectSemanticService(parser(t, source, real), language, logger, 30000);
  const result = await service.buildContext({ workspaceRoot, query: "Explain Wire and its dependencies",
    files: [{ path: file, hash: hash(source.text), structure: analyzeProjectStructure(file, source.text) }],
    selected: [{ path: file, startLine: 1, endLine: 1, symbols: ["Wire"] }],
    async readFile(requested) {
      assert.equal(requested, file);
      return { text: source.text, startLine: 1, endLine: source.text.split("\n").length, truncated: false, fromOpenDocument: false };
    },
  });
  return { result, inspections };
}

function assertOccurrence(link, source, line, name) {
  const point = position(source.text, line, name);
  assert.deepEqual({ ...link.from }, { path: file, startLine: line, endLine: line,
    startCharacter: point.character, endCharacter: point.character + name.length });
  assert.equal(source.text.split("\n")[line - 1].slice(link.from.startCharacter, link.from.endCharacter), name);
}

function assertFullMethod(result, source, name) {
  const method = source.methods.find(method => method.name === name);
  assert.ok(method, `Unknown expected method ${name}`);
  const expected = source.text.split("\n").slice(method.start - 1, method.end).join("\n");
  assert.ok(result.snippets.some(snippet => snippet.path === file && !snippet.truncated
    && snippet.startLine <= method.start && snippet.endLine >= method.end && snippet.text.includes(expected)),
  `Missing complete ${name} body`);
}

for (const real of [false, true]) {
  const mode = real ? "native AST" : "fixture AST";
  const options = { skip: real && !realJar };

  test(`${mode}: 100 repeated calls leave room for Late and retain precise bounded occurrences`, options, async t => {
    const source = repeatedCallsFixture();
    const { result, inspections } = await build(t, source, real);
    const repeats = Array.from(result.links).filter(link => link.name === "Repeat").sort((a, b) => a.from.startLine - b.from.startLine);
    const late = Array.from(result.links).filter(link => link.name === "Late");
    assert.equal(late.length, 1, "The second dependency group must not be displaced by repeated occurrences");
    assert.equal(result.links.length, 96, "Fallback retains occurrences up to its budget, not one link per name");
    assert.equal(repeats.length, 95);
    for (let index = 0; index < repeats.length; index += 1) assertOccurrence(repeats[index], source, index + 2, "Repeat");
    assertOccurrence(late[0], source, 102, "Late");
    assert.equal(new Set(result.links.map(link => `${link.from.startLine}:${link.from.startCharacter}`)).size, result.links.length);
    for (const link of result.links) {
      const method = source.methods.find(method => method.name === link.name);
      assert.equal(link.kind, "native-call");
      assert.equal(link.confidence, "candidate");
      assert.deepEqual(Array.from(link.targets, target => ({ ...target })), [{ path: file, startLine: method.start, endLine: method.end }]);
    }
    for (const name of ["Wire", "Repeat", "Late"]) assertFullMethod(result, source, name);
    assert.equal(result.selection.omittedRanges, 5);
    assert.ok(result.diagnostics.some(message => message.includes("5")), "Discarded occurrences need an omission notice");
    assert.ok(inspections.length <= 7, "100 repetitions must not cause 100 provider requests");
    assert.equal(new Set(inspections.map(point => `${point.line}:${point.character}`)).size, inspections.length);
  });

  test(`${mode}: a nested lambda parameter does not shadow the outer MethodRef`, options, async t => {
    const source = pointerFixture({ nested: true });
    const { result } = await build(t, source, real);
    const links = Array.from(result.links).filter(link => link.name === "ReceivePulse");
    assert.equal(links.length, 1, "Nested calls/references must not become outer fallback occurrences");
    assertOccurrence(links[0], source, 2, "ReceivePulse");
    assert.equal(links[0].kind, "native-method-reference");
    assert.equal(links[0].confidence, "candidate");
    const target = source.methods.find(method => method.name === "ReceivePulse");
    assert.deepEqual(Array.from(links[0].targets, target => ({ ...target })), [{ path: file, startLine: target.start, endLine: target.end }]);
    assertFullMethod(result, source, "ReceivePulse");
  });

  test(`${mode}: an outer method parameter keeps the same-name MethodRef unresolved`, options, async t => {
    const source = pointerFixture({ outerParameter: true });
    const { result } = await build(t, source, real);
    const links = Array.from(result.links).filter(link => link.name === "ReceivePulse");
    assert.equal(links.length, 1);
    assertOccurrence(links[0], source, 2, "ReceivePulse");
    assert.equal(links[0].kind, "method-reference");
    assert.equal(links[0].confidence, "unresolved");
    assert.equal(links[0].targets.length, 0);
    assert.equal(result.snippets.some(snippet => snippet.text.includes("callback-target-body")), false);
    assertFullMethod(result, source, "Wire");
  });

  for (const context of ["this", "global"]) {
    test(`${mode}: &${context}.ReceivePulse cannot become a same-file local candidate`, options, async t => {
      const source = pointerFixture({ context });
      const { result } = await build(t, source, real);
      const links = Array.from(result.links).filter(link => link.name === "ReceivePulse");
      assert.equal(links.length, 1);
      assertOccurrence(links[0], source, 2, "ReceivePulse");
      assert.equal(links[0].kind, "method-reference");
      assert.equal(links[0].confidence, "unresolved");
      assert.equal(links[0].targets.length, 0);
      assert.equal(result.snippets.some(snippet => snippet.text.includes("callback-target-body")), false);
      assertFullMethod(result, source, "Wire");
    });
  }
}

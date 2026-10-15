const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { loadSource, root, logger } = require("./service-test-utils.cjs");
const { analyzeProjectChanges, PROJECT_CHANGE_LIMITS: limits } = loadSource("src/projectChangeAnalysis.ts");
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts");
const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");

const hash = text => createHash("sha256").update(text).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const method = (name, body = "    return") => `method ${name}()\n${body}\n;\n`;
const form = handler => `ElementKind: Component\nName: Form\nOnClick: ${handler}\n`;
const oldCode = method("Pulse");
const newCode = method("Pulse", "    return 1");
const project = { "project.yaml": "Name: Test\n" };
const position = (text, offset) => {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines.at(-1).length };
};

function node(kind, text, start, end, attributes = {}, children = [], role) {
  return { kind, startOffset: start, endOffset: end, startLine: position(text, start).line + 1,
    endLine: position(text, end).line + 1, attributes, children, role };
}

// Deterministic protocol fixtures; separate optional tests below use the actual native parser.
function native(text) {
  const children = [];
  const declarationOffsets = new Set();
  for (const match of text.matchAll(/^method ([\p{L}_][\p{L}\p{N}_]*)\(/gmu)) {
    children.push(node("Method", text, match.index, text.length, { name: match[1] }));
    declarationOffsets.add(match.index + "method ".length);
  }
  for (const match of text.matchAll(/([\p{L}_][\p{L}\p{N}_]*)\(/gu)) {
    if (declarationOffsets.has(match.index)) continue;
    const prefix = node("StaticVariableAccess", text, match.index, match.index + match[1].length, { name: match[1] }, [], "prefix");
    children.push(node("StaticMethodInvocation", text, match.index, match.index + match[0].length, {}, [prefix]));
  }
  for (const match of text.matchAll(/&([\p{L}_][\p{L}\p{N}_]*)/gu)) {
    const first = node("StaticVariableAccess", text, match.index + 1, match.index + match[0].length, { name: match[1] }, [], "first");
    children.push(node("MethodRef", text, match.index, match.index + match[0].length, {}, [first]));
  }
  return { status: "ready", sourceHash: hash(text), root: node("Module", text, 0, text.length, {}, children),
    diagnostics: [], partial: false, semanticBound: false, referencesExcluded: true, nodeCount: children.length + 1 };
}

function snapshot(sources) {
  return { workspaceRoot: "/workspace", files: Object.entries(sources).map(([path, text]) => ({ path, hash: hash(text),
    structure: analyzeProjectStructure(path, text) })) };
}

function fixture(beforeFiles, afterFiles, includeProject = true) {
  const before = { ...(includeProject ? project : {}), ...beforeFiles };
  const after = { ...(includeProject ? project : {}), ...afterFiles };
  const reads = [];
  const parses = [];
  const options = { before: snapshot(before), after: snapshot(after), isCurrent: () => true,
    readFile: async path => {
      reads.push(path);
      assert.ok(Object.hasOwn(after, path), `must not read absent/foreign path ${path}`);
      return { text: after[path], hash: hash(after[path]) };
    },
    parse: async text => { parses.push(text); return native(text); },
  };
  return { options, reads, parses, before, after, run: () => analyzeProjectChanges(options) };
}

function language(path, text, positions, target = "Target.xbsl") {
  return { status: "ready", sourceHash: hash(text), uri: pathToFileURL(`/workspace/${path}`).href, queries: positions.map(position => ({
    position: { ...position }, definitionState: "responded", definitions: [{ uri: pathToFileURL(`/workspace/${target}`).href,
      startLine: 1, endLine: 3, startCharacter: 0, endCharacter: 1 }], hover: "", hoverState: "empty",
  })), symbols: [], truncated: false, source: "vscode-language-api", absenceConfirmed: false };
}

const impacts = report => report.findings.filter(finding => finding.kind === "impact");
const handlers = report => report.findings.filter(finding => finding.kind === "yaml-handler");

test("unchanged hashes need no IO; only supported extensions are compared", async () => {
  const f = fixture({ "A.xbsl": oldCode, "README.md": "old" }, { "A.xbsl": oldCode, "README.md": "new" });
  const result = await f.run();
  assert.equal(result.status, "unchanged");
  assert.equal(result.changedPaths.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.parses.length, 0);
  assert.equal(result.checkedPaths.length, 0);
  assert.match(result.limitations.join(" "), /Пустая диагностика не доказывает/);
});

test("added, hash changed and removed-from-index are distinguished, never claimed deletions", async () => {
  const f = fixture({ "A.xbsl": oldCode, "Gone.yaml": form("Pulse") }, { "A.xbsl": newCode, "New.yml": "Name: New\n" });
  const result = await f.run();
  assert.deepEqual(plain(result.changes), [{ path: "A.xbsl", kind: "changed" },
    { path: "Gone.yaml", kind: "removed-from-index" }, { path: "New.yml", kind: "added" }]);
  assert.equal(result.status, "partial");
  assert.ok(result.elementTargets.some(target => target.path === "Gone.yaml" && target.availability === "removed-from-index"));
  assert.ok(!f.reads.includes("Gone.yaml"));
  assert.match(result.limitations.join(" "), /нельзя отличить удаление/);
});

test("current native and YAML syntax are reported without attributing introduction", async () => {
  const f = fixture({ "A.xbsl": oldCode, "A.yaml": form("Pulse") }, { "A.xbsl": newCode, "A.yaml": "Name: [\n" });
  f.options.parse = async text => ({ ...native(text), partial: true, diagnostics: [{ message: "Ожидается выражение", line: 2 }] });
  const result = await f.run();
  const syntax = result.findings.filter(finding => finding.kind === "syntax");
  assert.ok(syntax.some(finding => finding.path === "A.xbsl" && finding.line === 2 && finding.evidence === "ast"));
  assert.ok(syntax.some(finding => finding.path === "A.yaml" && finding.evidence === "yaml"));
  assert.ok(syntax.every(finding => /текущ/.test(finding.message)));
  assert.equal(result.status, "partial");
  for (const name of new Set(f.reads)) assert.equal(f.reads.filter(path => path === name).length, 2, name);
});

test("removed and renamed methods seed call and MethodRef candidates from the old structure", async () => {
  const caller = method("Wire", "    Pulse()\n    val Callback = &Pulse");
  const f = fixture({ "UI/Form.yaml": form("Pulse"), "UI/Form.xbsl": oldCode, "Caller.xbsl": caller },
    { "UI/Form.yaml": form("Pulse"), "UI/Renamed.xbsl": method("Replacement"), "Caller.xbsl": caller });
  const result = await f.run();
  assert.deepEqual(Array.from(impacts(result), item => item.occurrenceKind), ["call", "method-reference"]);
  assert.ok(impacts(result).every(item => item.evidence === "ast" && !item.targets && item.candidatePaths.includes("UI/Form.xbsl")));
  assert.equal(handlers(result)[0].resolution, "unresolved");
  assert.match(handlers(result)[0].message, /отсутствие обработчика не доказано/);
  assert.ok(!f.reads.includes("UI/Form.xbsl"));
});

test("YAML-only handler changes also seed old/new callback occurrences", async () => {
  const caller = method("Wire", "    Pulse()\n    val R = &Next");
  const f = fixture({ "Form.yaml": form("Pulse"), "Caller.xbsl": caller }, { "Form.yaml": form("Next"), "Caller.xbsl": caller });
  const result = await f.run();
  assert.deepEqual(Array.from(impacts(result), item => item.name), ["Pulse", "Next"]);
});

test("handlers use only exact companions and module declarations, including the object module", async () => {
  const yaml = form("Pulse") + "OnOpen: ObjectOnly\nOnClose: Inherited\nOnLoad: Std::Builtin\nOnInit: Nested\n";
  const shared = { "UI/Form.yaml": yaml, "UI/Form.xbsl": oldCode, "UI/Form.Объект.xbsl": oldCode + method("ObjectOnly"),
    "UI/Form.Other.xbsl": method("Inherited"), "Elsewhere/Form.xbsl": method("Inherited"), "Base.xbsl": method("Inherited") };
  const f = fixture(shared, { ...shared, "UI/Form.yaml": yaml + "Inherits: Std::Form\n" });
  f.options.parse = async text => {
    const ast = native(text);
    ast.root.children.push(node("BslStructure", text, 0, text.length, { name: "NestedScope" }, [
      node("Method", text, 0, text.length, { name: "Nested" }),
    ]));
    return ast;
  };
  const result = await f.run();
  const byName = new Map(handlers(result).map(item => [item.name, item]));
  assert.equal(byName.get("Pulse").resolution, "ambiguous");
  assert.equal(byName.get("ObjectOnly").evidence, "structural");
  assert.deepEqual(plain(byName.get("ObjectOnly").candidatePaths), ["UI/Form.Объект.xbsl"]);
  for (const name of ["Inherited", "Std::Builtin", "Nested"]) {
    assert.equal(byName.get(name).evidence, "candidate");
    assert.equal(byName.get(name).resolution, "unresolved");
    assert.ok(!byName.get(name).targets);
    assert.match(byName.get(name).message, /наследование, встроенный/);
  }
});

test("same named forms in other directories/projects never become companion targets", async () => {
  const shared = { "UI/Form.yaml": form("Pulse"), "UI/Form.xbsl": oldCode,
    "Other/Form.yaml": form("Pulse"), "Other/Form.xbsl": oldCode,
    "Nested/project.yaml": "Name: Foreign\n", "Nested/Form.yaml": form("Pulse"),
    "Nested/Form.xbsl": oldCode, "Nested/Caller.xbsl": method("Wire", "    Pulse()") };
  const f = fixture(shared, { ...shared, "UI/Form.xbsl": newCode });
  const result = await f.run();
  assert.deepEqual(Array.from(handlers(result), item => item.path), ["UI/Form.yaml"]);
  assert.deepEqual(plain(handlers(result)[0].candidatePaths), ["UI/Form.xbsl"]);
  assert.ok(!f.reads.some(name => name.startsWith("Nested/")));
  assert.ok(!result.findings.some(item => item.path.startsWith("Nested/")));
});

test("known element module companions retain YAML targets, module handlers and sibling impacts", async () => {
  for (const suffix of ["Объект", "Object", "НаборЗаписей", "RecordSet", "Запись", "Record"]) {
    const module = `UI/Form.${suffix}.xbsl`;
    const shared = { "UI/Form.yaml": form("Pulse"), [module]: oldCode,
      "UI/Form.xbsl": method("Sibling"), "Caller.xbsl": method("Wire", "    Pulse()"),
      "Elsewhere/Form.yaml": form("Pulse"), "Elsewhere/Form.xbsl": oldCode };
    const f = fixture(shared, { ...shared, [module]: newCode });
    f.options.inspect = async (path, positions) => language(path, f.after[path], positions,
      path === "Caller.xbsl" ? "UI/Form.xbsl" : module);
    const result = await f.run();
    assert.ok(f.reads.includes("UI/Form.yaml"), suffix);
    assert.deepEqual(plain(result.elementTargets), [{ path: "UI/Form.yaml", elementKind: "Component", availability: "indexed" }], suffix);
    assert.deepEqual(Array.from(handlers(result), item => item.path), ["UI/Form.yaml"], suffix);
    assert.deepEqual(plain(handlers(result)[0].candidatePaths), [module], suffix);
    assert.equal(handlers(result)[0].evidence, "lsp", suffix);
    assert.equal(impacts(result).length, 1, suffix);
    assert.deepEqual(plain(impacts(result)[0].targets), [{ path: "UI/Form.xbsl", line: 1 }], suffix);
  }
});

test("removed resolver companions still check their current YAML handlers", async () => {
  const shared = { "Form.yaml": form("Pulse"), "Form.НаборЗаписей.xbsl": oldCode };
  const f = fixture(shared, { "Form.yaml": shared["Form.yaml"] });
  const result = await f.run();
  assert.ok(f.reads.includes("Form.yaml"));
  assert.equal(handlers(result).length, 1);
  assert.equal(handlers(result)[0].resolution, "unresolved");
  assert.ok(result.elementTargets.some(item => item.path === "Form.yaml"));
});

test("YAML pairs sharing a resolver companion remain ambiguous", async () => {
  for (const otherYaml of ["Form.yml", "Form.Запись.yaml"]) {
    const shared = { "Form.yaml": form("Pulse"), [otherYaml]: form("Pulse"), "Form.Запись.xbsl": oldCode };
    const result = await fixture(shared, { ...shared, "Form.Запись.xbsl": newCode }).run();
    assert.equal(handlers(result).length, 2, otherYaml);
    assert.ok(handlers(result).every(item => item.resolution === "ambiguous" && item.evidence === "candidate"), otherYaml);
  }
});

test("a vanished nested manifest remains a boundary and never merges into the parent project", async () => {
  const caller = method("Wire", "    Pulse()");
  const f = fixture({ "Target.xbsl": oldCode, "Nested/project.yaml": "Name: Other\n", "Nested/Caller.xbsl": caller },
    { "Target.xbsl": newCode, "Nested/Caller.xbsl": caller });
  const result = await f.run();
  assert.ok(!f.reads.includes("Nested/Caller.xbsl"));
  assert.equal(impacts(result).length, 0);
});

test("without project.yaml search stays in the same directory and is explicitly partial", async () => {
  const shared = { "A/Target.xbsl": oldCode, "A/Caller.xbsl": method("Wire", "    Pulse()"), "B/Caller.xbsl": method("Wire", "    Pulse()") };
  const f = fixture(shared, { ...shared, "A/Target.xbsl": newCode }, false);
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /не найден ближайший project.yaml/);
  assert.deepEqual(Array.from(impacts(result), item => item.path), ["A/Caller.xbsl"]);
  assert.ok(!f.reads.includes("B/Caller.xbsl"));
  const noMethods = fixture({}, { "Empty.xbsl": "// only a comment\n" }, false);
  assert.match((await noMethods.run()).limitations.join(" "), /не найден ближайший project.yaml/);
});

test("current native method names supplement lexical seeds for same-line annotations", async () => {
  const annotated = "@Client method Pulse()\n    return\n;\n";
  const caller = method("Wire", "    Pulse()\n    val R = &Pulse");
  const f = fixture({ "Target.xbsl": annotated, "Caller.xbsl": caller },
    { "Target.xbsl": annotated.replace("return", "return 1"), "Caller.xbsl": caller });
  assert.equal(f.options.before.files.find(file => file.path === "Target.xbsl").structure.symbols.length, 0);
  f.options.parse = async text => {
    const ast = native(text);
    if (text.startsWith("@Client")) ast.root.children = [node("Method", text, 0, text.length, { name: "Pulse" })];
    return ast;
  };
  const result = await f.run();
  assert.equal(impacts(result).length, 2);
  assert.ok(impacts(result).every(item => item.name === "Pulse" && item.evidence === "ast"));
  assert.match(result.limitations.join(" "), /Прежний AST по текущему исходнику не восстанавливается/);
});

test("nested AST methods seed impacts without becoming module-level YAML handlers", async () => {
  for (const kind of ["Method", "AbstractMethod"]) {
    const annotated = "structure Box\n    @Client method Pulse()\n        return\n    ;\n;\n";
    const caller = method("Wire", "    Pulse()\n    val Callback = &Pulse");
    const shared = { "Form.xbsl": annotated, "Form.yaml": form("Pulse"), "Caller.xbsl": caller };
    const f = fixture(shared, { ...shared, "Form.xbsl": annotated.replace("return", "return 1") });
    assert.equal(f.options.before.files.find(file => file.path === "Form.xbsl").structure.symbols.filter(symbol => /method/i.test(symbol.kind)).length, 0);
    f.options.parse = async text => {
      const ast = native(text);
      if (text.startsWith("structure")) ast.root.children = [node("BslStructure", text, 0, text.length, { name: "Box" }, [
        node(kind, text, text.indexOf("@Client"), text.length - 2, { name: "Pulse" }),
      ])];
      return ast;
    };
    const result = await f.run();
    assert.deepEqual(Array.from(impacts(result), item => item.occurrenceKind), ["call", "method-reference"], kind);
    assert.ok(impacts(result).every(item => item.path === "Caller.xbsl" && item.candidatePaths.includes("Form.xbsl")), kind);
    assert.equal(handlers(result)[0].resolution, "unresolved", kind);
    assert.deepEqual(plain(handlers(result)[0].candidatePaths), [], kind);
  }
});

test("unavailable native syntax and source-name prefilter do not invent diagnostics or calls", async () => {
  const shared = { "Target.xbsl": oldCode, "Caller.xbsl": method("Wire", "    Pulse()"), "Irrelevant.xbsl": method("Other") };
  const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
  const calls = [];
  f.options.parse = async text => { calls.push(text); return { ...native(text), status: "unavailable", root: undefined, code: "parser_not_found" }; };
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.ok(!result.findings.some(finding => finding.kind === "syntax"));
  assert.ok(impacts(result).every(item => item.evidence === "candidate" && !item.occurrenceKind));
  assert.ok(!calls.includes(shared["Irrelevant.xbsl"]));
  assert.match(result.limitations.join(" "), /отсутствие ошибок не подтверждено/);
});

test("cyclic ASTs and YAML aliases are bounded and reported as limitations, not clean syntax", async () => {
  const f = fixture({}, { "A.xbsl": oldCode, "A.yaml": "Root: &a\n  Self: *a\n" });
  f.options.parse = async text => { const ast = native(text); ast.root.children.push(ast.root); return ast; };
  const started = Date.now();
  const result = await f.run();
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /циклич/);
  assert.equal(result.findings.filter(item => item.evidence === "ast").length, 0);
});

test("oversized/deep trees are rejected before shared AST traversal", async () => {
  for (const mode of ["depth", "nodes"]) {
    const f = fixture({}, { "A.xbsl": oldCode });
    f.options.parse = async text => {
      const ast = native(text);
      if (mode === "nodes") ast.root.children = Array.from({ length: limits.astNodes + 1 }, () => node("X", text, 0, 1));
      else {
        let parent = ast.root;
        for (let index = 0; index <= limits.astDepth; index++) {
          const child = node("X", text, 0, 1); parent.children = [child]; parent = child;
        }
      }
      return ast;
    };
    assert.match((await f.run()).limitations.join(" "), /лимит обхода/);
  }
});

test("every read checks both callback hash and actual text against the snapshot", async () => {
  for (const mode of ["hash", "text"]) {
    const f = fixture({}, { "A.xbsl": oldCode });
    f.options.readFile = async () => ({ text: mode === "text" ? newCode : oldCode, hash: mode === "hash" ? hash(newCode) : hash(oldCode) });
    const result = await f.run();
    assert.equal(result.status, "stale", mode);
    assert.equal(result.findings.length, 0);
    assert.equal(f.parses.length, 0);
  }
});

test("final revalidation clears all findings including dependencies when any used file changes", async () => {
  for (const changed of ["Target.xbsl", "Caller.xbsl", "project.yaml", "NoNames.xbsl"]) {
    const shared = { "Target.xbsl": oldCode, "Caller.xbsl": method("Wire", "    Pulse()"), "NoNames.xbsl": method("Other") };
    const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
    const read = f.options.readFile;
    let count = 0;
    f.options.readFile = async name => {
      const source = await read(name);
      if (name === changed && ++count === 2) return { text: source.text + "\n", hash: source.hash };
      return source;
    };
    const result = await f.run();
    assert.equal(result.status, "stale", changed);
    assert.equal(result.findings.length, 0);
    assert.equal(result.checkedPaths.length, 0);
    assert.equal(result.elementTargets.length, 0);
  }
});

test("epoch false/throws and stale AST replies fail closed", async () => {
  for (const mode of ["false", "throw", "during-parse", "ast-hash"]) {
    const f = fixture({}, { "A.xbsl": oldCode });
    if (mode === "false") f.options.isCurrent = () => false;
    if (mode === "throw") f.options.isCurrent = () => { throw new Error("epoch failed"); };
    if (mode === "during-parse") f.options.parse = async text => { f.options.isCurrent = () => false; return native(text); };
    if (mode === "ast-hash") f.options.parse = async text => ({ ...native(text), sourceHash: "wrong" });
    const result = await f.run();
    assert.equal(result.status, "stale", mode);
    assert.equal(result.findings.length, 0);
  }
});

test("callback synchronous throws/rejections are contained; failed snapshot reads are stale", async () => {
  for (const callback of ["readFile", "parse", "inspect"]) {
    for (const sync of [false, true]) {
      const f = fixture({ "Form.xbsl": oldCode, "Form.yaml": form("Pulse") }, { "Form.xbsl": newCode, "Form.yaml": form("Pulse") });
      f.options[callback] = () => { if (sync) throw new Error("failure"); return Promise.reject(new Error("failure")); };
      const result = await f.run();
      assert.equal(result.status, callback === "readFile" ? "stale" : "partial", `${callback}/${sync}`);
      assert.match(result.limitations.join(" "), /ошибк/);
    }
  }
});

test("abort bounds never-settling read/parse/inspect callbacks; parser gets the abort signal", async () => {
  for (const callback of ["readFile", "parse", "inspect"]) {
    const f = fixture({ "Form.xbsl": oldCode, "Form.yaml": form("Pulse") }, { "Form.xbsl": newCode, "Form.yaml": form("Pulse") });
    const controller = new AbortController();
    f.options.signal = controller.signal;
    let parserAborted = false;
    let calls = 0;
    f.options[callback] = (_value, signal) => {
      calls++;
      if (callback === "parse") signal.addEventListener("abort", () => { parserAborted = true; });
      setTimeout(() => controller.abort(), 15);
      return new Promise(() => {});
    };
    const started = Date.now();
    const result = await f.run();
    assert.ok(Date.now() - started < 1000, callback);
    assert.equal(calls, 1);
    assert.ok(["stale", "partial"].includes(result.status));
    assert.equal(result.findings.length, 0);
    if (callback === "parse") assert.equal(parserAborted, true);
  }
});

test("a timed-out callback is not restarted and late rejection cannot mutate the returned report", async () => {
  const f = fixture({}, { "A.xbsl": oldCode, "B.xbsl": newCode });
  let reject;
  let calls = 0;
  f.options.readFile = () => { calls++; return new Promise((_resolve, failure) => { reject = failure; }); };
  const result = await f.run();
  assert.equal(calls, 1);
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /время ожидания/);
  const saved = JSON.stringify(result);
  reject(new Error("late failure"));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(result), saved);
});

test("final read failures/hangs never return earlier unverified findings", async () => {
  for (const hangs of [false, true]) {
    const f = fixture({ "Target.xbsl": oldCode }, { "Target.xbsl": newCode });
    const controller = new AbortController();
    f.options.signal = controller.signal;
    const read = f.options.readFile;
    const seen = new Set();
    f.options.readFile = name => {
      if (seen.has(name)) {
        if (!hangs) throw new Error("epoch");
        setTimeout(() => controller.abort(), 15); return new Promise(() => {});
      }
      seen.add(name); return read(name);
    };
    const result = await f.run();
    assert.equal(result.status, "stale");
    assert.equal(result.findings.length, 0);
    assert.equal(result.checkedPaths.length, 0);
  }
});

test("one total deadline covers all callbacks and reserves final verification", async () => {
  const original = Date.now;
  let elapsed = 0;
  Date.now = () => original() + elapsed;
  try {
    const f = fixture({ "A.xbsl": oldCode, "B.xbsl": oldCode }, { "A.xbsl": newCode, "B.xbsl": newCode });
    let parses = 0;
    f.options.parse = async text => { parses++; elapsed += limits.deadlineMs + 1; return native(text); };
    const result = await f.run();
    assert.equal(parses, 1);
    assert.equal(result.status, "stale");
    assert.equal(result.findings.length, 0);
    assert.match(result.limitations.join(" "), /общий срок/);
  } finally { Date.now = original; }
});

test("LSP resolves only requested positions with current source and same-project targets", async () => {
  const caller = method("Wire", "    Pulse()\n    val R = &Pulse");
  const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
  f.options.inspect = async (path, positions) => language(path, f.after[path], positions);
  const result = await f.run();
  assert.equal(result.status, "checked");
  assert.equal(impacts(result).length, 2);
  for (const impact of impacts(result)) {
    assert.equal(impact.evidence, "lsp");
    assert.deepEqual(plain(impact.targets), [{ path: "Target.xbsl", line: 1 }]);
  }
});

test("empty, foreign, ambiguous, truncated, wrong URI and unrequested LSP responses cannot bind names", async () => {
  for (const mode of ["empty", "foreign", "ambiguous", "truncated", "wrong-uri", "position", "missing-hash", "outside"]) {
    const caller = method("Wire", "    Pulse()");
    const shared = { "Target.xbsl": oldCode, "Other.xbsl": oldCode, "Caller.xbsl": caller,
      "Foreign/project.yaml": "Name: Foreign\n", "Foreign/Target.xbsl": oldCode };
    const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
    f.options.inspect = async (path, positions) => {
      const result = language(path, f.after[path], positions, mode === "foreign" ? "Foreign/Target.xbsl" : mode === "outside" ? "../outside.xbsl" : "Target.xbsl");
      if (mode === "empty") { result.queries[0].definitions = []; result.queries[0].definitionState = "empty"; }
      if (mode === "ambiguous") result.queries[0].definitions.push({ ...result.queries[0].definitions[0], uri: "file:///workspace/Other.xbsl" });
      if (mode === "truncated") result.truncated = true;
      if (mode === "wrong-uri") result.uri = "file:///workspace/Other.xbsl";
      if (mode === "position") { positions[0].line = 999; result.queries[0].position.line = 999; }
      if (mode === "missing-hash") delete result.sourceHash;
      return result;
    };
    const result = await f.run();
    assert.equal(impacts(result).length, 1, mode);
    assert.equal(impacts(result)[0].evidence, "ast", mode);
    assert.ok(!impacts(result)[0].targets, mode);
    assert.equal(result.status, "partial", mode);
    assert.ok(!f.reads.some(name => name.startsWith("Foreign/")), mode);
  }
});

test("LSP validates complete target and selection ranges against current UTF-16 lines", async () => {
  const caller = method("Wire", "    Pulse()");
  const invalidRanges = [
    { endLine: 9 }, { startLine: 0 }, { startLine: 1.5 }, { endLine: Infinity },
    { startCharacter: -1 }, { startCharacter: 999 }, { startCharacter: 0.5 },
    { endCharacter: -1 }, { endCharacter: 2 }, { endCharacter: NaN },
    { startLine: 3, endLine: 2 }, { endLine: 1, startCharacter: 8, endCharacter: 7 },
    { endCharacter: undefined },
  ];
  for (const selection of [false, true]) {
    for (const override of invalidRanges) {
      const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
      f.options.inspect = async (path, positions) => {
        const result = language(path, f.after[path], positions);
        const target = result.queries[0].definitions[0];
        if (selection) target.selectionRange = { ...target, ...override };
        else Object.assign(target, override);
        return result;
      };
      const result = await f.run();
      assert.equal(impacts(result).length, 1);
      assert.equal(impacts(result)[0].evidence, "ast", `${selection}/${JSON.stringify(override)}`);
      assert.ok(!impacts(result)[0].targets);
      assert.equal(result.status, "partial");
    }
  }
});

test("valid selection ranges cannot mask invalid targets or escape their target range", async () => {
  const caller = method("Wire", "    Pulse()");
  for (const mode of ["target-eof", "selection-before", "selection-after", "selection-null"]) {
    const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
    f.options.inspect = async (path, positions) => {
      const result = language(path, f.after[path], positions);
      const target = result.queries[0].definitions[0];
      target.selectionRange = { startLine: 1, startCharacter: 7, endLine: 1, endCharacter: 12 };
      if (mode === "target-eof") target.endLine = 9;
      if (mode === "selection-before") target.startCharacter = 8;
      if (mode === "selection-after") { target.endLine = 1; target.endCharacter = 11; }
      if (mode === "selection-null") target.selectionRange = null;
      return result;
    };
    const result = await f.run();
    assert.equal(impacts(result)[0].evidence, "ast", mode);
    assert.ok(!impacts(result)[0].targets, mode);
    assert.equal(result.status, "partial", mode);
  }
});

test("LSP keeps distinct same-line target and selection ranges ambiguous but deduplicates exact repeats", async () => {
  const caller = method("Wire", "    Pulse()");
  for (const mode of ["target-start", "target-end", "selection-start", "selection-end", "exact-repeat"]) {
    const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
    f.options.inspect = async (path, positions) => {
      const result = language(path, f.after[path], positions);
      const target = result.queries[0].definitions[0];
      target.selectionRange = { startLine: 1, startCharacter: 7, endLine: 1, endCharacter: 12 };
      const other = { ...target, selectionRange: { ...target.selectionRange } };
      if (mode === "target-start") other.startCharacter++;
      if (mode === "target-end") other.endCharacter--;
      if (mode === "selection-start") other.selectionRange.startCharacter++;
      if (mode === "selection-end") other.selectionRange.endCharacter--;
      result.queries[0].definitions.push(other);
      return result;
    };
    const result = await f.run();
    assert.equal(impacts(result)[0].evidence, mode === "exact-repeat" ? "lsp" : "ast", mode);
    assert.equal(result.status, mode === "exact-repeat" ? "checked" : "partial", mode);
  }
});

test("LSP uses UTF-16 columns, excludes CRLF units and permits exact EOF boundaries", async () => {
  const caller = method("Wire", "    Pulse()");
  for (const newline of ["\n", "\r\n", "\r"]) {
    const old = "// 😀\n" + oldCode.trimEnd();
    const current = ("// 😀\n" + newCode.trimEnd()).replaceAll("\n", newline);
    for (const extra of [0, 1, 2]) {
      const f = fixture({ "Target.xbsl": old, "Caller.xbsl": caller }, { "Target.xbsl": current, "Caller.xbsl": caller });
      f.options.inspect = async (path, positions) => {
        const result = language(path, f.after[path], positions);
        Object.assign(result.queries[0].definitions[0], { startLine: 1, startCharacter: "// 😀".length + extra,
          endLine: 4, endCharacter: 1,
          selectionRange: { startLine: 2, startCharacter: 7, endLine: 2, endCharacter: 12 } });
        return result;
      };
      const result = await f.run();
      assert.equal(impacts(result)[0].evidence, extra ? "ast" : "lsp", `${JSON.stringify(newline)}/${extra}`);
      if (!extra) assert.deepEqual(plain(impacts(result)[0].targets), [{ path: "Target.xbsl", line: 2 }]);
    }
  }
});

test("LSP source changes invalidate everything; a verified different target removes a name-only impact", async () => {
  for (const stale of [false, true]) {
    const caller = method("Wire", "    Pulse()");
    const shared = { "Target.xbsl": oldCode, "Other.xbsl": oldCode, "Caller.xbsl": caller };
    const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
    f.options.inspect = async (path, positions) => ({ ...language(path, f.after[path], positions, "Other.xbsl"), ...(stale ? { sourceHash: "old-buffer" } : {}) });
    const result = await f.run();
    assert.equal(result.status, stale ? "stale" : "checked");
    assert.equal(impacts(result).length, 0);
  }
});

test("no epoch guard makes even verified reads partial", async () => {
  const f = fixture({}, { "A.xbsl": oldCode });
  delete f.options.isCurrent;
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /не атомарно/);
});

test("file, parse and finding caps are explicit and never exceeded", async () => {
  const shared = { "Target.xbsl": oldCode };
  for (let index = 0; index < 430; index++) shared[`Caller${index}.xbsl`] = method(`Wire${index}`, "    Pulse()");
  const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
  const result = await f.run();
  assert.equal(f.parses.length, limits.parses);
  assert.equal(result.counts.filesRead, limits.files);
  assert.ok(f.reads.length <= limits.files * 2);
  assert.ok(result.findings.length <= limits.findings);
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /40 разборов/);
  assert.match(result.limitations.join(" "), /400 файлами/);
});

test("byte caps include reserved revalidation; oversized individual files are skipped", async () => {
  const shared = { "Target.xbsl": oldCode, "Huge.xbsl": "/".repeat(limits.fileBytes + 1) };
  for (let index = 0; index < 8; index++) shared[`Padding${index}.xbsl`] = `//${".".repeat(400_000)}`;
  const f = fixture(shared, { ...shared, "Target.xbsl": newCode });
  const result = await f.run();
  assert.ok(result.counts.sourceBytes <= limits.sourceBytes);
  assert.ok(result.counts.sourceBytes + result.counts.verifiedBytes <= limits.totalBytes);
  assert.equal(f.parses.length, 1);
  assert.match(result.limitations.join(" "), /Huge.xbsl: превышен лимит/);
  assert.equal(result.status, "partial");
});

test("repeated occurrences, LSP positions and output are independently capped", async () => {
  const caller = method("Wire", Array.from({ length: 450 }, () => "    Pulse()").join("\n"));
  const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
  const inspected = [];
  f.options.inspect = async (path, positions) => { inspected.push(positions.length); return language(path, f.after[path], positions); };
  const result = await f.run();
  assert.equal(result.findings.length, limits.findings);
  assert.ok(inspected.every(count => count <= limits.positions));
  assert.equal(result.status, "partial");
  assert.match(result.limitations.join(" "), /Замечания ограничены/);
});

test("candidate-path truncation and omitted limitation details remain explicit", async () => {
  const before = { "Caller.xbsl": method("Wire", "    Pulse()") };
  const after = { ...before };
  for (let index = 0; index < 25; index++) {
    before[`Target${index}.xbsl`] = oldCode;
    after[`Target${index}.xbsl`] = newCode;
  }
  const result = await fixture(before, after).run();
  assert.equal(impacts(result)[0].candidatePaths.length, 20);
  assert.match(result.limitations.join(" "), /пути кандидатов.*20 записями/);
  const manyRemoved = {};
  for (let index = 0; index < 150; index++) manyRemoved[`Removed${index}.xbsl`] = oldCode;
  const removed = await fixture(manyRemoved, {}).run();
  assert.ok(removed.omittedLimitations > 0);
  assert.ok(removed.limitations.length <= limits.limitations);
  assert.match(removed.limitations.at(-1), /сообщения об ограничениях свёрнуты/);
});

test("invalid roots, duplicate normalized paths and oversized indexes cannot look successful", async () => {
  const f = fixture({}, { "A.xbsl": oldCode });
  f.options.after.workspaceRoot = "/other";
  assert.equal((await f.run()).status, "stale");
  f.options.after.workspaceRoot = "/workspace";
  f.options.after.files.push({ ...f.options.after.files[1], path: "./A.xbsl" });
  assert.equal((await f.run()).status, "stale");
  f.options.after.files = Array.from({ length: limits.indexFiles + 1 }, () => ({ path: "A.xbsl", hash: hash(oldCode) }));
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.equal(f.reads.length, 0);
});

test("foreign absolute/drive/UNC and escaping paths are never sent to read callbacks", async () => {
  const f = fixture({}, {});
  for (const path of ["f:/outside/Bad.xbsl", "C:Bad.xbsl", "C:\\outside\\Bad.xbsl", "\\\\workspace\\Bad.xbsl",
    "//workspace/Bad.xbsl", "/outside/Bad.xbsl", "../Bad.xbsl", "\u0000Bad.xbsl"]) {
    f.options.after.files.push({ path, hash: hash(oldCode) });
  }
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.equal(result.changedPaths.length, 0);
  assert.equal(f.reads.length, 0);
});

test("all engine explanations are Russian; raw parser diagnostics keep their original wording", async () => {
  const f = fixture({ "Form.xbsl": oldCode, "Form.yaml": form("Pulse") }, { "Form.xbsl": newCode, "Form.yaml": form("Absent") });
  const result = await f.run();
  for (const text of [...result.limitations, ...result.findings.map(item => item.message)]) assert.match(text, /[А-Яа-яЁё]/u, text);
});

const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;

function realParser(t) {
  const service = new NativeXbslAstService(root, logger, { parserJarPath: realJar, timeoutMs: 30_000 });
  t.after(() => service.dispose());
  return (text, signal) => service.parse(text, { signal });
}

test("real native AST: callback, namespace, receiver, CRLF and exact UTF-16 positions", { skip: !realJar }, async t => {
  const caller = ["method Wire(Pulse: Object)", "    Outer(\"😀\", &Pulse)", "    Namespace::Pulse()", "    Receiver.Pulse()",
    "    val R = &Receiver.Pulse", ";", ""].join("\r\n");
  const f = fixture({ "Target.xbsl": oldCode, "Caller.xbsl": caller }, { "Target.xbsl": newCode, "Caller.xbsl": caller });
  f.options.parse = realParser(t);
  const points = [];
  f.options.inspect = async (path, positions) => {
    points.push(...positions);
    return { ...language(path, f.after[path], []), status: "partial" };
  };
  const result = await f.run();
  const found = impacts(result);
  assert.equal(found.length, 4, JSON.stringify(result));
  assert.deepEqual(Array.from(found, item => item.occurrenceKind), ["method-reference", "call", "call", "method-reference"]);
  assert.ok(found.every(item => item.evidence === "ast" && !item.targets));
  assert.ok(found.some(item => item.occurrence === "Namespace::Pulse"));
  assert.ok(found.some(item => item.occurrence === "Receiver.Pulse"));
  for (const point of points) assert.equal(caller.split(/\r\n/)[point.line].slice(point.character, point.character + 5), "Pulse");
});

for (const suffix of ["Объект", "Object", "НаборЗаписей", "Запись"]) {
  test(`real native AST: ${suffix} companion excludes nested and inherited handlers`, { skip: !realJar }, async t => {
    const yaml = form("Pulse") + "OnOpen: Inherited\nInherits: Std::Form\n";
    const code = "structure Box\n    method Pulse()\n        return\n    ;\n;\n";
    const companion = `Form.${suffix}.xbsl`;
    const shared = { "Form.yaml": yaml, "Form.xbsl": code, [companion]: oldCode };
    const f = fixture(shared, { ...shared, [companion]: newCode });
    f.options.parse = realParser(t);
    const result = await f.run();
    const pulse = handlers(result).find(item => item.name === "Pulse");
    assert.equal(pulse.evidence, "structural", JSON.stringify(result));
    assert.deepEqual(plain(pulse.candidatePaths), [companion]);
    assert.equal(handlers(result).find(item => item.name === "Inherited").evidence, "candidate");
  });
}

test("real native AST: current syntax diagnostics survive recovery without claiming introduction", { skip: !realJar }, async t => {
  const f = fixture({ "Target.xbsl": oldCode }, { "Target.xbsl": "method Pulse(\n" });
  f.options.parse = realParser(t);
  const result = await f.run();
  assert.ok(result.findings.some(item => item.kind === "syntax" && item.evidence === "ast" && /текущего/.test(item.message)), JSON.stringify(result));
});

test("real native AST: same-line annotated method seeds impacts despite absent lexical declarations", { skip: !realJar }, async t => {
  const annotated = "@Client method Pulse()\n    return\n;\n";
  const caller = method("Wire", "    Pulse()\n    val Callback = &Pulse");
  const f = fixture({ "Target.xbsl": annotated, "Caller.xbsl": caller },
    { "Target.xbsl": annotated.replace("return", "return 1"), "Caller.xbsl": caller });
  assert.equal(f.options.before.files.find(file => file.path === "Target.xbsl").structure.symbols.length, 0);
  f.options.parse = realParser(t);
  const result = await f.run();
  assert.deepEqual(Array.from(impacts(result), item => item.occurrenceKind), ["call", "method-reference"], JSON.stringify(result));
});

test("real native AST: same-line annotated structure method impacts its receiver call, not a YAML binding", { skip: !realJar }, async t => {
  const target = "структура РасчетСкидки\n    @ВПроекте метод Рассчитать(Сумма: Число): Число\n        возврат Сумма * 0.1\n    ;\n;\n";
  const caller = "метод Обновить(Правило: РасчетСкидки): Число\n    возврат Правило.Рассчитать(100)\n;\n";
  const shared = { "Pricing.xbsl": target, "Pricing.yaml": form("Рассчитать"), "Cart.xbsl": caller };
  const f = fixture(shared, { ...shared, "Pricing.xbsl": target.replace("0.1", "0.2") });
  assert.equal(f.options.before.files.find(file => file.path === "Pricing.xbsl").structure.symbols.filter(item => /method/i.test(item.kind)).length, 0);
  f.options.parse = realParser(t);
  const result = await f.run();
  assert.ok(f.reads.includes("Cart.xbsl"));
  assert.equal(result.findings.filter(item => item.kind === "syntax").length, 0, JSON.stringify(result));
  assert.equal(impacts(result).length, 1, JSON.stringify(result));
  assert.equal(impacts(result)[0].occurrence, "Правило.Рассчитать");
  assert.equal(impacts(result)[0].evidence, "ast");
  assert.deepEqual(plain(impacts(result)[0].candidatePaths), ["Pricing.xbsl"]);
  assert.equal(handlers(result)[0].resolution, "unresolved");
  assert.deepEqual(plain(handlers(result)[0].candidatePaths), []);
});

test("real native AST: different parameter definitions on the same line are not one LSP target", { skip: !realJar }, async t => {
  const target = "метод Настроить(Основная: ()->Число, Резервная: ()->Число)\n    возврат\n;\nметод Ставка(): Число\n    возврат 1\n;\n";
  const caller = "метод Обновить(): Число\n    возврат Ставка()\n;\n";
  const shared = { "Rates.xbsl": target, "Invoice.xbsl": caller };
  const f = fixture(shared, { ...shared, "Rates.xbsl": target.replace("возврат 1", "возврат 3") });
  f.options.parse = realParser(t);
  const ast = await f.options.parse(f.after["Rates.xbsl"]);
  assert.equal(ast.status, "ready");
  assert.equal(ast.partial, false, JSON.stringify(ast.diagnostics));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const parameters = flatten(ast.root).filter(node => ["Основная", "Резервная"].includes(node.attributes.name));
  assert.equal(parameters.length, 2);
  assert.equal(parameters[0].startLine, parameters[1].startLine);
  f.options.inspect = async (path, positions) => {
    const result = language(path, f.after[path], positions, "Rates.xbsl");
    result.queries[0].definitions = parameters.map(node => ({ uri: "file:///workspace/Rates.xbsl",
      startLine: node.startLine, startCharacter: position(f.after["Rates.xbsl"], node.startOffset).character,
      endLine: node.endLine, endCharacter: position(f.after["Rates.xbsl"], node.endOffset).character }));
    return result;
  };
  const result = await f.run();
  assert.equal(impacts(result).length, 1, JSON.stringify(result));
  assert.equal(impacts(result)[0].evidence, "ast");
  assert.ok(!impacts(result)[0].targets);
  assert.equal(result.status, "partial");
});

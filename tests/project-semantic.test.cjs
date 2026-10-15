const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { test } = require("node:test");
const { loadSource, logger, root: pluginRoot } = require("./service-test-utils.cjs");

const uri = (file) => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const vscode = { Uri: { file: uri, parse: (value) => uri(fileURLToPath(value)) } };
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts");
const { ProjectSemanticService, isCompanion, isElementModuleCompanion } = loadSource("src/projectSemanticService.ts", { vscode });
const emptyLanguage = () => ({ status: "unavailable", symbols: [], queries: [] });
const unavailableAst = { parse: async () => ({ status: "unavailable", diagnostics: [], reason: "test" }) };

function request(sources, query = "Применить", selected = "A/Form.yaml") {
  return {
    workspaceRoot: path.resolve("/workspace"), query,
    files: Object.entries(sources).map(([name, text]) => ({ path: name, hash: "test", structure: analyzeProjectStructure(name, text) })),
    selected: [{ path: selected, startLine: 1, endLine: 10, symbols: [] }],
    readFile: async (name) => ({ text: sources[name], startLine: 1, endLine: sources[name].split("\n").length, truncated: false, fromOpenDocument: false }),
  };
}
const form = "ВидЭлемента: КомпонентИнтерфейса\nИмя: Form\nНаследует:\n  Тип: Форма<Булево>\n  ПриНажатии: Применить\n";
const method = "метод Применить()\n    возврат\n;\n";

test("confirmed element modules are stricter than filename retrieval candidates", () => {
  for (const suffix of ["", ".Объект", ".Object", ".НаборЗаписей", ".RecordSet", ".Запись", ".Record"]) {
    assert.equal(isElementModuleCompanion("A/Form.yaml", `A/Form${suffix}.xbsl`), true);
    assert.equal(isElementModuleCompanion(`A/Form${suffix}.XBSL`, "A/Form.yml"), true);
  }
  for (const name of ["A/Form.Other.xbsl", "A/Form.Объект.Other.xbsl", "A/FormOther.xbsl", "B/Form.xbsl"]) {
    assert.equal(isElementModuleCompanion("A/Form.yaml", name), false, name);
  }
  assert.equal(isCompanion("A/Form.yaml", "A/Form.Other.xbsl"), true, "stage-2 broad retrieval remains unchanged");
});

test("YAML handler selects only the companion XBSL, not a same-named method elsewhere", async () => {
  const service = new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger);
  const result = await service.buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": method, "B/Other.xbsl": method }));
  const link = result.links.find((item) => item.name === "Применить");
  assert.equal(link.confidence, "structural");
  assert.deepEqual(Array.from(link.targets, (target) => target.path), ["A/Form.xbsl"]);
  assert.ok(result.snippets.some((snippet) => snippet.path === "A/Form.xbsl" && snippet.text.includes("возврат")));
  assert.ok(result.documentationQueries.includes("Форма"));
});

test("a first-line BOM is not lexical nesting, while indentation after the BOM remains nesting", async () => {
  for (const [code, expected] of [[`\uFEFF${method.replace(/\n/g, "\r\n")}`, "structural"], [`\uFEFF    ${method}`, "unresolved"]]) {
    const result = await new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger)
      .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }));
    assert.equal(result.links.find((link) => link.kind === "handler" && link.name === "Применить").confidence, expected);
  }
});

test("duplicate companion declarations stay ambiguous; missing targets stay unresolved", async () => {
  const service = new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger);
  const result = await service.buildContext(request({ "A/Form.yaml": form + "ДругойОбработчик: НетМетода\n", "A/Form.xbsl": method, "A/Form.Объект.xbsl": method }));
  assert.equal(result.links.find((link) => link.name === "Применить").confidence, "ambiguous");
  assert.equal(isCompanion("A/Form.yaml", "B/Form.xbsl"), false);
  assert.equal(isCompanion("A/Form.yaml", "A/FormOther.xbsl"), false);
});

test("native AST exact range replaces lexical range and every nested node remains available", async () => {
  const code = "метод Применить()\n    возврат\n;\n// not part of method\n";
  const node = { kind: "Method", startOffset: 0, endOffset: code.indexOf("//"), startLine: 1, endLine: 3,
    attributes: { name: "Применить" }, children: [{ kind: "ReturnStatement", startOffset: 21, endOffset: 28, startLine: 2, endLine: 2, attributes: {}, children: [] }] };
  const ast = { parse: async () => ({ status: "ready", root: node, diagnostics: [], parserVersion: "test" }) };
  const result = await new ProjectSemanticService(ast, { inspect: async () => emptyLanguage() }, logger)
    .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }));
  const snippet = result.snippets.find((item) => item.source === "native-ast");
  assert.equal(snippet.endLine, 3);
  assert.equal(snippet.text.includes("not part"), false);
});

test("LSP definitions are used only inside indexed workspace and stale source hashes are rejected", async () => {
  const language = { inspect: async () => ({ status: "ready", symbols: [], queries: [{ position: { line: 0, character: 6 }, hover: "method Применить()", definitions: [
    { uri: pathToFileURL(path.resolve("/workspace/A/Target.xbsl")).href, startLine: 1, endLine: 3 },
    { uri: pathToFileURL(path.resolve("/outside/secret.xbsl")).href, startLine: 1, endLine: 3 },
  ] }] }) };
  const input = request({ "A/Form.yaml": form, "A/Form.xbsl": method, "A/Target.xbsl": method });
  const result = await new ProjectSemanticService(unavailableAst, language, logger).buildContext(input);
  const definition = result.links.find((link) => link.confidence === "lsp");
  assert.equal(definition.targets.length, 1);
  assert.equal(definition.targets[0].path, "A/Target.xbsl");
  language.inspect = async () => ({ status: "ready", sourceHash: "changed", symbols: [], queries: [{ position: { line: 0, character: 6 }, hover: "STALE", definitions: [] }] });
  const stale = await new ProjectSemanticService(unavailableAst, language, logger).buildContext(input);
  assert.equal(stale.hovers.length, 0);
  assert.ok(stale.diagnostics.some((text) => text.includes("изменился")));
  assert.equal(stale.snippets.length, 0);
  assert.equal(stale.links.length, 0);
});

test("YAML is inspected by the running language provider at handler and type positions", async () => {
  const calls = [];
  await new ProjectSemanticService(unavailableAst, { inspect: async (uri, positions) => {
    calls.push({ path: uri.fsPath, positions }); return emptyLanguage();
  } }, logger).buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": method }));
  const yaml = calls.find((call) => call.path.endsWith("Form.yaml"));
  assert.ok(yaml.positions.some((position) => position.line === 4 && position.character === 14));
});

test("workspace-root project links nested YAML types without crossing a nested project", async () => {
  const result = await new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger).buildContext(request({
    "project.yaml": "Имя: Root\n", "A/Form.yaml": form.replace("Форма<Булево>", "Item"),
    "Types/Item.yaml": "Имя: Item\nВидЭлемента: Структура\n",
    "Nested/project.yaml": "Имя: Other\n", "Nested/Item.yaml": "Имя: Item\n",
  }));
  const link = result.links.find((item) => item.name === "Item");
  assert.equal(link.confidence, "candidate");
  assert.deepEqual(Array.from(link.targets, (target) => target.path), ["Types/Item.yaml"]);
});

test("only Method and Function LSP kinds can become YAML handler candidates", async () => {
  for (const kind of [5, 11, 6, 25]) {
    const language = { inspect: async (uri) => ({ ...emptyLanguage(), status: "ready", symbols: uri.fsPath.endsWith(".xbsl")
      ? [{ name: "Применить", kind, startLine: 1, endLine: 1 }] : [] }) };
    const result = await new ProjectSemanticService(unavailableAst, language, logger)
      .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": "// empty\n" }));
    assert.equal(result.links.find((link) => link.name === "Применить").confidence, [5, 11].includes(kind) ? "structural" : "unresolved");
  }
});

test("nested Method/Function LSP symbols remain query context but never module handlers", async () => {
  for (const kind of [5, 11]) {
    for (const hierarchy of ["container-name", "containing-range"]) {
      const language = { inspect: async (uri) => ({ ...emptyLanguage(), status: "ready", symbols: uri.fsPath.endsWith(".xbsl") ? [
        ...(hierarchy === "containing-range" ? [{ name: "Контейнер", kind: 22, startLine: 1, endLine: 5 }] : []),
        { name: "Применить", kind, startLine: 2, endLine: 4, ...(hierarchy === "container-name" ? { containerName: "Контейнер" } : {}) },
      ] : [] }) };
      const code = "структура Контейнер\n    метод Применить()\n        возврат\n    ;\n;\n";
      const result = await new ProjectSemanticService(unavailableAst, language, logger)
        .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }));
      assert.equal(result.links.find((link) => link.name === "Применить").confidence, "unresolved", `${kind}/${hierarchy}`);
      assert.ok(result.snippets.some((snippet) => snippet.startLine === 2 && snippet.text.includes("метод Применить")));
    }
  }
});

test("LSP file/module wrappers allow module methods, while real duplicate declarations stay ambiguous", async () => {
  for (const wrapper of [0, 1]) {
    const code = method + method;
    const language = { inspect: async (uri) => ({ ...emptyLanguage(), status: "ready", symbols: uri.fsPath.endsWith(".xbsl") ? [
      { name: "Form", kind: wrapper, startLine: 1, endLine: 7 },
      { name: "Применить", kind: 5, startLine: 1, endLine: 3, containerName: "Form" },
      { name: "Применить", kind: 11, startLine: 4, endLine: 6, containerName: "Form" },
    ] : [] }) };
    const result = await new ProjectSemanticService(unavailableAst, language, logger)
      .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }));
    const handler = result.links.find((link) => link.name === "Применить");
    assert.equal(handler.confidence, "ambiguous");
    assert.deepEqual(Array.from(handler.targets, (target) => target.startLine).sort(), [1, 4]);
  }
});

test("final snapshot validation excludes methods edited after analysis", async () => {
  const input = request({ "A/Form.yaml": form, "A/Form.xbsl": method });
  const read = input.readFile;
  let codeReads = 0;
  input.readFile = async (file) => {
    const result = await read(file);
    if (file.endsWith(".xbsl") && ++codeReads > 1) result.text = "// changed\n";
    return result;
  };
  const result = await new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger).buildContext(input);
  assert.equal(result.snippets.some((snippet) => snippet.path.endsWith(".xbsl")), false);
  assert.equal(result.links.some((link) => link.targets.some((target) => target.path.endsWith(".xbsl"))), false);
});

test("optional providers share one deadline and abort an overdue parser", async () => {
  let aborted = false; let parseCalls = 0;
  const ast = { parse: (_source, { signal }) => {
    parseCalls++; signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {});
  } };
  const started = Date.now();
  const result = await new ProjectSemanticService(ast, { inspect: async () => emptyLanguage() }, logger, 30)
    .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": method, "A/Form.Объект.xbsl": method }));
  assert.equal(aborted, true);
  assert.equal(parseCalls, 1);
  assert.ok(Date.now() - started < 1000);
  assert.ok(result.snippets.length > 0);
  assert.ok(result.providers.some((provider) => provider.ast === "budget-exhausted"));
});

test("native local calls include the callee body but remain unbound candidates", async () => {
  const code = "метод Применить()\n    Проверить()\n;\nметод Проверить()\n    возврат Истина\n;\n";
  const node = (kind, startLine, endLine, name, children = [], role) => ({ kind, startLine, endLine, attributes: name ? { name } : {}, children, role, startOffset: 0, endOffset: 0 });
  const root = node("Module", 1, 6, null, [
    node("Method", 1, 3, "Применить", [node("StaticMethodInvocation", 2, 2, null, [node("Name", 2, 2, "Проверить", [], "prefix")])]),
    node("Method", 4, 6, "Проверить"),
  ]);
  const ast = { parse: async () => ({ status: "ready", root, diagnostics: [] }) };
  const result = await new ProjectSemanticService(ast, { inspect: async () => emptyLanguage() }, logger)
    .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }));
  assert.equal(result.links.find((link) => link.kind === "native-call").confidence, "candidate");
  assert.ok(result.snippets.some((snippet) => snippet.startLine === 4 && snippet.text.includes("возврат Истина")));
});

test("initial semantic file IO is bounded even when the read never settles", async () => {
  const input = request({ "A/Form.yaml": form });
  input.readFile = () => new Promise(() => {});
  const start = Date.now();
  const result = await new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger, 30).buildContext(input);
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.snippets.length, 0);
  assert.ok(result.diagnostics.some((text) => text.includes("Бюджет")));
});

test("snapshot validation has one bounded IO window and never returns unverified snippets", async () => {
  const input = request({ "A/Form.yaml": form, "A/Form.xbsl": method });
  const read = input.readFile;
  const reads = new Set();
  input.readFile = (file) => {
    if (reads.has(file)) return new Promise(() => {});
    reads.add(file); return read(file);
  };
  const start = Date.now();
  const result = await new ProjectSemanticService(unavailableAst, { inspect: async () => emptyLanguage() }, logger, 30).buildContext(input);
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.snippets.length, 0);
  assert.equal(result.links.length, 0);
  assert.ok(result.diagnostics.some((text) => text.includes("Актуальность")));
});

const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;

function nativeParser(t) {
  const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");
  const ast = new NativeXbslAstService(pluginRoot, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  t.after(() => ast.dispose());
  return ast;
}

function nativeNodes(root) {
  const nodes = [];
  const stack = [root];
  while (stack.length) { const node = stack.pop(); nodes.push(node); stack.push(...node.children); }
  return nodes;
}

test("real AST: BslStructure and nested methods are retained without creating a YAML handler", { skip: !realJar }, async (t) => {
  const ast = nativeParser(t);
  const code = "структура Контейнер\n    метод Применить()\n        возврат\n    ;\n;\n";
  const parsed = await ast.parse(code);
  assert.equal(parsed.status, "ready", parsed.reason);
  assert.equal(parsed.partial, false);
  assert.equal(parsed.root.children[0].kind, "BslStructure");
  for (const kind of [5, 11]) {
    const language = { inspect: async (uri) => ({ ...emptyLanguage(), status: "ready", symbols: uri.fsPath.endsWith(".xbsl") ? [
      { name: "Применить", kind, startLine: 2, endLine: 4, selectionRange: { startLine: 2, startCharacter: 10, endLine: 2, endCharacter: 19 } },
    ] : [] }) };
    const result = await new ProjectSemanticService(ast, language, logger)
      .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }, "Применить Контейнер"));
    const handler = result.links.find((link) => link.name === "Применить");
    assert.equal(handler.confidence, "unresolved");
    assert.equal(handler.targets.length, 0);
    const nested = result.snippets.filter((snippet) => snippet.source === "native-ast" && snippet.startLine <= 2 && snippet.endLine >= 4);
    assert.equal(nested.length, 1);
    assert.ok(nested[0].text.includes("метод Применить()"));
    assert.ok(result.snippets.some((snippet) => snippet.source === "native-ast" && snippet.startLine === 1 && snippet.endLine === 5));
  }
});

test("real AST: annotation/LSP ranges merge once, preserving module scope and excluding nested local-call targets", { skip: !realJar }, async (t) => {
  const ast = nativeParser(t);
  const code = [
    "@НаКлиенте", "метод Применить()", "    Проверить()", ";",
    "метод Проверить()", "    возврат", ";",
    "структура Контейнер", "    метод Применить()", "        Проверить()", "    ;",
    "    метод Проверить()", "        возврат", "    ;", ";", "",
  ].join("\n");
  const parsed = await ast.parse(code);
  assert.equal(parsed.status, "ready", parsed.reason);
  assert.equal(parsed.partial, false);
  const moduleMethod = parsed.root.children.find((node) => node.kind === "Method" && node.attributes.name === "Применить");
  assert.equal(moduleMethod.startLine, 1);
  for (const kind of [5, 11]) {
    const methods = nativeNodes(parsed.root).filter((node) => node.kind === "Method");
    const language = { inspect: async (uri) => ({ ...emptyLanguage(), status: "ready", symbols: uri.fsPath.endsWith(".xbsl")
      ? methods.flatMap((node) => {
        const declarationLine = node.startLine === 1 ? 2 : node.startLine;
        const character = code.split("\n")[declarationLine - 1].indexOf(node.attributes.name);
        const selectionRange = { startLine: declarationLine, startCharacter: character, endLine: declarationLine, endCharacter: character + node.attributes.name.length };
        const symbol = { name: node.attributes.name, kind, startLine: declarationLine, endLine: node.endLine,
          selectionRange, containerName: node.startLine >= 8 ? "Контейнер" : "Form" };
        // Both provider representations of the annotated method must merge into its one AST declaration.
        return node === moduleMethod ? [symbol, { ...symbol, startLine: 1 }] : [symbol];
      }) : [] }) };
    const result = await new ProjectSemanticService(ast, language, logger)
      .buildContext(request({ "A/Form.yaml": form, "A/Form.xbsl": code }, "Применить Проверить"));
    const handler = result.links.find((link) => link.kind === "handler" && link.name === "Применить");
    assert.equal(handler.confidence, "structural");
    assert.deepEqual(Array.from(handler.targets, (target) => [target.startLine, target.endLine]), [[1, 4]]);
    const localCalls = result.links.filter((link) => link.kind === "native-call");
    assert.equal(localCalls.length, 1);
    assert.equal(localCalls[0].from.startLine, 3);
    assert.equal(localCalls[0].confidence, "candidate");
    assert.deepEqual(Array.from(localCalls[0].targets, (target) => [target.startLine, target.endLine]), [[5, 7]]);
    assert.equal(result.snippets.filter((snippet) => snippet.source === "native-ast" && snippet.startLine === 1 && snippet.endLine === 4).length, 1);
    assert.ok(result.snippets.some((snippet) => snippet.source === "native-ast" && snippet.startLine === 9));
  }
});

test("real AST: chained/null-safe call and generic type positions address the native name nodes", { skip: !realJar }, async (t) => {
  const ast = nativeParser(t);
  const code = [
    "структура Пользователь", "    знч Имя: Строка", ";", "",
    "метод Получить(): Массив<Пользователь>", "    возврат []", ";", "",
    "метод Тест()", "    Загрузить()?.Сохранить()", ";", "",
  ].join("\r\n");
  const parsed = await ast.parse(code);
  assert.equal(parsed.status, "ready", parsed.reason);
  assert.equal(parsed.partial, false);
  const calls = [];
  const language = { inspect: async (uri, positions) => { calls.push({ file: uri.fsPath, positions }); return emptyLanguage(); } };
  await new ProjectSemanticService(ast, language, logger)
    .buildContext(request({ "A/Form.xbsl": code }, "сохранить массив пользователь", "A/Form.xbsl"));
  const positions = calls.find((call) => call.file.endsWith(".xbsl")).positions;
  const selected = Array.from(positions, (position) => ({ ...position,
    name: code.split(/\r?\n/)[position.line].slice(position.character).match(/^[\p{L}_][\p{L}\p{N}_]*/u)?.[0],
  }));
  assert.deepEqual(selected.map((item) => item.name).sort(), ["Массив", "Пользователь", "Сохранить"].sort());
  const save = selected.find((item) => item.name === "Сохранить");
  assert.equal(save.line, 9);
  assert.equal(save.character, code.split(/\r?\n/)[9].indexOf("Сохранить"));
});

test("index v3 isolates identical files by path and overlays unsaved text without persisting it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "element-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "First.xbsl"), method);
  fs.writeFileSync(path.join(project, "Second.xbsl"), method);
  const documents = [];
  const event = () => ({ dispose() {} });
  const mock = { ...vscode, RelativePattern: class {}, workspace: {
    workspaceFolders: [{ uri: uri(project) }], textDocuments: documents,
    createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: event, onDidChange: event, onDidDelete: event }),
  } };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode: mock });
  const service = new ProjectContextService({}, path.join(root, "config"), logger);
  t.after(() => service.dispose());
  const result = await service.searchTool("user", "Применить", { maxItems: 30 });
  assert.equal(new Set(result.chunks.map((chunk) => chunk.path)).size, 2);
  assert.equal(new Set(result.chunks.map((chunk) => chunk.chunkId)).size, result.chunks.length);
  const disk = JSON.parse(fs.readFileSync(result.indexPath));
  assert.equal(disk.version, 3);
  documents.push({ uri: uri(path.join(project, "First.xbsl")), isDirty: true, getText: () => method.replace("Применить", "Несохраненный") });
  const changed = await service.listSymbolsTool("user", { query: "Несохраненный" });
  assert.equal(changed.symbols[0].name, "Несохраненный");
  assert.equal(fs.readFileSync(result.indexPath, "utf8").includes("Несохраненный"), false);
});

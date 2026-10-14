const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { loadSource, logger, root: pluginRoot } = require("./service-test-utils.cjs");

// Offline source contracts: real YAML indexing, fixture/native AST, position-gated LSP doubles.
// CODEX_NATIVE_AST_TEST_JAR enables the same cases with the shipped parser, not a live IDE.
const realJar = process.env.CODEX_NATIVE_AST_TEST_JAR;
const hash = text => createHash("sha256").update(text).digest("hex");
const lines = (...items) => items.flat().join("\n");
const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const vscode = { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) } };
const { analyzeProjectStructure } = loadSource("src/projectStructure.ts");
const { ProjectSemanticService } = loadSource("src/projectSemanticService.ts", { vscode });
const limitation = /omit|limit|skip|budget|\u043b\u0438\u043c\u0438\u0442|\u043f\u0440\u043e\u043f\u0443\u0449|\u043d\u0435 \u0432\u043a\u043b\u044e\u0447|\u0431\u044e\u0434\u0436\u0435\u0442/iu;

function node(text, kind, startLine, endLine, attributes = {}, children = [], role, startCharacter = 0, endCharacter) {
  const source = text.split("\n");
  const offset = line => source.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0);
  return { kind, startLine, endLine, startOffset: offset(startLine) + startCharacter,
    endOffset: offset(endLine) + (endCharacter ?? source[endLine - 1].length), attributes, children, role };
}

function position(text, line, token) {
  const character = text.split("\n")[line - 1].indexOf(token);
  assert.ok(character >= 0, `${token} missing on line ${line}`);
  return { line: line - 1, character };
}

function callNode(text, call) {
  const column = position(text, call.line, call.receiver ? `${call.receiver}.${call.name}` : call.name).character;
  const nameColumn = column + (call.receiver ? call.receiver.length + 1 : 0);
  const name = node(text, call.receiver ? "FeatureName" : "StaticVariableAccess", call.line, call.line,
    { name: call.name, namespace: [] }, [], call.receiver ? "name" : "prefix", nameColumn, nameColumn + call.name.length);
  const prefix = call.receiver ? node(text, "DynamicVariableAccess", call.line, call.line, {}, [
    node(text, "StaticVariableAccess", call.line, call.line, { name: call.receiver, namespace: [] }, [],
      "source", column, column + call.receiver.length), name,
  ], "prefix", column, nameColumn + call.name.length) : name;
  return node(text, call.receiver ? "DynamicMethodInvocation" : "StaticMethodInvocation", call.line, call.line,
    {}, [prefix], "statements", column);
}

function moduleSource(definitions) {
  const source = [], methods = [];
  for (const definition of definitions) {
    if (source.length) source.push("");
    const start = source.length + 1;
    source.push(`method ${definition.name}()`);
    const calls = [], refs = [];
    for (const operation of definition.operations ?? []) {
      const line = source.length + 1;
      if (operation.ref) {
        source.push(`    val DeferredDelivery = &${operation.ref}`);
        refs.push({ line, name: operation.ref });
      } else {
        source.push(`    ${operation.receiver ? `${operation.receiver}.` : ""}${operation.name}()`);
        calls.push({ ...operation, line });
      }
    }
    for (let i = 0; i < (definition.pad ?? 0); i++) source.push(`    // ${definition.name} complete body row ${i}`);
    source.push(`    return "${definition.marker ?? `${definition.name}-tail`}"`, ";");
    methods.push({ name: definition.name, start, end: source.length, calls, refs });
  }
  const text = source.join("\n");
  const tree = node(text, "Module", 1, source.length, {}, methods.map(method => node(text, "Method", method.start,
    method.end, { name: method.name }, [
      ...method.calls.map(call => callNode(text, call)),
      ...method.refs.map(ref => {
        const column = position(text, ref.line, ref.name).character;
        const reference = node(text, "MethodRef", ref.line, ref.line, {}, [
          node(text, "StaticVariableAccess", ref.line, ref.line, { name: ref.name, namespace: [] }, [],
            "first", column, column + ref.name.length),
        ], "initializer", column - 1, column + ref.name.length);
        return node(text, "DeclareVariableStatement", ref.line, ref.line, { name: "DeferredDelivery" }, [reference], "statements");
      }),
    ], "methods")));
  return { text, tree, methods };
}

function projectFixture() {
  const sources = { "project.yaml": "ElementKind: Project\nName: CoastalDispatch\n" };
  const modules = {};
  return { sources, modules, add(file, definitions) {
    const module = moduleSource(definitions);
    sources[file] = module.text;
    modules[file] = module;
    return module;
  } };
}

function parser(t, fixture, real) {
  if (!real) return { async parse(text) {
    const module = Object.values(fixture.modules).find(item => item.text === text);
    assert.ok(module, "Every parsed XBSL file must have an explicit fixture AST");
    return { status: "ready", partial: false, root: module.tree, diagnostics: [], parserVersion: "coverage-fixture" };
  } };
  const { NativeXbslAstService } = loadSource("src/nativeXbslAstService.ts");
  const native = new NativeXbslAstService(pluginRoot, logger, { parserJarPath: realJar, timeoutMs: 30000 });
  const parsed = [];
  t.after(() => {
    native.dispose();
    assert.ok(parsed.length, "Native mode must really invoke the parser");
    for (const result of parsed) {
      assert.equal(result.status, "ready", result.reason);
      assert.equal(result.partial, false, JSON.stringify(result.diagnostics));
      assert.equal(result.diagnostics.length, 0, JSON.stringify(result.diagnostics));
    }
  });
  return { async parse(text, options) {
    const result = await native.parse(text, options);
    parsed.push(result);
    return result;
  } };
}

function language(fixture, workspaceRoot, facts = [], available = false) {
  const calls = [], served = new Set();
  return { calls, served, async inspect(document, positions) {
    const file = path.relative(workspaceRoot, document.fsPath).split(path.sep).join("/");
    assert.ok(Object.hasOwn(fixture.sources, file), `Unexpected provider file ${file}`);
    calls.push({ file, positions: Array.from(positions, item => ({ ...item })) });
    return { status: available ? "ready" : "unavailable", sourceHash: hash(fixture.sources[file]), symbols: [],
      reason: available ? undefined : "Offline contract: no live IDE or LSP",
      queries: available ? Array.from(positions, point => {
        const fact = facts.find(item => item.file === file && item.position.line === point.line && item.position.character === point.character);
        if (fact) served.add(fact.name);
        return { position: point, definitions: fact?.definitions ?? [], hover: "",
          definitionState: fact ? "responded" : "empty", hoverState: "empty" };
      }) : [] };
  } };
}

function semanticHarness(t, fixture, real, facts = [], available = false) {
  const workspaceRoot = "/coverage-workspace";
  const provider = language(fixture, workspaceRoot, facts, available), reads = [];
  const service = new ProjectSemanticService(parser(t, fixture, real), provider, logger, 30000);
  return { provider, reads, async build(query, selected) {
    return service.buildContext({ workspaceRoot, query,
      files: Object.entries(fixture.sources).map(([file, text]) => ({ path: file, hash: hash(text), structure: analyzeProjectStructure(file, text) })),
      selected: selected.map(file => ({ path: file, startLine: 1, endLine: 1, symbols: [] })),
      async readFile(file) {
        reads.push(file);
        assert.ok(Object.hasOwn(fixture.sources, file), `Unexpected source read ${file}`);
        const text = fixture.sources[file];
        return { text, startLine: 1, endLine: text.split("\n").length, truncated: false, fromOpenDocument: false };
      },
    });
  } };
}

function toolsHarness(t, fixture, real) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "semantic-coverage-")));
  const workspaceRoot = path.join(home, "workspace");
  for (const [file, text] of Object.entries(fixture.sources)) {
    const destination = path.join(workspaceRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  }
  const event = () => ({ dispose() {} });
  const host = { ...vscode, RelativePattern: class {}, workspace: {
    workspaceFolders: [{ uri: uri(workspaceRoot) }], textDocuments: [], onDidChangeWorkspaceFolders: event,
    onDidOpenTextDocument: event, onDidChangeTextDocument: event, onDidCloseTextDocument: event, onDidSaveTextDocument: event,
    createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: event, onDidChange: event, onDidDelete: event }),
  } };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode: host });
  const { ProjectToolsService } = loadSource("src/projectToolsService.ts", { vscode: host });
  const semantic = new ProjectSemanticService(parser(t, fixture, real), language(fixture, workspaceRoot), logger, 30000);
  const context = new ProjectContextService({}, path.join(home, "index"), logger, semantic);
  let raw;
  const tools = new ProjectToolsService({ async searchTool(...args) { raw = await context.searchTool(...args); return raw; } }, logger, () => "coverage");
  t.after(() => { context.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { async search(query) {
    const result = await tools.search({ chatId: "semantic-coverage", query, reason: "Independent coverage regression",
      limits: { maxItems: 20, maxChars: 36000 } });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const text = result.blocks.map(block => block.text).join("\n\n");
    assert.ok(text.length <= 36000);
    return { result, semantic: raw.semantic, text };
  } };
}

function wholeMethod(result, fixture, file, name) {
  const module = fixture.modules[file], method = module.methods.find(item => item.name === name);
  const expected = module.text.split("\n").slice(method.start - 1, method.end).join("\n");
  const snippet = result.snippets.find(item => item.path === file && item.startLine <= method.start && item.endLine >= method.end);
  assert.ok(snippet, `Missing complete ${file}/${name}; ranges=${JSON.stringify(result.snippets.map(item => [item.path, item.startLine, item.endLine]))}`);
  assert.equal(snippet.truncated, false, `${name} fits the retrieval budget`);
  assert.ok(snippet.text.includes(expected), `${name} must include its entire body and terminator`);
  return expected;
}

function components(names) {
  const fixture = projectFixture();
  for (const name of names) {
    fixture.sources[`Screens/${name}.yaml`] = lines("ElementKind: Component", `Name: ${name}`, "Controls:",
      "  - Name: DispatchAction", `    Handler: Dispatch${name}`, "  - Name: InspectAction", `    Handler: Inspect${name}`);
    fixture.add(`Screens/${name}.xbsl`, [
      { name: `Dispatch${name}`, pad: 10 }, { name: `Inspect${name}`, pad: 10 },
    ]);
  }
  return fixture;
}

for (const real of [false, true]) {
  const mode = real ? "native AST" : "fixture AST";
  const options = { skip: real && !realJar, timeout: 60000 };

  test(`R03 ${mode}: three explicitly named components deliver every full YAML handler through tools`, options, async t => {
    const names = ["HarborBoard", "FreightConsole", "RelayPanel"], fixture = components(names);
    const output = await toolsHarness(t, fixture, real).search(`Compare the implementation of ${names.join(", ")}`);
    for (const name of names) {
      assert.ok(output.semantic.snippets.some(item => item.path === `Screens/${name}.yaml`), `Missing YAML evidence for ${name}`);
      for (const prefix of ["Dispatch", "Inspect"]) {
        const expected = wholeMethod(output.semantic, fixture, `Screens/${name}.xbsl`, `${prefix}${name}`);
        assert.ok(output.text.includes(expected), `Tools dropped the complete ${prefix}${name} handler`);
      }
    }
  });

  test(`R03 ${mode}: explicit components beyond the file cap have individually identifiable omissions`, options, async t => {
    const names = Array.from({ length: 14 }, (_, i) => `CargoStation${i + 1}`), fixture = components(names);
    const harness = semanticHarness(t, fixture, real);
    const result = await harness.build(`Compare implementations of ${names.join(", ")}`, names.map(name => `Screens/${name}.yaml`));
    const missing = names.filter(name => !fixture.modules[`Screens/${name}.xbsl`].methods.every(method =>
      result.snippets.some(item => item.path === `Screens/${name}.xbsl` && !item.truncated && item.startLine <= method.start && item.endLine >= method.end)));
    assert.ok(missing.length > 0, "This case must exceed the bounded related-file capacity");
    const notices = [...result.diagnostics.map(item => typeof item === "string" ? item : JSON.stringify(item)), JSON.stringify(result.selection)];
    for (const name of missing) assert.ok(notices.some(notice => notice.includes(name) && limitation.test(notice)),
      `No concrete omission/limit notice for ${name}: ${JSON.stringify(notices)}`);
    assert.ok(new Set(harness.reads).size <= 10, "MAX_FILES must bound source reads, including explicit seeds");
  });

  for (const mentionOtherMethod of [false, true]) {
    test(`R04 ${mode}: exact YAML control remains focused in final tool text (other method named: ${mentionOtherMethod})`, options, async t => {
      const fixture = projectFixture(), file = "Screens/TerminalDesk.xbsl";
      fixture.sources["Screens/TerminalDesk.yaml"] = lines("ElementKind: Component", "Name: TerminalDesk", "Controls:",
        "  - Name: SealCargoAction", "    Handler: OnSealCargo", "  - Name: VoidCargoAction", "    Handler: OnVoidCargo",
        "  - Name: PrintCargoAction", "    Handler: OnPrintCargo");
      fixture.add(file, [
        { name: "OnSealCargo", operations: [{ name: "ValidateSeal" }], pad: 7 },
        { name: "ValidateSeal", pad: 7 },
        { name: "OnVoidCargo", marker: "foreign-void-handler" },
        { name: "OnPrintCargo", marker: "foreign-print-handler" },
        { name: "InspectTerminalHealth", marker: "explicit-other-method" },
      ]);
      const output = await toolsHarness(t, fixture, real).search(`Explain TerminalDesk SealCargoAction${mentionOtherMethod ? " and InspectTerminalHealth" : ""}`);
      for (const name of ["OnSealCargo", "ValidateSeal", ...(mentionOtherMethod ? ["InspectTerminalHealth"] : [])]) {
        assert.ok(output.text.includes(wholeMethod(output.semantic, fixture, file, name)), `Final tools text lost ${name}`);
      }
      assert.ok(output.text.includes("SealCargoAction"), "Preserve the requested control's YAML evidence");
      for (const unwanted of ["OnVoidCargo", "OnPrintCargo", "foreign-void-handler", "foreign-print-handler"]) {
        assert.equal(output.text.includes(unwanted), false, `Unrelated handler leaked through YAML, semantic output, or lexical preview: ${unwanted}`);
      }
    });
  }

  test(`R04 ${mode}: a whole-component tools query keeps all handlers`, options, async t => {
    const fixture = components(["FreightDashboard"]);
    const output = await toolsHarness(t, fixture, real).search("Explain the whole FreightDashboard component and all of its handlers");
    for (const name of ["DispatchFreightDashboard", "InspectFreightDashboard"]) {
      assert.ok(output.text.includes(wholeMethod(output.semantic, fixture, "Screens/FreightDashboard.xbsl", name)));
    }
  });

  for (const control of ["button", "label"]) {
    test(`R04 ${mode}: method query preserves the nearest complete unnamed YAML ${control} map, without neighbours`, options, async t => {
      const fixture = projectFixture(), yamlFile = "Screens/MooringOverview.yaml", codeFile = "Screens/MooringOverview.xbsl";
      const requested = control === "button" ? "ReserveMooring" : "DescribeMooring";
      const expectedMap = control === "button"
        ? lines("  - Type: Button", "    Title: Reserve the selected mooring", "    Available: =CanReserveMooring()", "    Handler: ReserveMooring")
        : lines("  - Type: Label", "    Title: Selected mooring summary", "    Value: =DescribeMooring()");
      fixture.sources[yamlFile] = lines("ElementKind: Component", "Name: MooringOverview", "Controls:",
        "  - Type: Button", "    Title: Archive unrelated mooring", "    Available: =CanArchiveMooring()", "    Handler: ArchiveMooring",
        expectedMap,
        "  - Type: Button", "    Title: Transfer unrelated mooring", "    Available: =CanTransferMooring()", "    Handler: TransferMooring");
      fixture.add(codeFile, [
        { name: requested, operations: [{ name: "ReadMooringState" }], pad: 8 },
        { name: "ReadMooringState", pad: 8 },
        ...(control === "button" ? [{ name: "CanReserveMooring", pad: 8 }] : []),
        { name: "ArchiveMooring", marker: "unrelated-archive-body" }, { name: "CanArchiveMooring" },
        { name: "TransferMooring", marker: "unrelated-transfer-body" }, { name: "CanTransferMooring" },
      ]);
      const output = await toolsHarness(t, fixture, real).search(`Explain ${requested}`);
      const yamlSnippet = output.semantic.snippets.find(item => item.path === yamlFile && item.text.includes(expectedMap));
      assert.ok(yamlSnippet, `Nearest unnamed ${control} map must retain its Type, Title and expression/handler together`);
      assert.equal(yamlSnippet.truncated, false);
      assert.ok(output.text.includes(expectedMap), `The complete unnamed ${control} map must reach the final tools text`);
      for (const name of [requested, "ReadMooringState", ...(control === "button" ? ["CanReserveMooring"] : [])]) {
        assert.ok(output.text.includes(wholeMethod(output.semantic, fixture, codeFile, name)), `Missing implementation for ${name}`);
      }
      for (const unwanted of ["Archive unrelated mooring", "Transfer unrelated mooring", "ArchiveMooring", "TransferMooring",
        "unrelated-archive-body", "unrelated-transfer-body"]) {
        assert.equal(output.text.includes(unwanted), false, `An unnamed control must not widen to an adjacent button: ${unwanted}`);
      }
    });
  }

  test(`R03 ${mode}: an explicit component does not seed a foreign lexical candidate solely for a duplicate handler`, options, async t => {
    const fixture = projectFixture(), ownYaml = "Screens/BerthConsole.yaml", ownCode = "Screens/BerthConsole.xbsl";
    const foreignYaml = "Screens/TravelArchive.yaml", foreignCode = "Screens/TravelArchive.xbsl";
    fixture.sources[foreignYaml] = lines("ElementKind: Component", "Name: TravelArchive", "Controls:",
      "  - Name: ArchiveCommitAction", "    Handler: CommitBerth");
    fixture.add(foreignCode, [{ name: "CommitBerth", operations: [{ name: "RelocateArchivedBerth" }], pad: 12, marker: "foreign-component-commit" },
      { name: "RelocateArchivedBerth", pad: 12, marker: "foreign-component-dependency" }]);
    fixture.sources[ownYaml] = lines("ElementKind: Component", "Name: BerthConsole", "Controls:",
      "  - Name: ConfirmBerthAction", "    Handler: CommitBerth");
    fixture.add(ownCode, [{ name: "CommitBerth", operations: [{ name: "ValidateCurrentBerth" }], pad: 12, marker: "requested-component-commit" },
      { name: "ValidateCurrentBerth", pad: 12, marker: "requested-component-dependency" }]);
    const output = await toolsHarness(t, fixture, real).search("Explain BerthConsole CommitBerth");
    assert.ok(output.result.blocks.some(block => block.origin.path.split(";").includes(foreignCode)),
      "Exercise an actual foreign lexical candidate, not merely an unselected file in the registry");
    for (const name of ["CommitBerth", "ValidateCurrentBerth"]) {
      assert.ok(output.text.includes(wholeMethod(output.semantic, fixture, ownCode, name)));
    }
    assert.ok(output.semantic.snippets.some(item => item.path === ownYaml));
    for (const file of [foreignYaml, foreignCode]) {
      assert.equal(output.semantic.providers.some(item => item.path === file), false, `Duplicate spelling must not seed ${file}`);
      assert.equal(output.semantic.snippets.some(item => item.path === file), false, `Foreign component entered semantic snippets: ${file}`);
      assert.equal(output.semantic.links.some(link => link.from.path === file || link.targets.some(target => target.path === file)), false,
        `Foreign component entered the dependency neighbourhood: ${file}`);
    }
  });

  for (const common of [false, true]) for (const explicit of [false, true]) {
    test(`R07 ${mode}: repeated occurrences do not starve a late ${common ? "common-module" : "local"} dependency (${explicit ? "explicit" : "ordinary"} query)`, options, async t => {
      const fixture = projectFixture(), entry = "Dispatch/ManifestFlow.xbsl";
      const target = common ? "RecordManifest" : "ValidateManifest", targetFile = common ? "Shared/RouteLedger.xbsl" : entry;
      fixture.add(entry, [
        { name: "CommitManifest", operations: [...Array.from({ length: 18 }, () => ({ name: "TouchManifest" })),
          { name: target, ...(common ? { receiver: "RouteLedger" } : {}) }] },
        { name: "TouchManifest" }, ...(!common ? [{ name: target, pad: 12 }] : []),
      ]);
      if (common) {
        fixture.sources["Shared/RouteLedger.yaml"] = "ElementKind: CommonModule\nName: RouteLedger";
        fixture.add(targetFile, [{ name: target, pad: 12 }]);
      }
      const harness = semanticHarness(t, fixture, real);
      const result = await harness.build(`Explain CommitManifest and its dependencies${explicit ? `, including ${common ? "RouteLedger." : ""}${target}` : ""}`, [entry]);
      wholeMethod(result, fixture, targetFile, target);
      const call = fixture.modules[entry].methods[0].calls.at(-1), point = position(fixture.sources[entry], call.line, target);
      assert.ok(result.links.some(link => link.name === target && link.from.path === entry && link.from.startLine === call.line
        && link.from.startCharacter === point.character && link.targets.some(item => item.path === targetFile)),
      "A separately named declaration is not evidence that the late call was traversed");
      assert.ok(harness.provider.calls.reduce((sum, call) => sum + call.positions.length, 0) <= 128, "Provider work remains bounded");
    });
  }

  test(`R07 ${mode}: overflowing distinct calls reports the actual retrieval limitation`, options, async t => {
    const fixture = projectFixture(), file = "Dispatch/OverloadedRoute.xbsl";
    const targets = Array.from({ length: 48 }, (_, i) => `CheckFreightLeg${i + 1}`);
    fixture.add(file, [{ name: "AuditRoute", operations: targets.map(name => ({ name })) }, ...targets.map(name => ({ name, pad: 30 }))]);
    const harness = semanticHarness(t, fixture, real), result = await harness.build("Explain AuditRoute and its dependencies", [file]);
    wholeMethod(result, fixture, file, "AuditRoute");
    assert.ok(result.selection?.omittedRanges > 0 || result.diagnostics.some(message => limitation.test(String(message))),
      "Distinct-call overflow must not silently imply a complete dependency neighbourhood");
    assert.ok(harness.provider.calls.reduce((sum, call) => sum + call.positions.length, 0) <= 256);
    assert.ok(result.snippets.length <= 20);
  });

  test(`R07 ${mode}: a local dependency cycle terminates without duplicate bodies or positions`, options, async t => {
    const fixture = projectFixture(), file = "Dispatch/RouteCycle.xbsl";
    fixture.add(file, [{ name: "OpenRoute", operations: [{ name: "CloseRoute" }] },
      { name: "CloseRoute", operations: [{ name: "OpenRoute" }] }]);
    const harness = semanticHarness(t, fixture, real), result = await harness.build("Explain OpenRoute", [file]);
    for (const name of ["OpenRoute", "CloseRoute"]) {
      wholeMethod(result, fixture, file, name);
      assert.equal(result.snippets.reduce((count, item) => count + item.text.split(`method ${name}()`).length - 1, 0), 1);
    }
    const positions = harness.provider.calls.flatMap(call => call.positions.map(point => `${call.file}:${point.line}:${point.character}`));
    assert.equal(new Set(positions).size, positions.length);
    assert.ok(harness.reads.length <= 3);
    assert.ok(result.snippets.every(item => item.depth <= 2));
  });

  for (const available of [false, true]) {
    test(`S4 ${mode}: MethodRef ${available ? "requests its exact LSP position and brings the target" : "without LSP does not invent a resolved target"}`, options, async t => {
      const fixture = projectFixture(), entry = "Dispatch/CallbackSetup.xbsl", targetFile = "Callbacks/ArrivalSink.xbsl";
      fixture.add(entry, [{ name: "PrepareArrival", operations: [{ ref: "AcceptArrival" }] }]);
      fixture.add(targetFile, [{ name: "AcceptArrival", pad: 12, marker: "arrival-callback-complete" },
        { name: "IgnoreDeparture", marker: "unrelated-departure" }]);
      const pointer = position(fixture.sources[entry], 2, "AcceptArrival");
      const targetPosition = position(fixture.sources[targetFile], 1, "AcceptArrival");
      const facts = [{ file: entry, name: "AcceptArrival", position: pointer, definitions: [{
        uri: pathToFileURL(path.join("/coverage-workspace", targetFile)).href, startLine: 1, endLine: 1,
        startCharacter: targetPosition.character, endCharacter: targetPosition.character + "AcceptArrival".length,
      }] }];
      const harness = semanticHarness(t, fixture, real, facts, available);
      const result = await harness.build("Explain PrepareArrival", [entry]);
      wholeMethod(result, fixture, entry, "PrepareArrival");
      const refs = result.links.filter(link => link.name === "AcceptArrival");
      if (available) {
        assert.ok(harness.provider.served.has("AcceptArrival"), "Definition double only responds at the identifier after &, not at & or the declaration");
        wholeMethod(result, fixture, targetFile, "AcceptArrival");
        assert.ok(refs.some(link => link.kind === "definition" && link.confidence === "lsp" && link.from.startLine === pointer.line + 1
          && link.from.startCharacter === pointer.character && link.targets.some(target => target.path === targetFile)));
      } else {
        assert.ok(refs.every(link => link.confidence === "unresolved" && link.targets.length === 0), "No binding evidence is available for this external reference");
        assert.equal(result.snippets.some(item => item.path === targetFile), false);
        assert.equal(harness.reads.includes(targetFile), false, "Matching method spelling alone is not an external definition");
      }
      assert.equal(result.snippets.some(item => item.text.includes("unrelated-departure")), false);
    });
  }
}

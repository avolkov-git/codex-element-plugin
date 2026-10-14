const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");

const { DocsToolsService } = loadSource("src/docsToolsService.ts");
const { ManagedContextToolLoopService } = loadSource("src/managedContextToolLoopService.ts");
const { createContextToolRequest, createContextToolSuccess } = loadSource("src/contextTools.ts");
const plain = value => JSON.parse(JSON.stringify(value));
const roots = [{ root: "/docs", corpusCount: 1, fragmentCount: 20 }];
const options = { chatId: "chat", reason: "test symbol linking" };

function ref(title, id = title) {
  return {
    id, title, corpus: "language", corpusLabel: "Language", kind: "type",
    breadcrumbs: [], sourcePath: `/docs/${id}.md`, url: "", indexPath: "/docs/index.json",
    preview: "fragment preview", score: 10,
  };
}

function harness(candidates, overrides = {}) {
  const calls = { search: [], read: [], overview: [], log: [], projectSearch: [] };
  const context = {
    async searchTool(query, limits) {
      calls.search.push({ query, ...limits });
      return { query, roots, fragments: candidates[query] || [], totalAvailableFragments: 20 };
    },
    async readTool(args) {
      calls.read.push(plain(args));
      const selected = args.fragmentIds
        ? Object.values(candidates).flat().filter(item => args.fragmentIds.includes(item.id))
        : [ref("Prompt lookup", "prompt")];
      return { roots, fragments: selected.map(item => ({ ref: item, text: `Body: ${item.title}`, truncated: false })) };
    },
    async overviewTool(args) {
      calls.overview.push(plain(args));
      return { roots, corpora: ["language"], fragments: [{ ref: ref("Overview"), text: "Overview body", truncated: false }] };
    },
    ...overrides,
  };
  const service = new DocsToolsService(context, { ...logger, info: message => calls.log.push(message) });
  return { service, context, calls };
}

test("linked read searches individual symbols and reads only exact heading IDs", async () => {
  const h = harness({
    Форма: [ref("ФормаОбъекта"), ref("МояФорма"), ref("Форма", "exact-form")],
    Булево: [ref("Булево", "exact-boolean")],
  });
  const result = await h.service.read({ ...options, symbolNames: ["Форма", "Булево"] });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.search, [
    { query: "Форма", maxItems: 12, maxPreviewChars: 120, exactTitle: true, expectedPlatformVersion: undefined },
    { query: "Булево", maxItems: 12, maxPreviewChars: 120, exactTitle: true, expectedPlatformVersion: undefined },
  ]);
  assert.deepEqual(h.calls.read, [{ fragmentIds: ["exact-form", "exact-boolean"], maxItems: 2, maxCharsPerItem: 3500 }]);
  assert.doesNotMatch(result.blocks[0].text, /ФормаОбъекта|МояФорма/);
  assert.deepEqual(plain(result.metadata.matchedSymbols), ["Форма", "Булево"]);
  assert.equal(result.metadata.versionCompatibility, "unverified");
  assert.match(result.blocks[0].text, /Совместимость версии документации.*не проверены/u);
  assert.doesNotMatch(result.blocks[0].text, /as authoritative for the current answer/u);
  assert.equal(result.metadata.documentationVersions.length, 2);
  assert.match(result.blocks[0].text, /Нет подтверждённой версии для этого фрагмента документации/u);
  assert.equal(result.toolName, "docs.read");
  assert.equal(result.blocks[0].origin.requestId, result.requestId);
  assert.equal(result.blocks[0].origin.root, "/docs");
  assert.equal(result.stats.itemCount, 2);
  assert.equal(result.stats.chars, result.blocks[0].text.length);
  assert.equal(h.calls.log.length, 1);
  assert.match(h.calls.log[0], /Docs tool docs.read: status=ok; blocks=1; items=2; chars=\d+; roots=1;/);
});

const headingCases = [
  ["Форма", "ФормаОбъекта", false],
  ["Форма", "МояФорма", false],
  ["Форма", "Форма_Объекта", false],
  ["Форма", "Форма2", false],
  ["Форма", "Форма\u0301", false],
  ["Форма", "Форма.Открыть", false],
  ["Форма", "Стд::Форма", false],
  ["Стд::Форма", "Стд::ФормаОбъекта", false],
  ["Стд::Форма", "Другой::Форма", false],
  ["Стд::Форма", "Форма", false],
  ["Стд::Форма", "Стд::Форма.Открыть", false],
  ["Std.Form", "Std.Form.Open", false],
  ["Форма", "Массив<Форма>", false],
  ["Форма", "Метод Открыть(Тип: Форма)", false],
  ["Форма", "Использование Форма", false],
  ["Форма", "Тип Форма<Булево>", true],
  ["Форма", "Компонент интерфейса «Форма»", true],
  ["Форма", "Компонент интерфейса «ФормаОбъекта»", false],
  ["Форма", "Компонент интерфейса «МояФорма»", false],
  ["Форма", "Компонент интерфейса «Массив<Форма>»", false],
  ["Форма", "Компонент интерфейса «Стд::Форма»", false],
  ["Стд::Форма", "Компонент интерфейса «Форма»", false],
  ["Стд::Форма", "Компонент интерфейса «Стд::Форма»", true],
  ["Булево", "Тип «Булево»", true],
  ["Form", 'Interface component "Form"', true],
  ["Form", 'Interface component "FormObject"', false],
  ["Форма", "## `Форма<T>`", true],
  ["Форма", "ФОРМА", true],
  ["Стд::Форма", "Класс Стд::Форма<T>", true],
  ["Стд::Интерфейс::Формы", "Пространство имён Стд::Интерфейс::Формы", true],
  ["Std.Form", "Class Std.Form<T>", true],
  ["Form", "FormObject", false],
  ["Form", "Type: Form<T>", true],
  ["Form.Open", "Method Form.Open(value)", true],
  ["Йорма", "И\u0306орма", true],
];
for (const [symbol, title, matches] of headingCases) {
  test(`heading identifier: ${JSON.stringify(symbol)} vs ${JSON.stringify(title)} => ${matches}`, async () => {
    const h = harness({ [symbol]: [ref(title)] });
    const result = await h.service.read({ ...options, symbolNames: [symbol] });
    assert.equal(result.ok, matches);
    assert.equal(h.calls.read.length, matches ? 1 : 0);
    if (!matches) {
      assert.equal(result.error.code, "notFound");
      assert.equal(result.partialBlocks.length, 0);
      assert.deepEqual(plain(result.metadata.unmatchedSymbols), [symbol]);
    }
  });
}

test("at most three distinct valid identifiers request twelve exact candidates per search", async () => {
  const h = harness({
    Форма: [ref("Форма")], Булево: [ref("Булево")], Строка: [ref("Строка")], Число: [ref("Число")],
  });
  const result = await h.service.read({ ...options, symbolNames: [
    null, "", " ", "Форма Булево", "Форма<T>", "x".repeat(201), " Форма ", "форма", "Булево", "Строка", "Число",
  ], limits: { maxItems: 100 } });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.search.map(call => call.query), ["Форма", "Булево", "Строка"]);
  assert.ok(h.calls.search.every(call => call.exactTitle === true && call.maxItems === 12));
  assert.equal(h.calls.read[0].maxItems, 3);
});

test("a backend violating the exact search contract cannot inject an unbounded or fuzzy replacement", async () => {
  const beyondLimit = harness({ Форма: [...Array.from({ length: 12 }, (_, i) => ref(`Форма${i}`)), ref("Форма")] });
  const missing = await beyondLimit.service.read({ ...options, symbolNames: ["Форма"] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "notFound");
  assert.equal(beyondLimit.calls.read.length, 0);
});

test("linked exact lookup forwards only a normalized project version to the backend", async () => {
  for (const [version, expected] of [[" 9.1.9-1 ", "9.1.9-1"], ["latest", undefined], [null, undefined]]) {
    const h = harness({ Форма: [ref("Форма")] });
    await h.service.read({ ...options, symbolNames: ["Форма"], expectedPlatformVersion: version });
    assert.equal(h.calls.search[0].exactTitle, true);
    assert.equal(h.calls.search[0].expectedPlatformVersion, expected);
  }
});

test("invalid symbol input never falls back to a query read", async () => {
  for (const symbolNames of [[], ["Форма Булево"], "Форма", [null, 42]]) {
    const h = harness({});
    const result = await h.service.read({ ...options, symbolNames, query: "fallback" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalidRequest");
    assert.equal(h.calls.search.length, 0);
    assert.equal(h.calls.read.length, 0);
  }
});

test("symbol output is capped at 7000 characters including references and introduction", async () => {
  const candidates = Object.fromEntries(["Форма", "Булево", "Строка"].map(name => [name, [ref(name)]]));
  for (const maxChars of [undefined, 30_000, 2400, 1]) {
    const h = harness(candidates, {
      async readTool(args) {
        return { roots, fragments: args.fragmentIds.map(id => ({
          ref: ref(id), text: "a".repeat(args.maxCharsPerItem), truncated: true,
        })) };
      },
    });
    const result = await h.service.read({ ...options, symbolNames: Object.keys(candidates), limits: { maxChars } });
    assert.equal(result.ok, true);
    const expected = Math.min(maxChars ?? 7000, 7000);
    assert.equal(result.stats.chars, expected);
    assert.equal(result.blocks[0].text.length, expected);
    assert.equal(result.stats.truncated, true);
  }
});

test("read candidates are revalidated by both ID and exact title", async () => {
  const h = harness({ Форма: [ref("Форма", "original")] }, {
    async readTool() {
      return { roots, fragments: [
        { ref: ref("ФормаОбъекта", "original"), text: "changed title", truncated: false },
        { ref: ref("Форма", "unexpected-id"), text: "unexpected ID", truncated: false },
      ] };
    },
  });
  const result = await h.service.read({ ...options, symbolNames: ["Форма"] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "notFound");
  assert.equal(result.partialBlocks.length, 0);
});

test("partial exact matches do not confirm missing or unavailable symbols", async () => {
  const h = harness({ Форма: [ref("Форма")] });
  const search = h.context.searchTool;
  h.context.searchTool = (query, limits) => query === "Строка" ? undefined : search(query, limits);
  const result = await h.service.read({ ...options, symbolNames: ["Форма", "Булево", "Строка"] });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.metadata.matchedSymbols), ["Форма"]);
  assert.deepEqual(plain(result.metadata.unmatchedSymbols), ["Булево", "Строка"]);
  assert.deepEqual(plain(result.metadata.unavailableSymbols), ["Строка"]);
  assert.equal(result.stats.itemCount, 1);
});

test("unavailable search or read returns an error without similar replacement", async () => {
  for (const overrides of [{ searchTool: async () => undefined }, { readTool: async () => undefined }]) {
    const h = harness({ Форма: [ref("Форма")] }, overrides);
    const result = await h.service.read({ ...options, symbolNames: ["Форма"] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "unavailable");
    assert.equal(result.partialBlocks.length, 0);
    assert.match(h.calls.log[0], /Docs tool docs.read: status=error; blocks=0; items=0; chars=0;/);
  }
});

test("explicit IDs, path or title preserve the original read path without symbol augmentation", async () => {
  for (const selection of [{ fragmentIds: ["chosen"] }, { sourcePath: "/chosen.md" }, { title: "Chosen" }]) {
    const h = harness({ Форма: [ref("Форма")] });
    await h.service.read({ ...options, ...selection, symbolNames: ["Форма"], expectedPlatformVersion: "9.1.9-1" });
    assert.equal(h.calls.search.length, 0);
    assert.equal(h.calls.read.length, 1);
    for (const [key, value] of Object.entries(selection)) assert.deepEqual(h.calls.read[0][key], value);
    assert.equal(h.calls.read[0].maxItems, 4);
  }
});

function projectResult(toolName, metadata = {}) {
  const request = createContextToolRequest({
    ...options, toolName, source: "project", args: {}, mode: "managed-fallback",
  });
  return createContextToolSuccess(request, [{
    source: "project", text: toolName, matchCount: 1,
    origin: { toolName, requestId: request.id },
  }], metadata);
}

function loopHarness(h, metadata = {}) {
  return new ManagedContextToolLoopService({
    docsTools: h.service, logger,
    diagnosticsTools: { list: async () => assert.fail("diagnostics were not requested") },
    projectTools: {
      search: async args => {
        h.calls.projectSearch.push(args);
        return projectResult("project.search", { documentationQueries: ["Форма", "Булево", "Строка", "Число"], ...metadata });
      },
      listSymbols: async () => projectResult("project.listSymbols"),
    },
  });
}
const loopRequest = {
  chatId: "chat", prompt: "fix form", chatKind: "project", hasExplicitDocs: false, shouldUseDiagnostics: false,
  routing: { route: "project", reason: "project task", docsMode: "matched", shouldUseDocsContext: true, shouldUseProjectContext: true },
};

test("managed loop keeps routes, origins and worklog counts for linked reads", async () => {
  const h = harness({ Форма: [ref("ФормаОбъекта"), ref("Форма")], Булево: [ref("Булево")], Строка: [ref("Строка")] });
  const result = await loopHarness(h).buildContext(loopRequest);
  assert.equal(result.docsRoute, "added");
  assert.equal(result.projectRoute, "added");
  assert.equal(result.diagnosticsRoute, "skip");
  assert.equal(h.calls.projectSearch[0].limits.maxChars, 36_000);
  assert.equal(h.calls.read[0].query, "fix form");
  assert.deepEqual(h.calls.search.map(call => call.query), ["Форма", "Булево", "Строка"]);
  const linked = result.blocks.filter(block => block.metadata?.titleMatch === "exact-identifier");
  assert.equal(linked.length, 3);
  assert.ok(linked.every(block => block.metadata.contextTool.toolName === "docs.read"));
  assert.deepEqual(plain(linked.map(block => block.metadata.contextTool.title)), ["Форма", "Булево", "Строка"]);
  assert.equal(new Set(linked.map(block => block.metadata.fragmentId)).size, 3);
  const reads = result.worklog.filter(entry => entry.toolName === "docs.read");
  assert.equal(reads.length, 2);
  assert.equal(reads[1].chars, linked.reduce((sum, block) => sum + block.text.length, 0));
  assert.equal(reads[1].itemCount, 3);
  assert.equal(reads[1].blockCount, 3);
  assert.ok(reads[1].chars <= 7000);
});

test("explicit docs and disabled docs routing prevent all automatic documentation reads", async () => {
  for (const request of [
    { ...loopRequest, hasExplicitDocs: true },
    { ...loopRequest, routing: { ...loopRequest.routing, shouldUseDocsContext: false } },
  ]) {
    const h = harness({ Форма: [ref("Форма")] });
    const result = await loopHarness(h, { platformVersion: "9.1.9-1" }).buildContext(request);
    assert.equal(result.docsRoute, "skip");
    assert.equal(result.projectRoute, "added");
    assert.equal(h.calls.read.length + h.calls.search.length + h.calls.overview.length, 0);
    assert.equal(result.worklog.some(entry => entry.source === "docs"), false);
  }
});

test("managed loop forwards the same parsed project platform version to both documentation reads", async () => {
  for (const [platformVersion, expected] of [
    ["9.1.9-1", "9.1.9-1"], [" 9.2.4-6 ", "9.2.4-6"], [undefined, undefined],
    [null, undefined], [42, undefined], [["9.1.9-1", "9.2.4-6"], undefined],
    ["Element extension 9.2.4-6", undefined],
  ]) {
    const h = harness({ Форма: [ref("Форма")] });
    const read = h.service.read.bind(h.service);
    const requests = [];
    h.service.read = args => { requests.push(args); return read(args); };
    const result = await loopHarness(h, { platformVersion, extensionVersion: "1.0.4", parserVersion: "9.9.9-9" }).buildContext(loopRequest);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].expectedPlatformVersion, expected);
    assert.equal(requests[1].expectedPlatformVersion, expected);
    const linked = result.blocks.find(block => block.metadata?.titleMatch === "exact-identifier");
    assert.equal(linked.metadata.expectedPlatformVersion, expected);
    assert.equal(linked.metadata.versionCompatibility, "unverified");
  }
});

test("overview routing is retained when exact linked docs are added", async () => {
  const h = harness({ Форма: [ref("Форма")] });
  const result = await loopHarness(h).buildContext({ ...loopRequest, routing: { ...loopRequest.routing, docsMode: "overview" } });
  assert.equal(result.docsRoute, "overview");
  assert.equal(h.calls.overview.length, 1);
  assert.equal(result.worklog.filter(entry => entry.toolName === "docs.read").length, 1);
});

test("a missing exact symbol records an error but does not discard the existing docs route", async () => {
  const h = harness({ Форма: [ref("ФормаОбъекта")] });
  const result = await loopHarness(h).buildContext(loopRequest);
  assert.equal(result.docsRoute, "added");
  assert.equal(result.blocks.filter(block => block.source === "docs").length, 1);
  const reads = result.worklog.filter(entry => entry.toolName === "docs.read");
  assert.equal(reads[1].status, "error");
  assert.equal(reads[1].itemCount, 0);
  assert.equal(reads[1].chars, 0);
});

const corpus = process.env.CODEX_DOCS_SYMBOL_TEST_CORPUS;
test("real corpus: exact symbols, qualified namespace and missing symbol", { skip: !corpus }, async t => {
  assert.ok(fs.existsSync(path.join(corpus, "chunks.jsonl")), "corpus must contain chunks.jsonl");
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doc-symbols-"));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const { DocsSearchEngine } = loadSource("src/docsSearchEngine.ts");
  const engine = new DocsSearchEngine({
    getDocsSettingsView: () => ({ normalizedPath: corpus, sourcePath: "" }),
    getConfigRoot: () => configRoot,
  }, logger, { cwd: configRoot, serverDocs: "" });
  const metrics = [];
  const context = {
    async searchTool(query, limits) {
      const found = await engine.searchTool(query, limits);
      metrics.push({ query, available: found?.totalAvailableFragments, candidates: found?.fragments.map(item => item.title) });
      return found;
    },
    readTool: args => engine.readTool(args),
  };
  const service = new DocsToolsService(context, logger);
  for (const symbolNames of [["Форма", "Булево", "ЧитаемыйМассив"], ["Стд::Интерфейс::Формы"], ["Несуществующий::Форма"]]) {
    const result = await service.read({ ...options, symbolNames });
    t.diagnostic(JSON.stringify({ symbolNames, ok: result.ok, stats: result.stats, metadata: result.metadata }));
    if (symbolNames[0] === "Несуществующий::Форма") {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "notFound");
      assert.equal(result.partialBlocks.length, 0);
    } else {
      assert.equal(result.ok, true);
      assert.deepEqual(plain(result.metadata.matchedSymbols).sort(), [...symbolNames].sort());
      assert.ok(result.stats.chars <= 7000);
      assert.equal(result.metadata.versionCompatibility, "unverified");
      assert.ok(result.metadata.documentationVersions.every(check => check.sourceVersion === "9.2"));
      assert.ok(result.metadata.documentationVersions.every(check => check.productVersion === "9.2.4-6"));
      assert.doesNotMatch(result.blocks[0].origin.title, /ФормаОбъекта|АвтоматическаяФормаСписка/u);
      if (symbolNames.includes("Форма")) assert.match(result.blocks[0].origin.title, /(?:^|;)Компонент интерфейса «Форма»(?:;|$)/u);
      const mismatch = await service.read({ ...options, symbolNames, expectedPlatformVersion: "9.1.9-1" });
      assert.equal(mismatch.ok, true);
      assert.equal(mismatch.metadata.versionCompatibility, "mismatch");
      assert.ok(mismatch.metadata.documentationVersions.every(check => check.status === "mismatch"));
      assert.match(mismatch.blocks[0].text, /Версия источника документации: 9\.2; версия комплекта: 9\.2\.4-6/u);
      assert.match(mismatch.blocks[0].text, /Совместимость версии: версии не совпадают/u);
      t.diagnostic(JSON.stringify({ symbolNames, expectedPlatformVersion: mismatch.metadata.expectedPlatformVersion,
        versionCompatibility: mismatch.metadata.versionCompatibility,
        sourceVersions: [...new Set(mismatch.metadata.documentationVersions.map(check => check.sourceVersion))] }));
      const sameLine = await service.read({ ...options, symbolNames, expectedPlatformVersion: "9.2.4-6" });
      assert.equal(sameLine.ok, true);
      assert.equal(sameLine.metadata.versionCompatibility, "unverified");
      assert.ok(sameLine.metadata.documentationVersions.every(check => check.reason === "same-release-line-only"));
    }
  }
  t.diagnostic(JSON.stringify(metrics));
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");

const { DocsSearchEngine } = loadSource("src/docsSearchEngine.ts");
const { DocsToolsService } = loadSource("src/docsToolsService.ts");
const { ManagedContextToolLoopService } = loadSource("src/managedContextToolLoopService.ts");
const { ContextRouterService } = loadSource("src/contextRouterService.ts");
const { createContextToolRequest, createContextToolSuccess, createContextToolFailure } = loadSource("src/contextTools.ts");
const plain = value => JSON.parse(JSON.stringify(value));
const version = "10.4.7-3";
const oldVersion = "10.3.8-2";
const options = { chatId: "docs-policy", reason: "regression test" };

function record(id, title, sourceVersion, fields = {}) {
  return {
    id, title, corpus: "lang", kind: "standard-library", provenance: "official-html",
    source_version: sourceVersion, product_version: version,
    source_path: `stdlib/${id}.html`, text: `${title}: body ${id}`, ...fields,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-docs-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Keep eight-ancestor auto-discovery outside any ancestor named docs.
  const cwd = path.join(root, "env", "a", "b", "c", "d", "e", "f", "g", "h");
  fs.mkdirSync(cwd, { recursive: true });
  function corpus(name, records) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      corpus: "lang", title: name, files: { chunks: "chunks.jsonl" }, record_shapes: { chunks: { content_field: "text" } },
    }));
    fs.writeFileSync(path.join(dir, "chunks.jsonl"), records.map(value => JSON.stringify(value)).join("\n"));
    return dir;
  }
  function services(roots) {
    const engine = new DocsSearchEngine({
      getDocsSettingsView: () => ({ normalizedPath: roots[0], sourcePath: roots[1] || "" }),
      getConfigRoot: () => cwd,
    }, logger, { cwd, serverDocs: "" });
    return { engine, tools: new DocsToolsService(engine, logger) };
  }
  return { root, corpus, services };
}

function projectResult(toolName, metadata, fail = false) {
  const request = createContextToolRequest({ ...options, toolName, source: "project", args: {}, mode: "managed-fallback" });
  return fail ? createContextToolFailure(request, { code: "unavailable", message: "project unavailable", retryable: true }, [], metadata)
    : createContextToolSuccess(request, [{ source: "project", text: "Shipping declarations", matchCount: 1,
      origin: { requestId: request.id, toolName } }], metadata);
}

async function managed(tools, { query, symbols, platformVersion = version, docsMode = "lookup", failedProject = false }) {
  const loop = new ManagedContextToolLoopService({ docsTools: tools, logger,
    projectTools: {
      search: async () => projectResult("project.search", { documentationQueries: symbols, platformVersion }, failedProject),
      listSymbols: async () => projectResult("project.listSymbols", {}),
    }, diagnosticsTools: { list: async () => assert.fail("unexpected diagnostics") },
  });
  return loop.buildContext({ ...options, prompt: query, chatKind: "project", hasExplicitDocs: false, shouldUseDiagnostics: false,
    routing: { route: "technicalProject", docsMode, shouldUseDocsContext: true, shouldUseProjectContext: true, reason: "docs regression" },
  });
}

test("overlapping roots deduplicate physical IDs before read limits, retaining distinct version IDs", async t => {
  const f = fixture(t);
  const a = f.corpus("corpora/a", [record("gateway", "ШлюзУведомлений", version)]);
  const b = f.corpus("corpora/b", [record("receipt", "КвитанцияДоставки", version)]);
  const { engine, tools } = f.services([a, path.dirname(a)]);
  const ids = [(await engine.searchTool("ШлюзУведомлений")).fragments[0].id,
    (await engine.searchTool("КвитанцияДоставки")).fragments[0].id];
  const read = await engine.readTool({ fragmentIds: ids, maxItems: 2 });
  assert.deepEqual(plain(read.fragments.map(item => item.ref.id)), ids);
  const linked = await tools.read({ ...options, symbolNames: ["ШлюзУведомлений", "КвитанцияДоставки"], expectedPlatformVersion: version });
  assert.equal(linked.ok, true);
  assert.deepEqual(plain(linked.metadata.matchedSymbols), ["ШлюзУведомлений", "КвитанцияДоставки"]);
  assert.deepEqual(plain(linked.metadata.unmatchedSymbols), []);
  assert.equal(linked.stats.itemCount, 2);
  const distinct = f.corpus("versions/a", [record("same-source", "СеансОтправки", oldVersion), record("same-source", "СеансОтправки", version)]);
  const multi = f.services([distinct, path.dirname(distinct)]).engine;
  const found = await multi.searchTool("СеансОтправки");
  assert.equal(found.fragments.length, 2);
  const versions = await multi.readTool({ fragmentIds: found.fragments.map(item => item.id), maxItems: 2 });
  assert.equal(new Set(versions.fragments.map(item => item.ref.id)).size, 2);
  assert.deepEqual(plain(versions.fragments.map(item => item.ref.documentationVersion.sourceVersion)), [oldVersion, version]);
  assert.ok(fs.existsSync(b));
});

test("generic read selectors and overview share version policy without inferring API compatibility", async t => {
  const f = fixture(t);
  const root = f.corpus("records", [record("buffer", "ТранзакционныйБуфер", oldVersion)]);
  const { engine, tools } = f.services([root]);
  const ref = (await engine.searchTool("ТранзакционныйБуфер")).fragments[0];
  for (const selection of [{ query: "ТранзакционныйБуфер" }, { title: ref.title }, { sourcePath: ref.sourcePath }, { fragmentIds: [ref.id] }]) {
    for (const expectedPlatformVersion of [version, oldVersion, undefined]) {
      const result = await tools.read({ ...options, ...selection, expectedPlatformVersion });
      assert.equal(result.ok, true);
      assert.equal(result.metadata.versionCompatibility, expectedPlatformVersion === version ? "mismatch" : expectedPlatformVersion ? "matched" : "unverified");
      assert.doesNotMatch(result.blocks[0].text, /as authoritative/);
      assert.match(result.blocks[0].text, /Без точного совпадения версий/);
      assert.match(result.blocks[0].text, /body buffer/);
      assert.equal(result.metadata.documentationVersions[0].recordId, "buffer");
    }
  }
  for (const expectedPlatformVersion of [version, undefined]) {
    const result = await tools.overview({ ...options, expectedPlatformVersion });
    assert.equal(result.metadata.versionCompatibility, expectedPlatformVersion ? "mismatch" : "unverified");
    assert.match(result.blocks[0].text, /limited overview slice/);
    assert.match(result.blocks[0].text, /Совместимость версии:/);
    assert.doesNotMatch(result.blocks[0].text, /as authoritative/);
  }
});

test("managed identity merge keeps unrelated refs and the longer shared body with version warnings", async t => {
  const f = fixture(t);
  const shared = "ТранзакционныйБуфер";
  const extra = "ДополнениеВыгрузки";
  const root = f.corpus("records", [
    record("buffer", shared, oldVersion, { text: `${shared}: ${"a".repeat(2800)} KEEP_LONG_BODY ${"b".repeat(500)}` }),
    record("extra", extra, undefined, { text: `${extra}: KEEP_UNRELATED_REF` }),
    record("packet", "ПакетСинхронизации", version),
    record("receipt", "КвитанцияДоставки", undefined),
  ]);
  const { tools } = f.services([root]);
  const result = await managed(tools, { query: `${shared} ${extra}`, symbols: [shared, "ПакетСинхронизации", "КвитанцияДоставки"] });
  const docs = result.blocks.filter(block => block.source === "docs");
  assert.equal(docs.length, 4);
  assert.equal(new Set(docs.map(block => block.metadata.fragmentId)).size, 4);
  const buffer = docs.find(block => block.metadata.contextTool.title === shared);
  assert.equal(buffer.metadata.titleMatch, "exact-identifier");
  assert.equal(buffer.metadata.versionCompatibility, "mismatch");
  assert.match(buffer.text, /KEEP_LONG_BODY/);
  assert.equal(buffer.metadata.truncated, false);
  assert.ok(docs.some(block => block.text.includes("KEEP_UNRELATED_REF")));
  assert.deepEqual(plain(docs.map(block => block.metadata.versionCompatibility).sort()), ["matched", "mismatch", "unverified", "unverified"]);
  assert.ok(docs.every(block => block.metadata.expectedPlatformVersion === version));
  const envelope = new ContextRouterService().buildServiceEnvelope({ blocks: result.blocks, userPrompt: "Проверь API" });
  assert.doesNotMatch(envelope, /as authoritative/);
  assert.equal((envelope.match(/KEEP_LONG_BODY/g) || []).length, 1);
  assert.ok(result.worklog.filter(entry => entry.source === "docs").every(entry => entry.chars <= 20_000));
});

test("overview identity merge keeps supplemental refs and prefers the full linked read", async t => {
  const f = fixture(t);
  const title = "ДиспетчерОтправки";
  const root = f.corpus("records", [
    record("dispatcher", title, version, { summary: "LONG_OVERVIEW ".repeat(30), text: `${title}: FULL_LINKED_BODY` }),
    record("protocol", "ПротоколЭкспорта", undefined, { summary: "KEEP_OVERVIEW_CONTEXT" }),
  ]);
  const result = await managed(f.services([root]).tools, { query: "Изучи документацию", symbols: [title], docsMode: "overview" });
  const docs = result.blocks.filter(block => block.source === "docs");
  assert.equal(result.docsRoute, "overview");
  assert.equal(docs.length, 2);
  assert.equal(new Set(docs.map(block => block.metadata.fragmentId)).size, 2);
  assert.ok(docs.some(block => block.text.includes("FULL_LINKED_BODY")));
  assert.ok(docs.some(block => block.text.includes("KEEP_OVERVIEW_CONTEXT")));
  assert.doesNotMatch(docs.map(block => block.text).join("\n"), /as authoritative/);
});

test("unknown and failed project evidence never upgrades ordinary or linked docs", async t => {
  const f = fixture(t);
  const title = "СеансВыгрузки";
  const root = f.corpus("records", [record("session", title, version)]);
  for (const settings of [{ platformVersion: "not a version" }, { failedProject: true }]) {
    const result = await managed(f.services([root]).tools, { query: title, symbols: [title], ...settings });
    const docs = result.blocks.filter(block => block.source === "docs");
    assert.equal(docs.length, 1);
    assert.equal(docs[0].metadata.versionCompatibility, "unverified");
    assert.match(docs[0].text, /Версия штатного парсера проекта неизвестна/);
    assert.doesNotMatch(docs[0].text, /as authoritative/);
  }
});

test("same-title different-release docs retain separate identity in the managed output", async t => {
  const f = fixture(t);
  const title = "ОкноЭкспорта";
  const root = f.corpus("records", [record("window", title, oldVersion), record("window", title, version)]);
  const result = await managed(f.services([root]).tools, { query: title, symbols: [title] });
  const docs = result.blocks.filter(block => block.source === "docs");
  assert.equal(docs.length, 2);
  assert.equal(new Set(docs.map(block => block.metadata.fragmentId)).size, 2);
  assert.deepEqual(plain(docs.map(block => block.metadata.versionCompatibility).sort()), ["matched", "mismatch"]);
});

test("fragment block budgets share unused space without clipping a body that fits", async t => {
  const f = fixture(t);
  const title = "СправочникДоставки";
  const root = f.corpus("records", Array.from({ length: 8 }, (_, index) => record(`guide-${index}`, `${title}${index}`, version, {
    text: index ? `${title}: short body ${index}` : `${title}: ${"x".repeat(2800)} KEEP_LONG_SECTION`,
  })));
  const { tools } = f.services([root]);
  const result = await tools.read({ ...options, query: title, expectedPlatformVersion: version, fragmentBlocks: true,
    limits: { maxItems: 8, maxChars: 20_000 } });
  assert.equal(result.ok, true);
  assert.equal(result.blocks.length, 8);
  assert.equal(result.stats.truncated, false);
  assert.ok(result.stats.chars <= 20_000);
  assert.match(result.blocks.map(block => block.text).join("\n"), /KEEP_LONG_SECTION/);
  for (const maxChars of [1, 1000, 4000]) {
    const limited = await tools.read({ ...options, query: title, fragmentBlocks: true, limits: { maxItems: 8, maxChars } });
    assert.ok(limited.stats.chars <= maxChars);
    assert.equal(limited.stats.truncated, true);
    assert.ok(limited.blocks.every(block => block.metadata.fragmentBodyChars >= 0));
  }
});

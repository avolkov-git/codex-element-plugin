const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const { loadSource, logger, root: repo } = require("./service-test-utils.cjs");

const protocol = loadSource("src/docsWorkerProtocol.ts");
// Preserve the shared error-class identity that CommonJS provides in production.
const { DocsSearchEngine } = loadSource("src/docsSearchEngine.ts", { "./docsWorkerProtocol": protocol });
const { DocsToolsService } = loadSource("src/docsToolsService.ts");
const { DocsContextService } = loadSource("src/docsContextService.ts");
const { DOCS_WORKER_LIMITS } = protocol;
const plain = value => JSON.parse(JSON.stringify(value));
const version = "10.4.7-3";
const symbol = "Std::ParcelRoute";
const readOptions = { chatId: "exact-docs", reason: "exact symbol lookup", symbolNames: [symbol], expectedPlatformVersion: version };
const exactOptions = { exactTitle: true, expectedPlatformVersion: version, maxItems: 12, maxPreviewChars: 120 };
const originalCwd = process.cwd();
const originalServerDocs = process.env.CODEX_ELEMENT_SERVER_DOCS;
let workerEnvironment;
test.before(() => {
  workerEnvironment = fs.mkdtempSync(path.join(os.tmpdir(), "docs-exact-environment-"));
  process.chdir(workerEnvironment);
  delete process.env.CODEX_ELEMENT_SERVER_DOCS;
});
test.after(() => {
  process.chdir(originalCwd);
  if (originalServerDocs === undefined) delete process.env.CODEX_ELEMENT_SERVER_DOCS;
  else process.env.CODEX_ELEMENT_SERVER_DOCS = originalServerDocs;
  fs.rmSync(workerEnvironment, { recursive: true, force: true });
});

function record(id, title = symbol, sourceVersion = version, overrides = {}) {
  return {
    id, title, corpus: "lang", kind: "standard-library", provenance: "official-html",
    source_version: sourceVersion, product_version: version,
    source_path: `help/${id}.html`, source_relpath: `help/${id}.html`,
    text: `# ${title}\nAPI body ${id}.`, ...overrides,
  };
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-exact-lookup-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const environment = path.join(temp, "env", ...Array.from({ length: 9 }, (_, i) => String(i)));
  fs.mkdirSync(environment, { recursive: true });
  const writeRecords = (root, records) => {
    fs.writeFileSync(path.join(root, "chunks.jsonl"), records.map(item => JSON.stringify(item)).join("\n") + "\n");
    // Force a new fingerprint even on filesystems with coarse timestamp resolution.
    const stamp = new Date(Date.now() + ++fixture.revision * 1000);
    fs.utimesSync(path.join(root, "chunks.jsonl"), stamp, stamp);
  };
  const corpus = (name, records) => {
    const root = path.join(temp, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
      corpus: "lang", title: name, files: { chunks: "chunks.jsonl" },
      record_shapes: { chunks: { content_field: "text" } },
    }));
    writeRecords(root, records);
    return root;
  };
  const settings = roots => ({
    getDocsSettingsView: () => ({ normalizedPath: roots[0] || "", sourcePath: roots[1] || "" }),
    getConfigRoot: () => environment,
  });
  const engine = roots => new DocsSearchEngine(settings(roots), logger, { cwd: environment, serverDocs: roots[2] || "" });
  return { temp, corpus, writeRecords, settings, engine };
}
fixture.revision = 0;

function noise(count) {
  return Array.from({ length: count }, (_, i) => record(`noise-${i}`, `${symbol}Plan${i}`, "10.3.8-2", {
    keywords: [symbol], summary: `Example ${symbol}`, breadcrumbs: [symbol],
  }));
}

test("exact linked docs survive 80 higher-scoring fuzzy titles in either root order without widening fuzzy search", async t => {
  const f = fixture(t);
  const noisy = f.corpus("noisy", noise(80));
  const correct = f.corpus("correct", [record("exact")]);
  for (const roots of [[noisy, correct], [correct, noisy]]) {
    const engine = f.engine(roots);
    const fuzzy = await engine.searchTool(symbol, { maxItems: 12 });
    assert.equal(fuzzy.fragments.length, 12);
    assert.ok(fuzzy.fragments.every(ref => ref.title !== symbol));
    const exact = await engine.searchTool(symbol, exactOptions);
    assert.equal(exact.totalAvailableFragments, 81);
    assert.equal(exact.fragments.length, 1);
    assert.equal(exact.fragments[0].documentationVersion.recordId, "exact");
    const read = await engine.readTool({ fragmentIds: [exact.fragments[0].id] });
    assert.deepEqual(plain(read.fragments[0].ref.documentationVersion), plain(exact.fragments[0].documentationVersion));
    const linked = await new DocsToolsService(engine, logger).read(readOptions);
    assert.equal(linked.ok, true);
    assert.equal(linked.metadata.versionCompatibility, "matched");
    assert.equal(linked.metadata.documentationVersions[0].fragmentId, exact.fragments[0].id);
    assert.equal(linked.metadata.documentationVersions[0].metadataPath, path.join(correct, "chunks.jsonl"));
    assert.match(linked.blocks[0].text, /API body exact/);
    assert.doesNotMatch(linked.blocks[0].text, /API body noise/);
  }
});

test("version rank precedes the exact result cap across more than twelve exact titles and overlapping roots", async t => {
  const f = fixture(t);
  const old = Array.from({ length: 30 }, (_, i) => record(`old-${i}`, symbol, "10.3.8-2", {
    keywords: [symbol], summary: symbol, breadcrumbs: [symbol],
  }));
  const common = f.corpus("overlap/common", old);
  const current = f.corpus("overlap/current", [record("partial", symbol, "10.4"), record("exact")]);
  for (const roots of [[common, path.dirname(common)], [path.dirname(common), common]]) {
    const engine = f.engine(roots);
    for (const [maxItems, count] of [[1, 1], [12, 12], [24, 24], [1_000_000, 24]]) {
      const found = await engine.searchTool(symbol, { ...exactOptions, maxItems });
      assert.equal(found.fragments.length, count);
      assert.equal(new Set(found.fragments.map(ref => ref.id)).size, count);
      assert.equal(found.fragments[0].documentationVersion.recordId, "exact");
      if (count > 1) assert.equal(found.fragments[1].documentationVersion.recordId, "partial");
      assert.equal(found.fragments[0].documentationVersion.metadataPath, path.join(current, "chunks.jsonl"));
    }
    const linked = await new DocsToolsService(engine, logger).read(readOptions);
    assert.equal(linked.ok, true);
    assert.equal(linked.metadata.versionCompatibility, "matched");
    assert.equal(linked.metadata.documentationVersions[0].recordId, "exact");
  }
});

test("overlapping roots deduplicate IDs before the cap without merging distinct evidence roots", async t => {
  const f = fixture(t);
  const records = [record("shared-id", symbol, version, { text: "Identical body" })];
  const common = f.corpus("overlap/common", records);
  const sibling = f.corpus("overlap/sibling", records);
  const engine = f.engine([common, path.dirname(common)]);
  const found = await engine.searchTool(symbol, { ...exactOptions, maxItems: 2 });
  assert.equal(found.totalAvailableFragments, 3);
  assert.equal(found.fragments.length, 2);
  assert.notEqual(found.fragments[0].id, found.fragments[1].id);
  assert.deepEqual(plain(found.fragments.map(ref => ref.documentationVersion.metadataPath)).sort(),
    [common, sibling].map(root => path.join(root, "chunks.jsonl")).sort());
  const read = await engine.readTool({ fragmentIds: found.fragments.map(ref => ref.id), maxItems: 2 });
  assert.deepEqual(plain(read.fragments.map(fragment => fragment.ref.id)), plain(found.fragments.map(ref => ref.id)));
});

test("matching release line survives exact cap; mismatch and unknown evidence remain visibly unverified", async t => {
  const f = fixture(t);
  const records = Array.from({ length: 25 }, (_, i) => record(`old-${i}`, symbol, "10.3.8-2"));
  const root = f.corpus("versions", [...records, record("untrusted", symbol, version, { provenance: "derived-analysis" }),
    record("release-line", symbol, "10.4")]);
  const engine = f.engine([root]);
  const tools = new DocsToolsService(engine, logger);
  const line = await tools.read(readOptions);
  assert.equal(line.ok, true);
  assert.equal(line.metadata.versionCompatibility, "unverified");
  assert.equal(line.metadata.documentationVersions[0].recordId, "release-line");
  assert.equal(line.metadata.documentationVersions[0].reason, "same-release-line-only");
  f.writeRecords(root, records);
  const mismatch = await tools.read(readOptions);
  assert.equal(mismatch.ok, true);
  assert.equal(mismatch.metadata.versionCompatibility, "mismatch");
  assert.equal(mismatch.metadata.documentationVersions[0].reason, "different-documentation-release");
  f.writeRecords(root, [record("untrusted", symbol, version, { provenance: "derived-analysis" })]);
  const unknown = await tools.read(readOptions);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.metadata.versionCompatibility, "unverified");
  assert.equal(unknown.metadata.documentationVersions[0].reason, "authoritative-source-version-unavailable");
});

test("exact lookup accepts short and stop-word identifiers without fuzzy tokenization thresholds", async t => {
  const f = fixture(t);
  const root = f.corpus("short", [record("short", "X"), record("stop-word", "Type The")]);
  const engine = f.engine([root]);
  for (const name of ["X", "The"]) {
    assert.equal((await engine.searchTool(name)).fragments.length, 0);
    const exact = await engine.searchTool(name, exactOptions);
    assert.equal(exact.fragments.length, 1);
    assert.equal((await new DocsToolsService(engine, logger).read({ ...readOptions, symbolNames: [name] })).ok, true);
  }
});

const headingCases = [
  ["Form", "FormObject", false], ["Form", "Form_2", false], ["Form", "Form\u0301", false],
  ["Form", "Std::Form", false], ["Std::Form", "Form", false], ["Std::Form", "Other::Form", false],
  ["Form", "Form.Open", false], ["Form", "Array<Form>", false],
  ["Form", "Method Open(value: Form)", false], ["Form", "Using Form", false],
  ["Std.Form", "Std.Form.Open", false], ["Std.Form", "Std::Form", false],
  ["Std::Form", "Class Std::Form<T>", true], ["Form.Open", "Method Form.Open(value)", true],
  ["Form", 'Interface component "Form"', true], ["Form", "## `Form<T>`", true],
  ["Form", "FORM", true], ["Y\u0301", "Type \u00dd<T>", true],
  ["\u0424\u043e\u0440\u043c\u0430", "\u0422\u0438\u043f \u00ab\u0424\u043e\u0440\u043c\u0430\u00bb", true],
];
test("corpus exact lookup retains identifier boundaries and NFC without namespace or alias guesses", async t => {
  const f = fixture(t);
  for (const [i, [name, title, matches]] of headingCases.entries()) {
    const root = f.corpus(`headings-${i}`, [record(`heading-${i}`, title)]);
    const engine = f.engine([root]);
    const exact = await engine.searchTool(name, exactOptions);
    assert.equal(exact.fragments.length, matches ? 1 : 0, `${name} vs ${title}`);
    const result = await new DocsToolsService(engine, logger).read({ ...readOptions, symbolNames: [name] });
    assert.equal(result.ok, matches, `${name} vs ${title}`);
    if (!matches) assert.equal(result.error.code, "notFound");
  }
});

test("unknown names and invalid identifiers never fall back to prose, generic arguments or fuzzy titles", async t => {
  const f = fixture(t);
  const root = f.corpus("unknown", [...noise(40), record("argument", "Array<Unknown>"),
    record("prose", "Using Unknown", version, { keywords: ["Unknown"] })]);
  const engine = f.engine([root]);
  for (const name of ["Unknown", "ParcelRoute", "Other::ParcelRoute", symbol]) {
    const exact = await engine.searchTool(name, exactOptions);
    assert.equal(exact.fragments.length, 0);
    const result = await new DocsToolsService(engine, logger).read({ ...readOptions, symbolNames: [name] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "notFound");
    assert.equal(result.partialBlocks.length, 0);
  }
  for (const name of ["", "two names", "Form<T>", "Form:", "Form.", "x".repeat(201)]) {
    assert.equal((await engine.searchTool(name, exactOptions)).fragments.length, 0);
  }
});

test("exact lookup refreshes changed corpus IDs and never reads a stale or renamed symbol", async t => {
  const f = fixture(t);
  const root = f.corpus("changing", [record("before")]);
  const engine = f.engine([root]);
  const before = await engine.searchTool(symbol, exactOptions);
  assert.equal(engine.getMetrics().loads, 1);
  assert.equal((await engine.searchTool(symbol, exactOptions)).fragments[0].id, before.fragments[0].id);
  assert.equal(engine.getMetrics().loads, 1);
  f.writeRecords(root, [record("after", symbol, "10.3.8-2")]);
  const after = await engine.searchTool(symbol, exactOptions);
  assert.notEqual(after.fragments[0].id, before.fragments[0].id);
  assert.equal((await engine.readTool({ fragmentIds: [before.fragments[0].id] })).fragments.length, 0);
  assert.equal(engine.getMetrics().loads, 2);
  engine.invalidate(root);
  assert.equal((await engine.searchTool(symbol, exactOptions)).fragments[0].id, after.fragments[0].id);
  assert.equal(engine.getMetrics().loads, 3);
  const tools = new DocsToolsService({
    searchTool: (...args) => engine.searchTool(...args),
    readTool: args => {
      f.writeRecords(root, [record("renamed", `${symbol}Plan`)]);
      return engine.readTool(args);
    },
  }, logger);
  const changed = await tools.read(readOptions);
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "notFound");
  assert.equal(changed.metadata.versionCompatibility, "unverified");
  assert.equal((await engine.searchTool(symbol, exactOptions)).fragments.length, 0);
});

function workerService(t, settings) {
  const service = new DocsContextService(settings, logger, {
    worker: {
      workerFactory: () => new Worker(`
        const { workerData } = require("node:worker_threads");
        const { loadSource } = require(workerData.helpers);
        const protocol = loadSource("src/docsWorkerProtocol.ts");
        loadSource("src/docsRetrievalWorker.ts", { "./docsWorkerProtocol": protocol });
      `, { eval: true, execArgv: [], workerData: { helpers: path.join(repo, "tests/service-test-utils.cjs") } }),
    },
  });
  t.after(async () => {
    service.dispose();
    const deadline = Date.now() + 5000;
    while (service.getMetrics().workerRunning) {
      assert.ok(Date.now() < deadline, "source worker must terminate");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });
  return service;
}

test("source worker transports exact options and bounded provenance with backend parity, refresh and invalidation", async t => {
  const f = fixture(t);
  const root = f.corpus("worker", [...noise(100), ...Array.from({ length: 30 }, (_, i) => record(`old-${i}`, symbol, "10.3.8-2")), record("exact")]);
  const service = workerService(t, f.settings([root]));
  const options = { ...exactOptions, maxItems: 1 };
  const pending = service.searchTool(symbol, options);
  options.exactTitle = false;
  options.expectedPlatformVersion = "10.3.8-2";
  const actual = await pending;
  assert.deepEqual(plain(actual), plain(await f.engine([root]).searchTool(symbol, { ...exactOptions, maxItems: 1 })));
  assert.equal(actual.fragments[0].documentationVersion.recordId, "exact");
  assert.ok(service.getMetrics().lastResponseBytes <= DOCS_WORKER_LIMITS.maxResponseBytes);
  const linked = await new DocsToolsService(service, logger).read(readOptions);
  assert.equal(linked.ok, true);
  assert.equal(linked.metadata.versionCompatibility, "matched");
  assert.equal(service.getMetrics().loads, 1);
  f.writeRecords(root, [record("new-revision", symbol, "10.3.8-2")]);
  assert.equal((await service.searchTool(symbol, exactOptions)).fragments[0].documentationVersion.recordId, "new-revision");
  assert.equal((await service.readTool({ fragmentIds: [actual.fragments[0].id] })).fragments.length, 0);
  const stale = service.searchTool(symbol, exactOptions);
  service.invalidate();
  assert.equal(await stale, undefined);
  assert.equal((await service.searchTool(symbol, exactOptions)).fragments[0].documentationVersion.recordId, "new-revision");
  assert.equal(service.getMetrics().workerStarts, 2);
  assert.equal(service.getMetrics().invalidations, 1);
  assert.equal((await service.searchTool("Unknown", exactOptions)).fragments.length, 0);
});

test("exact lookup retains worker request and corpus budgets instead of increasing the candidate limit", async t => {
  const f = fixture(t);
  const root = f.corpus("over-budget", Array.from({ length: DOCS_WORKER_LIMITS.maxFragments + 1 }, (_, i) => record(`overflow-${i}`)));
  await assert.rejects(f.engine([root]).searchTool(symbol, exactOptions), /budget/);
  const service = workerService(t, f.settings([root]));
  assert.equal(await service.searchTool("x".repeat(DOCS_WORKER_LIMITS.maxRequestChars + 1), exactOptions), undefined);
  assert.equal(service.getMetrics().workerStarts, 0);
  assert.equal(await service.searchTool(symbol, exactOptions), undefined);
  assert.equal(service.getMetrics().failed, 1);
});

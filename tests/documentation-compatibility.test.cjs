const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const test = require("node:test");
const { loadSource, logger, root: repo } = require("./service-test-utils.cjs");

const {
  compareDocumentationVersion, normalizePlatformVersion,
  documentationVersionRank, summarizeDocumentationVersions, formatDocumentationVersion,
} = loadSource("src/documentationCompatibility.ts");
const { DocsSearchEngine } = loadSource("src/docsSearchEngine.ts");
const { DocsToolsService } = loadSource("src/docsToolsService.ts");
const { docsFragmentChars, loadDocsCorpora } = loadSource("src/docsCorpusService.ts");
const plain = value => JSON.parse(JSON.stringify(value));
const options = { chatId: "test", reason: "version test", symbolNames: ["Std::Form"], expectedPlatformVersion: "9.1.9-1" };
const evidence = {
  metadataPath: "/docs/chunks.jsonl", recordId: "record",
  sourceVersion: "9.2", productVersion: "9.2.4-6", provenance: "official-html",
};

test("versions must be isolated numeric labels, never inferred from prose or extensions", () => {
  for (const value of [null, undefined, 9.2, {}, [], "", "v9.2", "9.2.4-6 plugin", "parser=9.2.4-6", "9.2/9.1", "9.02", "9.2.x", "9.2.4-beta", "9".repeat(50)]) {
    assert.equal(normalizePlatformVersion(value), undefined, JSON.stringify(value));
  }
  for (const value of ["9.2", "9.2.4", "9.2.4-6", "10.0.0-1"]) assert.equal(normalizePlatformVersion(` ${value} `), value);
});

for (const [expected, fields, status, reason] of [
  ["9.1.9-1", {}, "mismatch", "different-documentation-release"],
  ["9.20.4-6", {}, "mismatch", "different-documentation-release"],
  ["9.2.4-6", {}, "unverified", "same-release-line-only"],
  ["9.2.99-1", {}, "unverified", "same-release-line-only"],
  ["9.2", { sourceVersion: "9.2.4-6" }, "unverified", "same-release-line-only"],
  ["9.2.4-6", { sourceVersion: "9.2.4-6" }, "matched", "equal-source-version-tags"],
  ["9.2.4-7", { sourceVersion: "9.2.4-6" }, "mismatch", "different-documentation-release"],
  ["9.2.5-6", { sourceVersion: "9.2.4-6" }, "mismatch", "different-documentation-release"],
  [undefined, {}, "unverified", "expected-platform-version-unknown"],
  ["ambiguous 9.1 / 9.2", {}, "unverified", "expected-platform-version-unknown"],
  ["9.2.4-6", { sourceVersion: undefined }, "unverified", "authoritative-source-version-unavailable"],
  ["9.2.4-6", { sourceVersion: "latest" }, "unverified", "authoritative-source-version-unavailable"],
  ["9.2.4-6", { sourceVersion: "9.2.4-6", provenance: "derived-analysis" }, "unverified", "authoritative-source-version-unavailable"],
  ["9.2.4-6", { sourceVersion: "9.2.4-6", provenance: undefined }, "unverified", "authoritative-source-version-unavailable"],
  ["9.1.9-1", { productVersion: "9.1.9-1" }, "mismatch", "different-documentation-release"],
  ["9.1.9-1", { sourceVersion: "9.1.9-1", productVersion: "9.2.4-6" }, "matched", "equal-source-version-tags"],
]) {
  test(`version evidence: ${expected}, ${JSON.stringify(fields)} => ${reason}`, () => {
    const check = compareDocumentationVersion("fragment", expected, { ...evidence, ...fields });
    assert.equal(check.status, status);
    assert.equal(check.reason, reason);
    assert.equal(check.fragmentId, "fragment");
  });
}

test("aggregation and ranking never upgrade unknown or mismatched fragments", () => {
  const checks = ["matched", "unverified", "mismatch"].map(status => ({ status }));
  assert.equal(summarizeDocumentationVersions([]), "unverified");
  assert.equal(summarizeDocumentationVersions(checks.slice(0, 1)), "matched");
  assert.equal(summarizeDocumentationVersions(checks.slice(0, 2)), "unverified");
  assert.equal(summarizeDocumentationVersions(checks), "mismatch");
  assert.ok(documentationVersionRank(checks[0]) > documentationVersionRank({ status: "unverified", reason: "same-release-line-only" }));
  assert.ok(documentationVersionRank({ status: "unverified", reason: "same-release-line-only" }) > documentationVersionRank(checks[1]));
  assert.equal(documentationVersionRank(checks[1]), documentationVersionRank(checks[2]));
});

test("human-readable version explanations are Russian; machine keys stay in metadata", () => {
  for (const [expected, source] of [["9.1.9-1", evidence], ["9.2.4-6", evidence], ["9.2", evidence], [undefined, evidence], ["9.2", undefined]]) {
    const check = compareDocumentationVersion("fragment", expected, source);
    const text = formatDocumentationVersion(check);
    assert.match(text, /Совместимость версии:/u);
    assert.match(text, /Ожидаемая версия штатного парсера:/u);
    assert.doesNotMatch(text, /Version |No authoritative|bundle snapshot|expected parser|source_version=|product_version=/u);
    assert.equal(text.includes(check.reason), false);
    assert.equal(text.includes(check.status), false);
  }
});

function record(id, sourceVersion = "9.2", overrides = {}) {
  return {
    id, corpus: "lang", title: "Std::Form", kind: "standard-library", provenance: "official-html",
    source_version: sourceVersion, product_version: sourceVersion === "9.2" ? "9.2.4-6" : sourceVersion,
    source_path: "docs/help/ru/stdlib/Form/index.html", text: `# Std::Form\n\nAPI body ${id}.`, ...overrides,
  };
}

async function fixture(t, records, format = "generic") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "documentation-versions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "chunks.jsonl");
  fs.writeFileSync(file, records.map(item => JSON.stringify(item)).join("\r\n"));
  if (format === "manifest") fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    corpus: "language", files: { chunks: "chunks.jsonl" }, record_shapes: { chunks: { content_field: "text" } },
  }));
  const engine = new DocsSearchEngine({
    getDocsSettingsView: () => ({ normalizedPath: root, sourcePath: "" }), getConfigRoot: () => root,
  }, logger, { cwd: root, serverDocs: "" });
  const search = await engine.searchTool("Std::Form", { maxItems: 12, maxPreviewChars: 120 });
  assert.ok(search?.fragments.length);
  return { root, file, engine, search, service: new DocsToolsService(engine, logger) };
}

for (const format of ["generic", "manifest"]) {
  test(`${format} loader retains per-record evidence through search/read/overview and accounts for its size`, async t => {
    const f = await fixture(t, [record("record-1")], format);
    const ref = f.search.fragments[0];
    const expected = { ...evidence, metadataPath: f.file, recordId: "record-1", sourcePath: "docs/help/ru/stdlib/Form/index.html" };
    assert.deepEqual(plain(ref.documentationVersion), expected);
    const read = await f.engine.readTool({ fragmentIds: [ref.id] });
    assert.deepEqual(plain(read.fragments[0].ref.documentationVersion), expected);
    assert.deepEqual(plain((await f.engine.overviewTool()).fragments[0].ref.documentationVersion), expected);
    const fragment = (await loadDocsCorpora(f.root)).fragments[0];
    assert.equal(docsFragmentChars(fragment) - docsFragmentChars({ ...fragment, documentationVersion: undefined }),
      Object.values(expected).reduce((sum, value) => sum + value.length, 0));
    ref.documentationVersion.sourceVersion = "mutated";
    assert.equal((await f.engine.searchTool("Std::Form")).fragments[0].documentationVersion.sourceVersion, "9.2");
    assert.equal(f.engine.getMetrics().loads, 1);
  });
}

test("same-file and same-URL versions have distinct IDs and survive deduplication", async t => {
  const f = await fixture(t, [
    record("release-92", "9.2", { text: "# Std::Form same body", url: "https://docs.invalid/Form" }),
    record("release-91", "9.1.9-1", { text: "# Std::Form same body", url: "https://docs.invalid/Form" }),
    record("other-namespace", "9.1.9-1", { title: "Other::Form", text: "# Other::Form" }),
    record("unqualified", "9.1.9-1", { title: "Form", text: "# Form" }),
  ]);
  const versions = f.search.fragments.filter(ref => ref.title === "Std::Form");
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].id, versions[1].id);
  const result = await f.service.read(options);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.versionCompatibility, "matched");
  assert.equal(result.metadata.documentationVersions[0].recordId, "release-91");
  assert.equal(result.metadata.documentationVersions[0].sourceVersion, "9.1.9-1");
  assert.doesNotMatch(result.blocks[0].text, /Other::Form|API body unqualified/);
  assert.equal(result.metadata.versionSelectionScope, "retrieved-exact-candidates");
});

test("a matching release line is preferred without claiming exact bundle compatibility", async t => {
  const f = await fixture(t, [record("mismatch", "9.1"), record("matching-line", "9.2")]);
  const result = await f.service.read({ ...options, expectedPlatformVersion: "9.2.4-6" });
  assert.equal(result.ok, true);
  assert.equal(result.metadata.versionCompatibility, "unverified");
  assert.equal(result.metadata.documentationVersions[0].reason, "same-release-line-only");
  assert.equal(result.metadata.documentationVersions[0].recordId, "matching-line");
});

test("mismatched and unknown project versions keep docs with model-visible evidence", async t => {
  const f = await fixture(t, [record("mismatch")]);
  const result = await f.service.read(options);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.versionCompatibility, "mismatch");
  assert.match(result.blocks[0].text, /Совместимость версии: версии не совпадают/u);
  assert.match(result.blocks[0].text, /Ожидаемая версия штатного парсера: 9\.1\.9-1/u);
  assert.match(result.blocks[0].text, /Версия источника документации: 9\.2; версия комплекта: 9\.2\.4-6/u);
  assert.match(result.blocks[0].text, /chunks\.jsonl; запись: mismatch/u);
  assert.match(result.blocks[0].text, /API body mismatch/);
  const unknown = await f.service.read({ ...options, expectedPlatformVersion: undefined });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.metadata.versionCompatibility, "unverified");
  assert.equal(unknown.metadata.documentationVersions[0].reason, "expected-platform-version-unknown");
});

test("unobserved schemas/provenance and arbitrary titles stay unknown without changing legacy refs", async t => {
  for (const overrides of [
    { corpus: undefined }, { kind: "type" }, { provenance: undefined },
    { provenance: "derived-analysis" }, { corpus: "external-product" }, { id: undefined },
  ]) {
    const f = await fixture(t, [record("unknown", "9.1.9-1", { title: "Std::Form (9.1.9-1)", ...overrides })]);
    assert.equal(Object.hasOwn(f.search.fragments[0], "documentationVersion"), false);
    const result = await f.service.read(options);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.versionCompatibility, "unverified");
    assert.match(result.blocks[0].text, /Нет подтверждённой версии для этого фрагмента документации/u);
    assert.match(result.blocks[0].text, /API body unknown/);
  }
});

test("missing, malformed and oversized source tags never fall back to the bundle or extension", async t => {
  for (const source_version of [undefined, "latest", 9.2, "x".repeat(41)]) {
    const f = await fixture(t, [record("unknown", "9.1.9-1", { source_version, extensionVersion: "9.1.9-1", is_current: true })]);
    const result = await f.service.read(options);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.versionCompatibility, "unverified");
    assert.equal(result.metadata.documentationVersions[0].reason, "authoritative-source-version-unavailable");
  }
});

test("read results, not earlier search metadata, determine the final warning", async t => {
  const f = await fixture(t, [record("before", "9.1.9-1")]);
  const service = new DocsToolsService({
    searchTool: (...args) => f.engine.searchTool(...args),
    async readTool(args) {
      const read = await f.engine.readTool(args);
      read.fragments[0].ref.documentationVersion = { ...evidence, recordId: "changed" };
      return read;
    },
  }, logger);
  const result = await service.read(options);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.versionCompatibility, "mismatch");
  assert.equal(result.metadata.documentationVersions[0].recordId, "changed");
});

test("worker transports evidence, reuses its cache, and invalidates metadata-only changes", async t => {
  const f = await fixture(t, [record("cached")]);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "documentation-worker-"));
  const workerPath = path.join(runtime, "docsRetrievalWorker.js");
  require("esbuild").buildSync({
    entryPoints: [path.join(repo, "src/docsRetrievalWorker.ts")], outfile: workerPath,
    bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "silent",
  });
  const { DocsWorkerClient } = loadSource("src/docsWorkerClient.ts");
  const client = new DocsWorkerClient({ workerFactory: (_, options) => new Worker(workerPath, options) });
  t.after(async () => {
    client.dispose();
    const deadline = Date.now() + 3000;
    while (client.getMetrics().workerRunning && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(client.getMetrics().workerRunning, false);
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const settings = { normalizedPath: f.root, sourcePath: "", configRoot: f.root, cwd: f.root, serverDocs: "" };
  const call = (method, ...args) => client.request(settings, method, args);
  const service = new DocsToolsService({ searchTool: (...args) => call("searchTool", ...args), readTool: (...args) => call("readTool", ...args) }, logger);
  const first = await service.read(options);
  assert.equal(first.metadata.versionCompatibility, "mismatch");
  assert.equal(first.metadata.documentationVersions[0].sourceVersion, "9.2");
  const previousId = first.metadata.documentationVersions[0].fragmentId;
  await service.read(options);
  assert.equal(client.getMetrics().loads, 1, "warm linked reads must not reload the corpus");
  assert.equal(client.getMetrics().workerStarts, 1);

  const before = fs.statSync(f.file);
  fs.writeFileSync(f.file, JSON.stringify(record("cached", "9.1", { product_version: "9.1.4-6" })));
  fs.utimesSync(f.file, before.atime, before.mtime);
  const updated = await service.read(options);
  assert.equal(updated.metadata.documentationVersions[0].sourceVersion, "9.1");
  assert.equal(updated.metadata.documentationVersions[0].reason, "same-release-line-only");
  assert.notEqual(updated.metadata.documentationVersions[0].fragmentId, previousId);
  assert.equal(client.getMetrics().loads, 2);
  assert.equal((await call("readTool", { fragmentIds: [previousId] })).fragments.length, 0);
});

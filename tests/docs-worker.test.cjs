const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Worker } = require("node:worker_threads");
const { test, before, after } = require("node:test");
const esbuild = require("esbuild");

const repo = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-docs-worker-"));
const helpers = path.join(temp, "helpers");
const originalCwd = process.cwd();
const originalServerDocs = process.env.CODEX_ELEMENT_SERVER_DOCS;
const logger = { info() {}, warn() {}, error() {} };
let DocsContextService, DocsWorkerClient, limits, corpusHelpers;

before(() => {
  esbuild.buildSync({
    entryPoints: ["docsContextService", "docsRetrievalWorker", "docsWorkerClient", "docsWorkerProtocol", "docsCorpusService"]
      .map(name => path.join(repo, "src", `${name}.ts`)),
    outdir: helpers, bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "silent"
  });
  ({ DocsContextService } = require(path.join(helpers, "docsContextService.js")));
  ({ DocsWorkerClient } = require(path.join(helpers, "docsWorkerClient.js")));
  ({ DOCS_WORKER_LIMITS: limits } = require(path.join(helpers, "docsWorkerProtocol.js")));
  corpusHelpers = require(path.join(helpers, "docsCorpusService.js"));
  process.chdir(temp);
  delete process.env.CODEX_ELEMENT_SERVER_DOCS;
});

after(() => {
  process.chdir(originalCwd);
  if (originalServerDocs === undefined) delete process.env.CODEX_ELEMENT_SERVER_DOCS;
  else process.env.CODEX_ELEMENT_SERVER_DOCS = originalServerDocs;
  fs.rmSync(temp, { recursive: true, force: true });
});

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function makeCorpus(name, records, format = "generic", corpus = "language") {
  const root = path.join(temp, name);
  const file = path.join(root, format === "legacy" ? "index/pages.jsonl" : "records.jsonl");
  write(file, records.map(record => JSON.stringify(record)).join("\r\n"));
  if (format === "manifest") {
    write(path.join(root, "manifest.json"), JSON.stringify({
      corpus, title: `${corpus} docs`, files: { chunks: "records.jsonl" },
      record_shapes: { chunks: { content_field: "text" } }
    }));
  }
  return { root, file };
}

function settingsFor(root, sourcePath = "") {
  const paths = { normalizedPath: root, sourcePath };
  return {
    paths,
    getDocsSettingsView: () => ({ ...paths, validationMessage: "" }),
    getConfigRoot: () => path.join(temp, "config"),
    getDocsContextDetails: () => ({ kind: "docs", status: "configured", label: "Docs", source: "normalized", ...paths, allowedRoots: [] })
  };
}

function serviceFor(t, root, options = {}, sourcePath = "") {
  const settings = settingsFor(root, sourcePath);
  const service = new DocsContextService(settings, logger, options);
  t.after(async () => {
    service.dispose();
    await until(() => !service.getMetrics().workerRunning);
  });
  return { service, settings };
}

async function until(check, timeout = 3000) {
  const started = Date.now();
  while (!check()) {
    assert(Date.now() - started < timeout, "condition did not settle before its deadline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function withoutFingerprint(value) {
  if (typeof value === "string") return value.replace(/fingerprint=[a-f0-9]{16}/g, "fingerprint=<value>");
  if (Array.isArray(value)) return value.map(withoutFingerprint);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint")
      .map(([key, item]) => [key, withoutFingerprint(item)]));
  }
  return value;
}

function oracle(settings, actions) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "fixtures/docs-reference-worker.cjs"), {
      workerData: { modulePath: path.join(repo, "dist/docsContextService.js"), paths: settings.paths, metadata: settings.getDocsContextDetails(), configRoot: settings.getConfigRoot(), actions },
      execArgv: []
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Reference worker timed out.")); }, 90_000);
    let result;
    worker.on("message", value => { result = value; });
    worker.on("error", reject);
    worker.on("exit", code => {
      clearTimeout(timer);
      if (code || !result) reject(new Error(`Reference worker exited (${code}).`));
      else if (result.error) reject(new Error(result.error));
      else resolve(result.results);
    });
  });
}

const smallRecords = [
  { title: "File exists", text: "Check file directory exists before reading. ".repeat(120), summary: "File existence", source_relpath: "file.md", url: "https://docs.invalid/file", keywords: ["file", "exists"], breadcrumbs: ["Library", "Filesystem"] },
  { title: "Record fields", text: "A struct record has property fields.", source_relpath: "record.md", keywords: ["struct", "field"] },
  { title: "Theme form", text: "A form component has a theme property.", source_relpath: "form.md" },
  { title: "Server extension", text: "The server bundle plugin runtime supports an extension.", source_relpath: "server.md" },
  { title: "Console HTTP", text: "The console project endpoint uses HTTP.", source_relpath: "console.md" },
  { title: "Duplicate", text: "duplicate token token", source_relpath: "same.md", url: "https://docs.invalid/a" },
  { title: "Duplicate", text: "duplicate token", source_relpath: "same.md", url: "https://docs.invalid/b" },
  { title: "Duplicate", text: "duplicate token", source_relpath: "different.md", url: "https://docs.invalid/b" },
  { title: "Tie Alpha", text: "needle", summary: "needle", source_relpath: "a.md" },
  { title: "Tie Beta", text: "needle", summary: "needle", source_relpath: "b.md" }
];

test("source worker preserves compiled context/search/read/overview/planner and explicit-path fixtures", async t => {
  const normalized = makeCorpus("parity-normalized", smallRecords, "manifest");
  const source = makeCorpus("parity-source", smallRecords.slice(0, 5), "manifest", "bundle");
  const { service, settings } = serviceFor(t, normalized.root, {}, source.root);
  assert.equal(service.getMetrics().workerStarts, 0);
  await service.buildMetadataContext();
  assert.equal(service.getMetrics().workerStarts, 0, "metadata must not warm a retrieval worker");
  const overviewPrompt = "\u0438\u0437\u0443\u0447\u0438 \u0432\u0441\u044e \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430\u0446\u0438\u044e";
  const actions = [
    ["searchTool", ["file exists", { maxItems: 24, maxPreviewChars: 120 }]],
    ["searchTool", ["duplicate token"]],
    ["searchTool", ["\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430 \u0441\u0432\u043e\u0439\u0441\u0442\u0432\u043e"]],
    ["searchTool", ["needle", { maxItems: Infinity, maxPreviewChars: -1 }]],
    ["buildContext", ["file exists"]], ["buildContext", ["hello thanks"]],
    ["buildContext", [overviewPrompt]], ["buildPlannerInput", []],
    ["readTool", [{ sourcePath: "FILE.MD", maxItems: 12, maxCharsPerItem: 450 }]],
    ["readTool", [{ title: "record", maxCharsPerItem: 4000 }]],
    ["readTool", [{ sourcePath: "missing", title: "missing", query: "file exists" }]],
    ["readTool", [{ fragmentIds: ["not-an-id"], query: "file exists" }]],
    ["overviewTool", [{ maxItems: 16, maxCharsPerItem: 300 }]],
    ["buildContextFromPlan", ["file exists", { queries: ["file", "server", "file"], preferredCorpora: ["bundle"], targetTitles: ["Server extension"], needOverview: false }]],
    ["buildContextFromPlan", ["hello", { queries: [], preferredCorpora: ["bundle"], targetTitles: [], needOverview: true }]],
    ["buildExplicitPathContext", [`file exists "${normalized.file}"`, temp]],
    ["buildExplicitPathContext", [`hello "${source.root}"`, temp]],
    ["buildExplicitPathContext", [`${overviewPrompt} "./parity-source"`, temp]],
    ["buildMetadataContext", []]
  ];
  const expected = await oracle(settings, actions);
  for (const [index, [method, args]] of actions.entries()) {
    const actual = await service[method](...args);
    assert.deepEqual(withoutFingerprint(actual), withoutFingerprint(expected[index]), `${method} action ${index}`);
  }
  const hit = await service.searchTool("file exists");
  const idAction = ["readTool", [{ fragmentIds: [hit.fragments[0].id], maxCharsPerItem: 900 }]];
  assert.deepEqual(withoutFingerprint(await service.readTool(...idAction[1])), withoutFingerprint((await oracle(settings, [idAction]))[0]));
  assert.equal(service.getMetrics().workerStarts, 1);
  assert(service.getMetrics().cacheHits > 0);
});

test("legacy, text-tree, malformed JSONL and allowed roots keep their behavior", async t => {
  const legacy = makeCorpus("legacy", smallRecords, "legacy");
  const textRoot = path.join(temp, "text-tree");
  write(path.join(textRoot, "guide.md"), "File exists and directory methods.");
  write(path.join(textRoot, "page.html"), "<script>private script</script><h1>File guide</h1><p>Read file</p>");
  write(path.join(textRoot, ".env"), "DO_NOT_INCLUDE=secret");
  write(path.join(textRoot, "node_modules/private.md"), "DO_NOT_INCLUDE");
  for (const root of [legacy.root, textRoot]) {
    const { service, settings } = serviceFor(t, root);
    const actions = [["searchTool", ["file"]], ["overviewTool", []], ["buildPlannerInput", []]];
    const expected = await oracle(settings, actions);
    for (const [index, [method, args]] of actions.entries()) {
      assert.deepEqual(withoutFingerprint(await service[method](...args)), withoutFingerprint(expected[index]));
    }
    assert.equal(await service.buildExplicitPathContext(`read "${path.join(textRoot, ".env")}"`, temp), undefined);
  }
  const malformed = makeCorpus("malformed", [{ text: "needle", title: "Valid" }]);
  fs.appendFileSync(malformed.file, "\n{not-json}\nnull\n\n");
  const { service } = serviceFor(t, malformed.root);
  assert.equal((await service.searchTool("needle")).totalAvailableFragments, 1);

  const safe = makeCorpus("safe-manifest", [{ text: "public needle", title: "Public" }], "manifest");
  const outside = path.join(temp, "outside.jsonl");
  write(outside, JSON.stringify({ text: "DO_NOT_INCLUDE private needle", title: "Private" }));
  fs.symlinkSync(outside, path.join(safe.root, "escaped.jsonl"));
  write(path.join(safe.root, "manifest.json"), JSON.stringify({ corpus: "language", files: { chunks: "records.jsonl", operations: "escaped.jsonl", schemas: "../outside.jsonl" } }));
  const { service: safeService } = serviceFor(t, safe.root);
  const result = await safeService.searchTool("needle");
  assert.equal(result.totalAvailableFragments, 1);
  assert(!JSON.stringify(result).includes("DO_NOT_INCLUDE"));
});

test("fingerprints notice equal-size replacement with restored mtime, missing files and explicit invalidation", async t => {
  const fixture = makeCorpus("fingerprint", [{ title: "Alpha", text: "needle Alpha", summary: "needle" }]);
  const { service } = serviceFor(t, fixture.root);
  const first = await service.searchTool("needle");
  const old = fs.statSync(fixture.file);
  const replacement = `${fixture.file}.replacement`;
  write(replacement, fs.readFileSync(fixture.file, "utf8").replaceAll("Alpha", "Bravo"));
  fs.utimesSync(replacement, old.atime, old.mtime);
  fs.renameSync(replacement, fixture.file);
  const second = await service.searchTool("needle");
  assert.equal(second.fragments[0].title, "Bravo");
  assert.notEqual(first.roots[0].fingerprint, second.roots[0].fingerprint);
  assert.equal(service.getMetrics().loads, 2);
  service.invalidate(fixture.root);
  assert.equal((await service.searchTool("needle")).fragments[0].title, "Bravo");
  assert.equal(service.getMetrics().workerStarts, 2);
  fs.unlinkSync(fixture.file);
  assert.equal(await service.searchTool("needle"), undefined);
});

test("explicit roots use a bounded LRU instead of retaining every corpus", async t => {
  const { service } = serviceFor(t, "");
  for (let index = 0; index < 7; index += 1) {
    const fixture = makeCorpus(`lru-${index}`, [{ text: "needle", title: `Item ${index}` }]);
    assert(await service.buildExplicitPathContext(`needle "${fixture.root}"`, temp));
    assert(service.getMetrics().cacheRoots <= limits.maxCacheRoots);
  }
  assert.equal(service.getMetrics().cacheRoots, 4);
  assert.equal(service.getMetrics().evictions, 3);
});

test("26000-fragment cold/warm search agrees with production helpers while host timers progress", { timeout: 120_000 }, async t => {
  const records = Array.from({ length: 26_000 }, (_, index) => ({
    title: `Entry ${String(index).padStart(5, "0")}`,
    source_relpath: `entry/${index}.md`,
    text: `${index % 211 === 0 ? "needle exactlongterm directory " : "ordinary content "}${"reference body content ".repeat(50)}`,
    summary: index % 211 === 0 ? "needle reference" : "ordinary reference",
    keywords: index % 997 === 0 ? ["needle", "exactlongterm"] : [],
    breadcrumbs: ["Manual", `Section ${index % 20}`]
  }));
  const fixture = makeCorpus("stress", records, "manifest");
  const { service, settings } = serviceFor(t, fixture.root);
  const actions = [["searchTool", ["needle exactlongterm", { maxItems: 24 }]], ["searchTool", ["directory exists", { maxItems: 8 }]]];
  const expected = await oracle(settings, actions);
  let ticks = 0;
  let maxGapMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previous);
    previous = now;
    ticks += 1;
  }, 5);
  const restored = [];
  for (const name of ["readFileSync", "readdirSync", "statSync", "existsSync", "realpathSync"]) {
    const original = fs[name];
    fs[name] = function(file, ...args) {
      assert(!String(file).startsWith(fixture.root), `host ${name} must not touch the corpus`);
      return original.call(this, file, ...args);
    };
    restored.push(() => { fs[name] = original; });
  }
  const started = performance.now();
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [index, [method, args]] of actions.entries()) {
        const actual = await service[method](...args);
        assert.equal(actual.totalAvailableFragments, 26_000);
        assert.deepEqual(withoutFingerprint(actual), withoutFingerprint(expected[index]));
        assert(service.getMetrics().lastResponseBytes < 50_000, "only bounded results should cross the worker port");
      }
    }
  } finally {
    clearInterval(timer);
    for (const restore of restored) restore();
  }
  assert(ticks >= 10, `host timer only ran ${ticks} times`);
  assert(maxGapMs < 250, `host timer was blocked for ${maxGapMs.toFixed(1)}ms`);
  assert.equal(service.getMetrics().loads, 1);
  assert.equal(service.getMetrics().cachedFragments, 26_000);
  assert.equal(service.getMetrics().activeJobs, 0);
  t.diagnostic(JSON.stringify({ node: process.version, fragments: 26_000, ticks, maxGapMs, elapsedMs: performance.now() - started, metrics: service.getMetrics() }));
});

function workerSettings() {
  return { normalizedPath: "", sourcePath: "", configRoot: path.join(temp, "config"), cwd: temp, serverDocs: "" };
}

class FakeWorker extends EventEmitter {
  requests = [];
  ref() {}
  unref() {}
  postMessage(request) { this.requests.push(request); }
  terminate() { return Promise.resolve(0); }
  reply(index = 0, result = "done") {
    this.emit("message", { id: this.requests[index].id, result, elapsedMs: 1, responseBytes: 100,
      metrics: { cacheHits: 0, cacheMisses: 0, evictions: 0, loads: 0, lastLoadMs: 0, cacheRoots: 0, cachedFragments: 0, cachedChars: 0 } });
  }
}

test("queue/input bounds, disposal and generation fences settle every promise", async () => {
  const workers = [];
  const client = new DocsWorkerClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const requests = Array.from({ length: 9 }, () => client.request(workerSettings(), "searchTool", ["needle"]));
  const settled = Promise.allSettled(requests);
  assert.equal(client.getMetrics().activeJobs, 1);
  assert.equal(client.getMetrics().queuedJobs, 8);
  await assert.rejects(client.request(workerSettings(), "searchTool", ["overflow"]), /queue is full/);
  client.invalidate();
  assert((await settled).every(item => item.status === "rejected"));
  const next = client.request(workerSettings(), "searchTool", ["fresh"]);
  await until(() => workers.length === 2);
  workers[0].reply();
  assert.equal(client.getMetrics().staleResponses, 1);
  workers[1].reply();
  assert.equal(await next, "done");
  await assert.rejects(client.request(workerSettings(), "searchTool", ["x".repeat(limits.maxRequestChars + 1)]), /too large/);
  await assert.rejects(client.request(workerSettings(), "readTool", [{ fragmentIds: Array(129).fill("id") }]), /Too many/);
  const pending = client.request(workerSettings(), "searchTool", ["pending"]);
  const rejected = assert.rejects(pending, /disposed/);
  client.dispose();
  client.dispose();
  await rejected;
  await assert.rejects(client.request(workerSettings(), "searchTool", ["later"]), /disposed/);
  await until(() => !client.getMetrics().workerRunning);
  assert.equal(client.getMetrics().queuedJobs, 0);
});

test("real worker timeout/crash restarts lazily without overlapping generations", async t => {
  const fixture = makeCorpus("restart", [{ title: "Restart", text: "needle", summary: "needle" }]);
  for (const mode of ["timeout", "crash"]) {
    let starts = 0;
    let live = 0;
    let peakLive = 0;
    const { service } = serviceFor(t, fixture.root, { worker: {
      timeoutMs: mode === "timeout" ? 300 : 3000, restartDelayMs: 0,
      workerFactory: (filename, options) => {
        const worker = starts++ === 0
          ? new Worker(mode === "timeout" ? "while (true) {}" : "throw new Error('injected docs crash')", { ...options, eval: true })
          : new Worker(filename, options);
        live += 1;
        peakLive = Math.max(peakLive, live);
        worker.on("exit", () => { live -= 1; });
        return worker;
      }
    } });
    assert.equal(await service.searchTool("needle"), undefined);
    await until(() => !service.getMetrics().workerRunning);
    assert.equal(starts, 1, "failures must not trigger an automatic respawn loop");
    const result = await service.searchTool("needle");
    assert.equal(result.fragments[0].title, "Restart");
    assert.equal(peakLive, 1);
    assert.equal(service.getMetrics()[mode === "timeout" ? "timeouts" : "crashes"], 1);
  }
});

test("changed settings discard in-flight results; snapshot hooks bypass legacy validation", async t => {
  const workers = [];
  const paths = { normalizedPath: "first", sourcePath: "" };
  const { service, settings } = serviceFor(t, "unused", {
    getDocsSettingsSnapshot: () => paths,
    worker: { workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } }
  });
  settings.getDocsSettingsView = () => { throw new Error("legacy discovery must not run"); };
  const pending = service.searchTool("needle");
  paths.normalizedPath = "second";
  workers[0].reply();
  assert.equal(await pending, undefined);
  assert.equal(service.getMetrics().invalidations, 1);
  const fresh = service.searchTool("needle");
  await until(() => workers.length === 2);
  assert.equal(workers[1].requests[0].settings.normalizedPath, "second");
  workers[1].reply();
  assert.equal(await fresh, "done");
});

test("worker idles down and oversized corpus/records fail within explicit budgets", async t => {
  const fixture = makeCorpus("idle", [{ text: "needle" }]);
  const { service } = serviceFor(t, fixture.root, { worker: { idleMs: 20 } });
  assert(await service.searchTool("needle"));
  await until(() => !service.getMetrics().workerRunning);
  assert.equal(service.getMetrics().cachedFragments, 0);
  assert(await service.searchTool("needle"));
  assert.equal(service.getMetrics().workerStarts, 2);
  const many = makeCorpus("budget", smallRecords);
  await assert.rejects(corpusHelpers.loadDocsCorpora(many.root, { ...limits, maxFragments: 2 }), /fragment or text budget/);
  await assert.rejects(corpusHelpers.loadDocsCorpora(many.root, { ...limits, maxInputBytes: 20 }), /input byte budget/);
  await assert.rejects(corpusHelpers.loadDocsCorpora(many.root, { ...limits, maxRecordChars: 40 }), /record exceeds/);
  await assert.rejects(corpusHelpers.loadDocsCorpora(many.root, { ...limits, maxChars: 30 }), /fragment or text budget/);
  await assert.rejects(corpusHelpers.loadDocsCorpora(many.root, { ...limits, maxFiles: 0 }), /Too many docs corpus files/);
});

test("a changing corpus is retried once, never cached under the old fingerprint", async t => {
  for (const mutations of [1, 2]) {
    const fixture = makeCorpus(`mutation-${mutations}`, [{ title: "Alpha", text: "needle Alpha", summary: "needle" }]);
    const signal = new SharedArrayBuffer(4);
    const { service } = serviceFor(t, fixture.root, { worker: {
      workerFactory: (workerPath, options) => new Worker(path.join(__dirname, "fixtures/docs-mutating-worker.cjs"), {
        ...options, workerData: { workerPath, file: fs.realpathSync(fixture.file), mutations, signal }
      })
    } });
    const first = await service.searchTool("needle");
    assert.equal(Atomics.load(new Int32Array(signal), 0), mutations);
    if (mutations === 1) {
      assert.equal(first.fragments[0].title, "Bravo");
      assert.equal(service.getMetrics().loads, 1);
    } else {
      assert.equal(first, undefined);
      assert.equal(service.getMetrics().cachedFragments, 0);
      assert.equal((await service.searchTool("needle")).fragments[0].title, "Alpha");
    }
  }
});

test("invalidation fences a response delivered before its awaiting caller resumes", async t => {
  const worker = new FakeWorker();
  const { service } = serviceFor(t, "unused", { worker: { workerFactory: () => worker } });
  const pending = service.searchTool("needle");
  worker.reply();
  service.invalidate();
  assert.equal(await pending, undefined);
});

test("explicit paths do not depend on configured-root validation", async t => {
  const fixture = makeCorpus("explicit-independent", [{ title: "Needle", text: "needle" }]);
  const { service, settings } = serviceFor(t, "unused");
  settings.getDocsSettingsView = () => { throw new Error("broken configured roots"); };
  assert(await service.buildExplicitPathContext(`needle "${fixture.root}"`, temp));
});

test("queue deadlines also apply while an old generation is terminating", async () => {
  const worker = new FakeWorker();
  let finishTermination;
  worker.terminate = () => new Promise(resolve => { finishTermination = resolve; });
  const client = new DocsWorkerClient({ timeoutMs: 30, restartDelayMs: 0, workerFactory: () => worker });
  const first = client.request(workerSettings(), "searchTool", ["needle"]);
  const firstRejected = assert.rejects(first, /invalidated/);
  client.invalidate();
  await firstRejected;
  await assert.rejects(client.request(workerSettings(), "searchTool", ["waiting"]), /timed out/);
  assert.equal(client.getMetrics().queuedJobs, 0);
  assert.equal(client.getMetrics().workerStarts, 1);
  finishTermination(0);
  await until(() => !client.getMetrics().workerRunning);
  client.dispose();
});

test("startup errors are bounded and cooldown does not start new workers", async () => {
  let starts = 0;
  const client = new DocsWorkerClient({ restartDelayMs: 1000, workerFactory: () => { starts += 1; throw new Error("missing worker"); } });
  await assert.rejects(client.request(workerSettings(), "searchTool", ["needle"]), /missing worker/);
  await assert.rejects(client.request(workerSettings(), "searchTool", ["needle"]), /cooling down/);
  assert.equal(starts, 1);
  assert.equal(client.getMetrics().activeJobs, 0);
  assert.equal(client.getMetrics().queuedJobs, 0);
  client.dispose();
});

test("oversized planner metadata is rejected in the worker before crossing its port", async t => {
  const fixture = makeCorpus("large-metadata", Array.from({ length: 48 }, (_, index) => ({
    title: `${index} ${"long title ".repeat(3000)}`, summary: "needle", text: "needle"
  })), "manifest");
  const { service } = serviceFor(t, fixture.root);
  assert.equal(await service.buildPlannerInput(), undefined);
  assert.equal(service.getMetrics().failed, 1);
  assert(service.getMetrics().lastResponseBytes < 2048);
  assert.equal(service.getMetrics().workerStarts, 1);
});

test("source-isolated VM needs neither global performance nor global structuredClone", async t => {
  const { loadSource } = require("./service-test-utils.cjs");
  const { DocsContextService: IsolatedDocsContextService } = loadSource("src/docsContextService.ts");
  const fixture = makeCorpus("vm-isolated", [{ title: "Needle", text: "needle" }]);
  const service = new IsolatedDocsContextService(settingsFor(fixture.root), logger, {
    worker: { workerFactory: (_filename, options) => new Worker(path.join(helpers, "docsRetrievalWorker.js"), options) }
  });
  t.after(async () => { service.dispose(); await until(() => !service.getMetrics().workerRunning); });
  assert.equal((await service.searchTool("needle")).fragments[0].title, "Needle");
  await service.buildMetadataContext();
  assert.equal(service.getMetrics().metadataCalls, 1);
  assert(service.getMetrics().lastMetadataMs >= 0);
});

test("metadata preserves settings truth for notConfigured/error and reports host time separately", async t => {
  for (const status of ["notConfigured", "error"]) {
    const { service, settings } = serviceFor(t, "");
    settings.getDocsContextDetails = () => ({
      kind: "docs", status, source: "none", label: "Unavailable", normalizedPath: "/missing-docs",
      error: "Corpus not available", allowedRoots: [{ kind: "normalized", label: "Configured path", path: "/missing-docs", status: "error", error: "Not found" }]
    });
    const expected = (await oracle(settings, [["buildMetadataContext", []]]))[0];
    assert.deepEqual(await service.buildMetadataContext(), expected);
    assert.equal(service.getMetrics().workerStarts, 0);
    assert.equal(service.getMetrics().requests, 0);
    assert.equal(service.getMetrics().metadataCalls, 1);
    assert.equal(service.getMetrics().totalMetadataMs, service.getMetrics().lastMetadataMs);
  }
});

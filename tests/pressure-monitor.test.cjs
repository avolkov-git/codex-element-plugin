const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./service-test-utils.cjs");

const PREFIX = "Pressure metrics: ";

function harness({ sources = {}, intervalMs, histogramError, memoryError, loggerError,
  histogramOverrides = {}, usage = { rss: 1000, heapUsed: 200, heapTotal: 500, external: 50, arrayBuffers: 25 } } = {}) {
  let now = 0;
  const calls = { enabled: 0, disabled: 0, reset: 0, memory: 0, unref: 0, cleared: 0, percentiles: [] };
  const logs = [];
  const timer = { callback: undefined, delay: undefined, unref() { calls.unref += 1; } };
  const histogram = {
    count: 17, max: 31_250_000, percentile(value) { calls.percentiles.push(value); return 12_125_000; },
    enable() { calls.enabled += 1; }, disable() { calls.disabled += 1; }, reset() { calls.reset += 1; },
    ...histogramOverrides
  };
  const api = loadSource("src/pressureMonitor.ts", {
    "node:perf_hooks": {
      performance: { now: () => now },
      monitorEventLoopDelay(options) {
        assert.equal(options.resolution, 20);
        if (histogramError) throw new Error("private histogram failure");
        return histogram;
      }
    },
    "node:process": {
      pid: 120, ppid: 12,
      memoryUsage() {
        calls.memory += 1;
        if (memoryError) throw new Error("private memory failure");
        return usage;
      }
    },
    "node:timers": {
      setTimeout(callback, delay) { timer.callback = callback; timer.delay = delay; return timer; },
      clearTimeout(value) { assert.equal(value, timer); calls.cleared += 1; }
    }
  });
  const monitor = new api.PressureMonitor({ info(message) {
    logs.push(message);
    if (loggerError) throw new Error("private logger failure");
  } }, sources, { intervalMs });
  return { api, monitor, calls, logs, timer, histogram, at(value) { now = value; } };
}

function json(value) { return JSON.parse(JSON.stringify(value)); }

function assertNumericTree(value, allowed) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value));
    assert(value >= 0 && value <= Number.MAX_SAFE_INTEGER);
    return;
  }
  assert.equal(typeof value, "object");
  assert(!Array.isArray(value));
  for (const [key, child] of Object.entries(value)) {
    if (allowed) assert(allowed.has(key), `unexpected key ${key}`);
    assertNumericTree(child, allowed);
  }
}

test("lazy unref'ed timer samples Node memory, correlation PIDs and windowed delay in milliseconds", () => {
  let reads = 0;
  const h = harness({ sources: {
    runtime: () => { reads += 1; return { pendingRequests: 2, running: true }; },
    docs: () => ({ cacheHits: 4, cachedChars: 800, worker: { pendingJobs: 1 } }),
    ownedCodexPid: () => 345
  } });
  assert.equal(h.timer.delay, 10_000);
  assert.equal(h.calls.unref, 1);
  assert.equal(h.calls.enabled, 1);
  assert.equal(h.monitor.getMetrics(), undefined);
  assert.equal(reads, 0);
  assert.equal(h.calls.memory, 0);
  assert.equal(h.logs.length, 0);
  h.at(10_000);
  h.timer.callback();
  const metrics = h.monitor.getMetrics();
  assert.deepEqual(json(metrics.process), {
    pid: 120, ppid: 12, ownedCodexPid: 345, rssBytes: 1000, heapUsedBytes: 200,
    heapTotalBytes: 500, externalBytes: 50, arrayBuffersBytes: 25
  });
  assert.deepEqual(json(metrics.eventLoop), { samples: 17, maxMs: 31.25, p95Ms: 12.125 });
  assert.deepEqual(h.calls.percentiles, [95]);
  assert.equal(h.calls.reset, 1);
  assert.equal(metrics.sources.docs.worker.pendingJobs, 1);
  assert.equal(metrics.sourceErrors, 0);
  assert.equal(metrics.truncated, false);
  assert(h.logs[0].startsWith(PREFIX));
  assert.deepEqual(JSON.parse(h.logs[0].slice(PREFIX.length)), json(metrics));
  assertNumericTree(metrics);
  h.monitor.dispose();
});

test("manual sampling, repeated metrics reads and timer callbacks cannot flood sources or logs", () => {
  let reads = 0;
  const h = harness({ sources: { chat: () => ({ postedMessages: ++reads }) } });
  const first = h.monitor.sample();
  for (let now = 0; now < 10_000; now += 10) {
    h.at(now);
    h.timer.callback();
    assert.equal(h.monitor.sample(), first);
    assert.equal(h.monitor.getMetrics(), first);
  }
  assert.equal(reads, 1);
  assert.equal(h.calls.memory, 1);
  assert.equal(h.calls.reset, 1);
  assert.equal(h.logs.length, 1);
  h.at(10_000);
  const second = h.monitor.sample();
  assert.notEqual(second, first);
  assert.equal(reads, 2);
  assert.equal(h.logs.length, 2);
  h.monitor.dispose();
});

test("intervals are finite and bounded, including Node timer overflow and faster explicit calls", () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 0, -1, 1, 9999, "1"]) {
    const h = harness({ intervalMs: value });
    assert.equal(h.timer.delay, 10_000);
    h.monitor.dispose();
  }
  const huge = harness({ intervalMs: Number.MAX_VALUE });
  assert.equal(huge.timer.delay, 2_147_483_647);
  huge.monitor.dispose();
  const slow = harness({ intervalMs: 20_000.1 });
  assert.equal(slow.timer.delay, 20_001);
  slow.monitor.sample();
  slow.at(20_000);
  slow.monitor.sample();
  assert.equal(slow.logs.length, 1);
  slow.at(20_001);
  slow.monitor.sample();
  assert.equal(slow.logs.length, 2);
  slow.monitor.dispose();
});

test("slow providers and manual polls cannot put actual log calls less than ten seconds apart", () => {
  let slow = true;
  const h = harness({ sources: { runtime: () => {
    if (slow) h.at(11_000);
    return { count: 1 };
  } } });
  h.monitor.sample();
  slow = false;
  h.timer.callback();
  assert.equal(h.logs.length, 1);
  assert.equal(h.timer.delay, 10_000);
  h.at(20_999);
  h.timer.callback();
  assert.equal(h.timer.delay, 1);
  assert.equal(h.logs.length, 1);
  h.at(21_000);
  h.timer.callback();
  assert.equal(h.logs.length, 2);
  assert.equal(h.timer.delay, 10_000);
  h.monitor.dispose();
});

test("fixed source and recursive field allowlists discard payloads, dynamic keys and unsafe values", () => {
  let unsafeCalls = 0;
  const payload = Object.create({ retainedRows: 99 });
  Object.assign(payload, {
    pendingRequests: 3, running: true, count: null, queuedBytes: -100, cacheBytes: Number.MAX_VALUE,
    cacheHits: NaN, cacheMisses: Infinity, evictions: -Infinity, bytes: 10n,
    chars: Symbol("private"), entries: [1, 2, 3], active: () => "private text",
    method: "thread/private", query: "private query", text: "private text", path: "/private/path",
    "/private/source": 99, "thread/private": 101, toJSON() { unsafeCalls += 1; return "private JSON"; },
    rpc: { pendingRequests: 4, "thread/private": 5, text: "private text", cache: { count: 1 } }
  });
  Object.defineProperty(payload, "queuedMessages", { get() { unsafeCalls += 1; throw new Error("private getter"); } });
  const h = harness({ sources: {
    runtime: () => payload,
    "/private/source": () => { unsafeCalls += 1; throw new Error("private provider"); },
    "thread/private": () => { unsafeCalls += 1; return 100; }
  } });
  const metrics = h.monitor.sample();
  const runtime = json(metrics.sources.runtime);
  assert.deepEqual(runtime, {
    count: null, running: true, pendingRequests: 3, queuedBytes: 0,
    cacheBytes: Number.MAX_SAFE_INTEGER, cacheHits: null, cacheMisses: null, evictions: null,
    rpc: { pendingRequests: 4, cache: { count: 1 } }
  });
  assert.equal(unsafeCalls, 0);
  assert(!h.logs[0].includes("private"));
  assert.deepEqual(Object.keys(metrics.sources), ["runtime"]);
  assertNumericTree(metrics.sources.runtime, new Set(h.api.PRESSURE_METRIC_KEYS));
  h.monitor.dispose();
});

test("unknown source keys are never enumerated and provider properties must be own data properties", () => {
  let getterCalls = 0;
  const sources = Object.create({ chat: () => { throw new Error("inherited provider"); } });
  sources.runtime = () => new Proxy({ count: 1 }, { ownKeys() { throw new Error("enumeration forbidden"); } });
  Object.defineProperty(sources, "docs", { get() { getterCalls += 1; throw new Error("provider getter"); } });
  const h = harness({ sources: new Proxy(sources, { ownKeys() { throw new Error("enumeration forbidden"); } }) });
  const metrics = h.monitor.sample();
  assert.equal(metrics.sources.runtime.count, 1);
  assert.equal(metrics.sources.chat, undefined);
  assert.equal(metrics.sources.docs, null);
  assert.equal(metrics.sourceErrors, 1);
  assert.equal(getterCalls, 0);
  h.monitor.dispose();
});

test("RC runtime/chat/logger/history/docs/diff counter shapes fit together without dropping diagnostics", () => {
  const counters = {
    runtime: {
      notifications: 1, streamNotifications: 2, ignoredNotifications: 3, stdoutLines: 4,
      stdoutBytes: 5, maxLineBytes: 6, maxHandleMs: 7, diffFailures: 8, pid: 321, running: true
    },
    chat: {
      frames: 1, bytes: 2, maxFrameBytes: 3, postFailures: 4, ackTimeouts: 5, ackMaxMs: 6,
      serializeMaxMs: 7, frontendLagMs: 8, frontendReceiveMs: 9, pendingPosts: 1, pendingAck: 1,
      ackAgeMs: 10, visible: true, ready: true
    },
    logger: {
      queueBytes: 1, queueLines: 2, inflightBytes: 3, inflightLines: 4, inflight: 1,
      batches: 5, outputBatches: 6, fileWrites: 7, drops: { info: 1, warn: 2, error: 3 },
      oversizedLines: 8, fileErrors: 9, outputErrors: 10, fileDroppedLines: 11, outputDroppedLines: 12
    },
    history: {
      saveNowRequests: 1, scheduledSaveRequests: 2, coalescedSaves: 3,
      snapshotCaptures: 4, snapshotMs: 5, snapshotMaxMs: 6,
      savesStarted: 7, savesCompleted: 8, saveFailures: 9, rejectedSaveRequests: 10,
      saveMs: 11, saveMaxMs: 12, queueCurrent: 13, queueMax: 14, queueWaitMs: 15,
      queueWaitMaxMs: 16, scheduledSavePending: true,
      store: {
        saveAttempts: 1, savesCompleted: 2, saveFailures: 3, skippedWrites: 4, historyWrites: 5,
        backupWrites: 6, writtenBytes: 7, readBytes: 8, readCacheHits: 9,
        serializations: 10, serializedBytes: 11, serializationMs: 12, serializationMaxMs: 13,
        comparisonMs: 14, normalizationMs: 15, readMs: 16, lockWaitMs: 17,
        writeMs: 18, saveMs: 19, saveMaxMs: 20
      }
    },
    docs: {
      requests: 1, completed: 2, failed: 3, rejected: 4, timeouts: 5, crashes: 6,
      workerStarts: 7, restarts: 8, invalidations: 9, staleResponses: 10,
      peakQueuedJobs: 11, lastQueueWaitMs: 12, lastJobMs: 13, lastWorkerMs: 14,
      totalWorkerMs: 15, lastResponseBytes: 16, cacheHits: 17, cacheMisses: 18,
      evictions: 19, loads: 20, lastLoadMs: 21, cacheRoots: 22, cachedFragments: 23,
      cachedChars: 24, workerRunning: true, activeJobs: 1, queuedJobs: 1, disposed: false
    },
    diff: {
      updates: 1, maxPatchBytes: 2, maxParseMs: 3, written: 4, coalesced: 5, skipped: 6,
      failures: 7, evicted: 8, queuedBytes: 9, queuedPatches: 10, writing: true
    }
  };
  const h = harness({ sources: Object.fromEntries(Object.entries(counters).map(([name, values]) => [name, () => values])) });
  const metrics = h.monitor.sample();
  assert.deepEqual(json(metrics.sources), counters);
  assert.equal(metrics.truncated, false);
  assert.equal(metrics.sourceErrors, 0);
  assert(h.logs[0].length <= 8192);
  assertNumericTree(metrics);
  h.monitor.dispose();
});

test("cycles, deep nesting, wide trees and huge unknown key sets have bounded work and JSON", () => {
  const h = harness();
  const cycle = { count: 1 };
  cycle.cache = cycle;
  const deep = { count: 2, cache: { count: 3, cache: { count: 4, cache: { count: 5 } } } };
  let descriptors = 0;
  const wide = Object.fromEntries(h.api.PRESSURE_METRIC_KEYS.map((key) => [key, Number.MAX_VALUE]));
  for (let i = 0; i < 20_000; i += 1) wide[`private-payload-${i}`] = "private";
  const observed = new Proxy(wide, {
    ownKeys() { throw new Error("must not enumerate all input fields"); },
    getOwnPropertyDescriptor(target, key) { descriptors += 1; return Object.getOwnPropertyDescriptor(target, key); }
  });
  h.monitor.dispose();
  const bounded = harness({ sources: {
    runtime: () => cycle, chat: () => deep,
    logger: () => observed, history: () => observed, docs: () => observed, diff: () => observed
  } });
  const metrics = bounded.monitor.sample();
  assert.equal(metrics.sources.runtime.cache, null);
  assert.equal(metrics.sources.chat.cache.cache.cache, null);
  assert.equal(metrics.truncated, true);
  assert(Object.keys(metrics.sources.logger).length <= 32);
  assert(descriptors <= h.api.PRESSURE_METRIC_KEYS.length * 4);
  assert(bounded.logs[0].length <= 8192);
  assert(!bounded.logs[0].includes("private"));
  assertNumericTree(metrics);
  bounded.monitor.dispose();
});

test("the total field budget also bounds adversarial recursive groups across every source", () => {
  const h = harness();
  let tree = Object.fromEntries(h.api.PRESSURE_METRIC_KEYS.map((key) => [key, Number.MIN_VALUE]));
  for (let depth = 0; depth < 5; depth += 1) {
    tree = Object.fromEntries(h.api.PRESSURE_METRIC_KEYS.map((key) => [key, tree]));
  }
  const sources = Object.fromEntries(h.api.PRESSURE_SOURCE_NAMES.map((name) => [name, () => tree]));
  h.monitor.dispose();
  const bounded = harness({ sources });
  const metrics = bounded.monitor.sample();
  function fields(value) {
    return value && typeof value === "object"
      ? Object.values(value).reduce((count, child) => count + 1 + fields(child), 0) : 0;
  }
  assert(fields(metrics.sources) <= 128 + h.api.PRESSURE_SOURCE_NAMES.length);
  assert.equal(metrics.truncated, true);
  assert(bounded.logs[0].length <= 8192);
  assertNumericTree(metrics);
  bounded.monitor.dispose();
});

test("provider exceptions and hostile descriptors do not stop other sources or future samples", () => {
  let failing = true;
  const h = harness({ sources: {
    runtime: () => { if (failing) throw new Error("secret provider error"); return { count: 7 }; },
    chat: () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("secret proxy error"); } }),
    docs: () => ({ cacheHits: 2 }), ownedCodexPid: () => { throw new Error("secret pid error"); }
  } });
  assert.doesNotThrow(() => h.timer.callback());
  assert.equal(h.monitor.getMetrics().sources.runtime, null);
  assert.equal(h.monitor.getMetrics().sources.chat, null);
  assert.equal(h.monitor.getMetrics().sources.docs.cacheHits, 2);
  assert.equal(h.monitor.getMetrics().process.ownedCodexPid, null);
  assert.equal(h.monitor.getMetrics().sourceErrors, 3);
  assert(!h.logs[0].includes("secret"));
  failing = false;
  h.at(10_000);
  assert.equal(h.monitor.sample().sources.runtime.count, 7);
  h.monitor.dispose();
});

test("accidental asynchronous sources cannot create unhandled rejection crashes", async () => {
  const h = harness({ sources: {
    runtime: async () => { throw new Error("private rejection"); }, docs: async () => ({ count: 1 })
  } });
  const metrics = h.monitor.sample();
  assert.equal(metrics.sources.runtime, null);
  assert.equal(metrics.sources.docs, null);
  assert.equal(metrics.sourceErrors, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert(!h.logs[0].includes("private"));
  h.monitor.dispose();
});

test("empty/unavailable histograms use null delay and finite values are clamped", () => {
  const empty = harness();
  empty.histogram.count = 0;
  empty.histogram.max = 9_223_372_036_854_776_000;
  assert.deepEqual(json(empty.monitor.sample().eventLoop), { samples: 0, maxMs: null, p95Ms: null });
  assert.equal(empty.calls.percentiles.length, 0);
  empty.at(10_000);
  empty.histogram.count = 2;
  empty.histogram.percentile = () => NaN;
  assert.deepEqual(json(empty.monitor.sample().eventLoop), { samples: 2, maxMs: 3_600_000, p95Ms: null });
  empty.monitor.dispose();
  const unavailable = harness({ histogramError: true, memoryError: true });
  const metrics = unavailable.monitor.sample();
  assert.deepEqual(json(metrics.eventLoop), { samples: null, maxMs: null, p95Ms: null });
  assert.equal(metrics.process.rssBytes, null);
  assert.equal(metrics.process.heapUsedBytes, null);
  assert.equal(metrics.process.pid, 120);
  unavailable.monitor.dispose();
  assert.equal(unavailable.calls.disabled, 0);
});

test("histogram read/reset failures and logger exceptions stay isolated and rate-limited", () => {
  const h = harness({ loggerError: true });
  h.histogram.percentile = () => { throw new Error("private histogram failure"); };
  h.histogram.reset = () => { throw new Error("private reset failure"); };
  assert.doesNotThrow(() => h.monitor.sample());
  assert.equal(h.calls.disabled, 1);
  assert.equal(h.monitor.getMetrics().eventLoop.p95Ms, null);
  h.monitor.sample();
  assert.equal(h.logs.length, 1);
  h.at(10_000);
  assert.doesNotThrow(() => h.monitor.sample());
  assert.equal(h.monitor.getMetrics().eventLoop.samples, null);
  assert.equal(h.logs.length, 2);
  h.monitor.dispose();
  assert.equal(h.calls.disabled, 1);
});

test("failed histogram enable is cleaned up and disable failures never prevent disposal", () => {
  const failedEnable = harness({ histogramOverrides: {
    enable() { throw new Error("private enable failure"); }
  } });
  assert.equal(failedEnable.calls.disabled, 1);
  assert.equal(failedEnable.monitor.sample().eventLoop.samples, null);
  failedEnable.monitor.dispose();
  assert.equal(failedEnable.calls.disabled, 1);
  const failedDisable = harness({ histogramOverrides: {
    disable() { throw new Error("private disable failure"); }
  } });
  assert.doesNotThrow(() => failedDisable.monitor.dispose());
  assert.equal(failedDisable.calls.cleared, 1);
  failedDisable.timer.callback();
  assert.equal(failedDisable.logs.length, 0);
});

test("invalid or oversized memory counters cannot emit non-finite or unbounded values", () => {
  const h = harness({ usage: {
    rss: Number.MAX_VALUE, heapUsed: NaN, heapTotal: Infinity, external: -1, arrayBuffers: "private"
  } });
  const metrics = h.monitor.sample();
  assert.equal(metrics.process.rssBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(metrics.process.heapUsedBytes, null);
  assert.equal(metrics.process.heapTotalBytes, null);
  assert.equal(metrics.process.externalBytes, 0);
  assert.equal(metrics.process.arrayBuffersBytes, null);
  assertNumericTree(metrics);
  h.monitor.dispose();
});

test("PID correlation rejects invalid values without coercion, clamping or process discovery", () => {
  for (const value of [undefined, null, "345", 0, -1, 1.5, NaN, Infinity, 2_147_483_648, { pid: 345 }]) {
    const h = harness({ sources: { ownedCodexPid: () => value } });
    assert.equal(h.monitor.sample().process.ownedCodexPid, null);
    h.monitor.dispose();
  }
  let owned = 321;
  const h = harness({ sources: { ownedCodexPid: () => owned } });
  assert.equal(h.monitor.sample().process.ownedCodexPid, 321);
  owned = null;
  h.at(10_000);
  assert.equal(h.monitor.sample().process.ownedCodexPid, null);
  h.monitor.dispose();
});

test("snapshots are deeply immutable detached values and source mutation cannot alter logged metrics", () => {
  const source = { cache: { count: 3 } };
  const h = harness({ sources: { docs: () => source } });
  const snapshot = h.monitor.sample();
  for (const value of [snapshot, snapshot.process, snapshot.eventLoop, snapshot.sources, snapshot.sources.docs, snapshot.sources.docs.cache]) {
    assert(Object.isFrozen(value));
  }
  source.cache.count = 900;
  assert.equal(h.monitor.getMetrics().sources.docs.cache.count, 3);
  assert.deepEqual(json(snapshot), JSON.parse(h.logs[0].slice(PREFIX.length)));
  h.monitor.dispose();
});

test("disposal is idempotent and disables queued callbacks, explicit samples and the histogram", () => {
  let reads = 0;
  const h = harness({ sources: { runtime: () => ({ count: ++reads }) } });
  const snapshot = h.monitor.sample();
  h.monitor.dispose();
  h.monitor.dispose();
  h.at(100_000);
  h.timer.callback();
  assert.equal(h.monitor.sample(), snapshot);
  assert.equal(reads, 1);
  assert.equal(h.calls.memory, 1);
  assert.equal(h.calls.reset, 1);
  assert.equal(h.calls.disabled, 1);
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.logs.length, 1);
  const early = harness();
  early.monitor.dispose();
  early.timer.callback();
  assert.equal(early.monitor.sample(), undefined);
  assert.equal(early.logs.length, 0);
});

test("provider re-entry and disposal during sampling cannot trigger extra work or post-disposal logs", () => {
  let monitor;
  let reads = 0;
  const h = harness({ sources: {
    runtime: () => { reads += 1; monitor.sample(); return { count: 1 }; },
    chat: () => { monitor.dispose(); return { count: 2 }; },
    docs: () => { reads += 1; return { count: 3 }; }
  } });
  monitor = h.monitor;
  assert.equal(monitor.sample(), undefined);
  assert.equal(reads, 1);
  assert.equal(h.logs.length, 0);
  assert.equal(h.calls.disabled, 1);
  assert.equal(h.calls.cleared, 1);
});

test("real Node telemetry works source-isolated without generated dist or a referenced timer", () => {
  const { PressureMonitor } = loadSource("src/pressureMonitor.ts");
  const logs = [];
  const monitor = new PressureMonitor({ info: (message) => logs.push(message) }, {});
  try {
    assert.equal(monitor.timer.hasRef(), false);
    const metrics = monitor.sample();
    assert.equal(metrics.process.pid, process.pid);
    assert.equal(metrics.process.ppid, process.ppid);
    assert(metrics.process.rssBytes > 0);
    assert(metrics.process.heapUsedBytes > 0);
    assert.equal(logs.length, 1);
    assertNumericTree(metrics);
  } finally {
    monitor.dispose();
  }
});

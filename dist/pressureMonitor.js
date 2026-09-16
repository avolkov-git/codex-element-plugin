"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PressureMonitor = exports.PRESSURE_METRIC_KEYS = exports.PRESSURE_SOURCE_NAMES = void 0;
const node_perf_hooks_1 = require("node:perf_hooks");
const node_process_1 = require("node:process");
const node_timers_1 = require("node:timers");
const node_util_1 = require("node:util");
const MIN_INTERVAL_MS = 10000;
const MAX_INTERVAL_MS = 2147483647;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 3;
const MAX_FIELDS_PER_OBJECT = 32;
const MAX_FIELDS_PER_SAMPLE = 128;
const MAX_LOG_CHARS = 8192;
const LOG_PREFIX = "Pressure metrics: ";
exports.PRESSURE_SOURCE_NAMES = Object.freeze(["runtime", "chat", "logger", "history", "docs", "diff"]);
// Fixed keys, including nested counter groups: never enumerate provider-owned keys.
// Adapters should aggregate by these names, not by RPC method, chat ID or path.
exports.PRESSURE_METRIC_KEYS = Object.freeze([
    "count", "bytes", "chars", "entries", "pending", "queued", "active", "running",
    "enabled", "disposed", "ready", "visible", "dirty", "inFlight",
    "pendingRequests", "pendingNotifications", "pendingApprovals", "pendingUserInputs",
    "queuedPrompts", "activeTurns", "backendThreads", "completedTurns", "hiddenPlannerRuns",
    "itemRoutes", "turnContexts", "stdinQueuedBytes", "stdoutBufferedBytes", "stderrBufferedBytes",
    "bytesRead", "bytesWritten", "requests", "notifications", "droppedNotifications",
    "panels", "retainedRows", "retainedBytes", "postedMessages", "postedBytes",
    "acknowledgedMessages", "queuedMessages", "coalescedMessages",
    "queuedEntries", "queuedBytes", "droppedEntries", "droppedBytes", "writtenEntries",
    "writtenBytes", "writeErrors", "pendingWrites", "rotations",
    "pendingSaves", "activeSaves", "queuedSaves", "saveCount", "saveErrors",
    "saveDurationMs", "lastSaveMs", "persistedBytes", "loadedChats", "loadedMessages",
    "retainedMessages", "retainedChars", "baselines", "blockedScopes",
    "cacheEntries", "cacheBytes", "cacheChars", "cacheHits", "cacheMisses", "evictions",
    "loads", "lastLoadMs", "cacheRoots", "cachedFragments", "cachedChars",
    "pendingJobs", "activeJobs", "completedJobs", "failedJobs", "workerRunning", "workers", "restarts",
    "artifacts", "artifactCount", "totalChars", "maxChars", "maxBytes",
    "rpc", "transport", "bridge", "queue", "cache", "worker", "search", "store", "sidebar",
    // RC production counters. These are static aggregate names, never payload keys.
    "pid", "streamNotifications", "ignoredNotifications", "stdoutLines", "stdoutBytes",
    "maxLineBytes", "maxHandleMs", "diffFailures",
    "frames", "maxFrameBytes", "postFailures", "ackTimeouts", "ackMaxMs", "serializeMaxMs",
    "frontendLagMs", "frontendReceiveMs", "pendingPosts", "pendingAck", "ackAgeMs",
    "queueBytes", "queueLines", "inflightBytes", "inflightLines", "inflight", "batches",
    "outputBatches", "fileWrites", "drops", "info", "warn", "error", "oversizedLines",
    "fileErrors", "outputErrors", "fileDroppedLines", "outputDroppedLines",
    "saveNowRequests", "scheduledSaveRequests", "coalescedSaves", "snapshotCaptures", "snapshotMs",
    "snapshotMaxMs", "savesStarted", "savesCompleted", "saveFailures", "rejectedSaveRequests",
    "saveMs", "saveMaxMs", "queueCurrent", "queueMax", "queueWaitMs", "queueWaitMaxMs",
    "scheduledSavePending", "saveAttempts", "skippedWrites", "historyWrites", "backupWrites",
    "readBytes", "readCacheHits", "serializations", "serializedBytes", "serializationMs",
    "serializationMaxMs", "comparisonMs", "normalizationMs", "readMs", "lockWaitMs", "writeMs",
    "completed", "failed", "rejected", "timeouts", "crashes", "workerStarts", "invalidations",
    "staleResponses", "peakQueuedJobs", "lastQueueWaitMs", "lastJobMs", "lastWorkerMs",
    "totalWorkerMs", "lastResponseBytes", "queuedJobs", "metadataCalls", "lastMetadataMs", "totalMetadataMs",
    "updates", "maxPatchBytes", "maxParseMs", "written", "coalesced", "skipped", "failures",
    "evicted", "queuedPatches", "writing"
]);
/**
 * Sources must return cheap synchronous counters. Only PRESSURE_SOURCE_NAMES and
 * PRESSURE_METRIC_KEYS are accepted; unknown keys, strings, arrays, inherited
 * properties and accessors are ignored. Numbers are finite and clamped to
 * [0, Number.MAX_SAFE_INTEGER]. Trees have at most 3 object levels, 32 fields
 * per object and 128 fields total; each complete log line is at most 8192 chars.
 *
 * Optional sources.ownedCodexPid returns the PID currently owned by the runtime,
 * or null. It is correlation metadata only, never a process-discovery hint.
 * RSS/heap and event-loop delay describe THIS Node process, not its parent or
 * Codex. Java/Theia RSS is unavailable without external process correlation.
 * This monitor does not inspect files, enumerate processes or launch commands.
 */
class PressureMonitor {
    constructor(logger, sources, options = {}) {
        this.logger = logger;
        this.sources = sources;
        this.disposed = false;
        this.sampling = false;
        const interval = options.intervalMs;
        this.intervalMs = typeof interval === "number" && Number.isFinite(interval)
            ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.ceil(interval)))
            : MIN_INTERVAL_MS;
        try {
            this.histogram = (0, node_perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
            this.histogram.enable();
        }
        catch {
            this.disableHistogram();
        }
        // No eager provider reads or startup log; the timer must not keep Node alive.
        this.schedule();
    }
    /** Last immutable snapshot, or undefined before the first sample. Never polls. */
    getMetrics() {
        return this.metrics;
    }
    /** Polls and logs at most once per interval, including explicit calls/re-entry. */
    sample() {
        if (this.disposed || this.sampling)
            return this.metrics;
        const now = node_perf_hooks_1.performance.now();
        if (this.lastSampleAt !== undefined && now - this.lastSampleAt < this.intervalMs)
            return this.metrics;
        this.lastSampleAt = now;
        this.sampling = true;
        try {
            const processMetrics = {
                pid: validPid(node_process_1.pid), ppid: validPid(node_process_1.ppid, true), ownedCodexPid: null,
                rssBytes: null, heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, arrayBuffersBytes: null
            };
            try {
                const usage = (0, node_process_1.memoryUsage)();
                processMetrics.rssBytes = boundedNumber(usage.rss);
                processMetrics.heapUsedBytes = boundedNumber(usage.heapUsed);
                processMetrics.heapTotalBytes = boundedNumber(usage.heapTotal);
                processMetrics.externalBytes = boundedNumber(usage.external);
                processMetrics.arrayBuffersBytes = boundedNumber(usage.arrayBuffers);
            }
            catch { /* Memory telemetry is best-effort. */ }
            const eventLoop = this.readEventLoop();
            const sampled = {};
            const budget = { remaining: MAX_FIELDS_PER_SAMPLE, truncated: false };
            let sourceErrors = 0;
            for (const name of [...exports.PRESSURE_SOURCE_NAMES, "ownedCodexPid"]) {
                if (this.disposed)
                    break;
                try {
                    const descriptor = Object.getOwnPropertyDescriptor(this.sources, name);
                    if (!descriptor)
                        continue;
                    if (typeof descriptor.value !== "function")
                        throw new Error();
                    const value = descriptor.value();
                    if (node_util_1.types.isPromise(value)) {
                        // Async providers are unsupported, but their rejections must be consumed.
                        void Promise.prototype.then.call(value, undefined, () => undefined);
                        throw new Error();
                    }
                    if (name === "ownedCodexPid") {
                        processMetrics.ownedCodexPid = validPid(value);
                    }
                    else {
                        sampled[name] = sanitize(value, budget, 0, new Set()) ?? null;
                    }
                }
                catch {
                    sourceErrors += 1;
                    if (name !== "ownedCodexPid")
                        sampled[name] = null;
                }
            }
            if (this.disposed)
                return this.metrics;
            let snapshot = {
                process: Object.freeze(processMetrics), eventLoop, sources: Object.freeze(sampled),
                sourceErrors, truncated: budget.truncated
            };
            let message = LOG_PREFIX + JSON.stringify(snapshot);
            if (message.length > MAX_LOG_CHARS) {
                snapshot = { ...snapshot, sources: Object.freeze({}), truncated: true };
                message = LOG_PREFIX + JSON.stringify(snapshot);
            }
            this.metrics = Object.freeze(snapshot);
            // Rate-limit from the log call, not the start of a possibly slow provider.
            this.lastSampleAt = node_perf_hooks_1.performance.now();
            try {
                this.logger.info(message);
            }
            catch { /* Logging failures must not affect the extension or cause retries. */ }
            return this.metrics;
        }
        finally {
            this.sampling = false;
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.timer)
            (0, node_timers_1.clearTimeout)(this.timer);
        this.timer = undefined;
        this.disableHistogram();
    }
    schedule() {
        if (this.disposed)
            return;
        const delay = this.lastSampleAt === undefined ? this.intervalMs
            : Math.max(1, Math.ceil(this.intervalMs - (node_perf_hooks_1.performance.now() - this.lastSampleAt)));
        this.timer = (0, node_timers_1.setTimeout)(() => {
            if (this.disposed)
                return;
            this.timer = undefined;
            try {
                this.sample();
            }
            finally {
                this.schedule();
            }
        }, delay);
        this.timer.unref();
    }
    readEventLoop() {
        const result = {
            samples: null, maxMs: null, p95Ms: null
        };
        const histogram = this.histogram;
        if (histogram) {
            try {
                result.samples = boundedNumber(histogram.count);
                if (result.samples !== null && result.samples > 0) {
                    result.maxMs = milliseconds(histogram.max);
                    result.p95Ms = milliseconds(histogram.percentile(95));
                }
            }
            catch { /* Unavailable histogram values remain null, never NaN/sentinels. */ }
            try {
                histogram.reset();
            }
            catch {
                this.disableHistogram();
            }
        }
        return Object.freeze(result);
    }
    disableHistogram() {
        const histogram = this.histogram;
        this.histogram = undefined;
        try {
            histogram?.disable();
        }
        catch { /* Disposal stays best-effort even when telemetry is unavailable. */ }
    }
}
exports.PressureMonitor = PressureMonitor;
function boundedNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_VALUE, Math.max(0, value)) : null;
}
function validPid(value, allowZero = false) {
    return typeof value === "number" && Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_INTERVAL_MS
        ? value : null;
}
function milliseconds(nanoseconds) {
    if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds))
        return null;
    return Math.round(Math.min(3600000, Math.max(0, nanoseconds / 1000000)) * 1000) / 1000;
}
function sanitize(value, budget, depth, ancestors) {
    if (typeof value === "number")
        return boundedNumber(value);
    if (value === null || typeof value === "boolean")
        return value;
    if (typeof value !== "object" || Array.isArray(value))
        return undefined;
    if (depth >= MAX_DEPTH || ancestors.has(value)) {
        budget.truncated = true;
        return null;
    }
    const result = Object.create(null);
    let fields = 0;
    ancestors.add(value);
    for (const key of exports.PRESSURE_METRIC_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
            continue;
        if (fields >= MAX_FIELDS_PER_OBJECT || budget.remaining === 0) {
            budget.truncated = true;
            break;
        }
        // Charge before descending so nested objects cannot overrun the shared budget.
        budget.remaining -= 1;
        const sanitized = sanitize(descriptor.value, budget, depth + 1, ancestors);
        if (sanitized !== undefined) {
            result[key] = sanitized;
            fields += 1;
        }
    }
    ancestors.delete(value);
    return Object.freeze(result);
}
//# sourceMappingURL=pressureMonitor.js.map
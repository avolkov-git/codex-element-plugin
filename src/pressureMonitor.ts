import { monitorEventLoopDelay, performance, IntervalHistogram } from "node:perf_hooks";
import { memoryUsage, pid, ppid } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { types } from "node:util";

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 2_147_483_647;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 3;
const MAX_FIELDS_PER_OBJECT = 32;
const MAX_FIELDS_PER_SAMPLE = 128;
const MAX_LOG_CHARS = 8192;
const LOG_PREFIX = "Pressure metrics: ";

export const PRESSURE_SOURCE_NAMES = Object.freeze(["runtime", "chat", "logger", "history", "docs", "diff"] as const);

// Fixed keys, including nested counter groups: never enumerate provider-owned keys.
// Adapters should aggregate by these names, not by RPC method, chat ID or path.
export const PRESSURE_METRIC_KEYS = Object.freeze([
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
] as const);

export interface PressureMonitorOptions {
  /** Defaults to 10 seconds; clamped to [10 seconds, Node's maximum timer delay]. */
  intervalMs?: number;
}

export type PressureMetricValue = number | boolean | null | PressureMetricFields;
export interface PressureMetricFields {
  readonly [key: string]: PressureMetricValue;
}

export interface PressureMetrics {
  readonly process: {
    readonly pid: number | null;
    readonly ppid: number | null;
    readonly ownedCodexPid: number | null;
    readonly rssBytes: number | null;
    readonly heapUsedBytes: number | null;
    readonly heapTotalBytes: number | null;
    readonly externalBytes: number | null;
    readonly arrayBuffersBytes: number | null;
  };
  readonly eventLoop: {
    readonly samples: number | null;
    readonly maxMs: number | null;
    readonly p95Ms: number | null;
  };
  readonly sources: Readonly<Partial<Record<typeof PRESSURE_SOURCE_NAMES[number], PressureMetricValue>>>;
  readonly sourceErrors: number;
  readonly truncated: boolean;
}

interface FieldBudget {
  remaining: number;
  truncated: boolean;
}

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
export class PressureMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly intervalMs: number;
  private histogram: IntervalHistogram | undefined;
  private metrics: PressureMetrics | undefined;
  private lastSampleAt: number | undefined;
  private disposed = false;
  private sampling = false;

  constructor(
    private readonly logger: { info(message: string): void },
    private readonly sources: Record<string, () => unknown>,
    options: PressureMonitorOptions = {}
  ) {
    const interval = options.intervalMs;
    this.intervalMs = typeof interval === "number" && Number.isFinite(interval)
      ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.ceil(interval)))
      : MIN_INTERVAL_MS;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
    } catch {
      this.disableHistogram();
    }
    // No eager provider reads or startup log; the timer must not keep Node alive.
    this.schedule();
  }

  /** Last immutable snapshot, or undefined before the first sample. Never polls. */
  getMetrics(): PressureMetrics | undefined {
    return this.metrics;
  }

  /** Polls and logs at most once per interval, including explicit calls/re-entry. */
  sample(): PressureMetrics | undefined {
    if (this.disposed || this.sampling) return this.metrics;
    const now = performance.now();
    if (this.lastSampleAt !== undefined && now - this.lastSampleAt < this.intervalMs) return this.metrics;
    this.lastSampleAt = now;
    this.sampling = true;
    try {
      const processMetrics: { -readonly [K in keyof PressureMetrics["process"]]: PressureMetrics["process"][K] } = {
        pid: validPid(pid), ppid: validPid(ppid, true), ownedCodexPid: null,
        rssBytes: null, heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, arrayBuffersBytes: null
      };
      try {
        const usage = memoryUsage();
        processMetrics.rssBytes = boundedNumber(usage.rss);
        processMetrics.heapUsedBytes = boundedNumber(usage.heapUsed);
        processMetrics.heapTotalBytes = boundedNumber(usage.heapTotal);
        processMetrics.externalBytes = boundedNumber(usage.external);
        processMetrics.arrayBuffersBytes = boundedNumber(usage.arrayBuffers);
      } catch { /* Memory telemetry is best-effort. */ }
      const eventLoop = this.readEventLoop();
      const sampled: Partial<Record<typeof PRESSURE_SOURCE_NAMES[number], PressureMetricValue>> = {};
      const budget: FieldBudget = { remaining: MAX_FIELDS_PER_SAMPLE, truncated: false };
      let sourceErrors = 0;
      for (const name of [...PRESSURE_SOURCE_NAMES, "ownedCodexPid"] as const) {
        if (this.disposed) break;
        try {
          const descriptor = Object.getOwnPropertyDescriptor(this.sources, name);
          if (!descriptor) continue;
          if (typeof descriptor.value !== "function") throw new Error();
          const value: unknown = descriptor.value();
          if (types.isPromise(value)) {
            // Async providers are unsupported, but their rejections must be consumed.
            void Promise.prototype.then.call(value, undefined, () => undefined);
            throw new Error();
          }
          if (name === "ownedCodexPid") {
            processMetrics.ownedCodexPid = validPid(value);
          } else {
            sampled[name] = sanitize(value, budget, 0, new Set()) ?? null;
          }
        } catch {
          sourceErrors += 1;
          if (name !== "ownedCodexPid") sampled[name] = null;
        }
      }
      if (this.disposed) return this.metrics;
      let snapshot: PressureMetrics = {
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
      this.lastSampleAt = performance.now();
      try {
        this.logger.info(message);
      } catch { /* Logging failures must not affect the extension or cause retries. */ }
      return this.metrics;
    } finally {
      this.sampling = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.disableHistogram();
  }

  private schedule(): void {
    if (this.disposed) return;
    const delay = this.lastSampleAt === undefined ? this.intervalMs
      : Math.max(1, Math.ceil(this.intervalMs - (performance.now() - this.lastSampleAt)));
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      this.timer = undefined;
      try {
        this.sample();
      } finally {
        this.schedule();
      }
    }, delay);
    this.timer.unref();
  }

  private readEventLoop(): PressureMetrics["eventLoop"] {
    const result: { -readonly [K in keyof PressureMetrics["eventLoop"]]: PressureMetrics["eventLoop"][K] } = {
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
      } catch { /* Unavailable histogram values remain null, never NaN/sentinels. */ }
      try {
        histogram.reset();
      } catch {
        this.disableHistogram();
      }
    }
    return Object.freeze(result);
  }

  private disableHistogram(): void {
    const histogram = this.histogram;
    this.histogram = undefined;
    try {
      histogram?.disable();
    } catch { /* Disposal stays best-effort even when telemetry is unavailable. */ }
  }
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_VALUE, Math.max(0, value)) : null;
}

function validPid(value: unknown, allowZero = false): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_INTERVAL_MS
    ? value : null;
}

function milliseconds(nanoseconds: unknown): number | null {
  if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds)) return null;
  return Math.round(Math.min(3_600_000, Math.max(0, nanoseconds / 1_000_000)) * 1000) / 1000;
}

function sanitize(value: unknown, budget: FieldBudget, depth: number, ancestors: Set<object>): PressureMetricValue | undefined {
  if (typeof value === "number") return boundedNumber(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  if (depth >= MAX_DEPTH || ancestors.has(value)) {
    budget.truncated = true;
    return null;
  }
  const result: Record<string, PressureMetricValue> = Object.create(null);
  let fields = 0;
  ancestors.add(value);
  for (const key of PRESSURE_METRIC_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
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

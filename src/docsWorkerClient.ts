import * as path from "path";
import { performance } from "node:perf_hooks";
import { deserialize, serialize } from "node:v8";
import { Worker, WorkerOptions } from "worker_threads";
import {
  DOCS_WORKER_LIMITS,
  DocsWorkerCacheMetrics,
  DocsWorkerMethod,
  DocsWorkerRequest,
  DocsWorkerResponse,
  DocsWorkerSettings,
  validateDocsRequest
} from "./docsWorkerProtocol";

export interface DocsWorkerClientOptions {
  timeoutMs?: number;
  idleMs?: number;
  restartDelayMs?: number;
  workerFactory?: (filename: string, options: WorkerOptions) => Worker;
}

interface Job {
  request: DocsWorkerRequest;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const EMPTY_CACHE_METRICS: DocsWorkerCacheMetrics = {
  cacheHits: 0, cacheMisses: 0, evictions: 0, loads: 0, lastLoadMs: 0,
  cacheRoots: 0, cachedFragments: 0, cachedChars: 0
};

export class DocsWorkerClient {
  private worker: Worker | undefined;
  private retiring: Promise<void> | undefined;
  private active: Job | undefined;
  private readonly queue: Job[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private nextId = 0;
  private restartAfter = 0;
  private cacheMetrics = { ...EMPTY_CACHE_METRICS };
  private readonly metrics = {
    requests: 0, completed: 0, failed: 0, rejected: 0, timeouts: 0, crashes: 0,
    workerStarts: 0, restarts: 0, invalidations: 0, staleResponses: 0,
    peakQueuedJobs: 0, lastQueueWaitMs: 0, lastJobMs: 0, lastWorkerMs: 0,
    totalWorkerMs: 0, lastResponseBytes: 0
  };

  constructor(private readonly options: DocsWorkerClientOptions = {}) {}

  request<T>(settings: DocsWorkerSettings, method: DocsWorkerMethod, args: unknown[]): Promise<T> {
    this.metrics.requests += 1;
    try {
      if (this.disposed) throw new Error("Docs service is disposed.");
      if (Date.now() < this.restartAfter) throw new Error("Docs worker is cooling down after a failure.");
      if (this.queue.length >= DOCS_WORKER_LIMITS.maxQueuedJobs) throw new Error("Docs worker queue is full.");
      const request = { id: ++this.nextId, settings, method, args };
      validateDocsRequest(request);
      // Only bounded request data is cloned; callers may mutate their options after enqueueing.
      const snapshot = deserialize(serialize(request)) as DocsWorkerRequest;
      return new Promise<T>((resolve, reject) => {
        const job: Job = {
          request: snapshot,
          enqueuedAt: performance.now(),
          resolve: (result) => resolve(result as T),
          reject,
          timer: setTimeout(() => this.timeout(job), this.options.timeoutMs ?? DOCS_WORKER_LIMITS.timeoutMs)
        };
        this.queue.push(job);
        this.pump();
        this.metrics.peakQueuedJobs = Math.max(this.metrics.peakQueuedJobs, this.queue.length);
      });
    } catch (error) {
      this.metrics.rejected += 1;
      return Promise.reject(error);
    }
  }

  invalidate(): void {
    this.metrics.invalidations += 1;
    // A generation-wide reset also cancels queued requests and responses already in transit.
    this.cancelAll(new Error("Docs request invalidated."));
    this.retire();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll(new Error("Docs service is disposed."));
    this.retire();
  }

  getMetrics() {
    return {
      ...this.metrics,
      ...this.cacheMetrics,
      workerRunning: Boolean(this.worker || this.retiring),
      activeJobs: this.active ? 1 : 0,
      queuedJobs: this.queue.length,
      disposed: this.disposed
    };
  }

  private pump(): void {
    if (this.disposed || this.active || this.retiring || !this.queue.length) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const job = this.queue.shift()!;
    this.active = job;
    this.metrics.lastQueueWaitMs = performance.now() - job.enqueuedAt;
    try {
      if (!this.worker) {
        const filename = path.join(__dirname, "docsRetrievalWorker.js");
        const options: WorkerOptions = {
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: DOCS_WORKER_LIMITS.maxOldGenerationSizeMb, stackSizeMb: 4 }
        };
        const worker = this.options.workerFactory?.(filename, options) ?? new Worker(filename, options);
        this.worker = worker;
        this.metrics.workerStarts += 1;
        if (this.metrics.workerStarts > 1) this.metrics.restarts += 1;
        worker.on("message", (message: DocsWorkerResponse) => this.receive(worker, message));
        worker.on("messageerror", () => this.fail(worker, new Error("Docs worker message could not be decoded.")));
        worker.on("error", (error) => this.fail(worker, error));
        worker.on("exit", (code) => this.fail(worker, new Error(`Docs worker exited (${code}).`)));
      }
      this.worker.ref();
      this.worker.postMessage(job.request);
    } catch (error) {
      this.fail(this.worker, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(worker: Worker, message: DocsWorkerResponse): void {
    if (worker !== this.worker || !this.active || message?.id !== this.active.request.id) {
      this.metrics.staleResponses += 1;
      return;
    }
    if (!Number.isFinite(message.responseBytes) || message.responseBytes > DOCS_WORKER_LIMITS.maxResponseBytes
      || !message.metrics || !Number.isFinite(message.elapsedMs)) {
      this.fail(worker, new Error("Invalid docs worker response."));
      return;
    }
    const job = this.active;
    this.active = undefined;
    clearTimeout(job.timer);
    this.metrics.lastJobMs = performance.now() - job.enqueuedAt;
    this.metrics.lastWorkerMs = message.elapsedMs;
    this.metrics.totalWorkerMs += message.elapsedMs;
    this.metrics.lastResponseBytes = message.responseBytes;
    this.cacheMetrics = message.metrics;
    if (message.error) {
      this.metrics.failed += 1;
      job.reject(new Error(message.error));
    } else {
      this.metrics.completed += 1;
      job.resolve(message.result);
    }
    if (this.queue.length) {
      this.pump();
    } else {
      worker.unref();
      this.idleTimer = setTimeout(() => this.retire(), this.options.idleMs ?? DOCS_WORKER_LIMITS.idleMs);
      this.idleTimer.unref();
    }
  }

  private timeout(job: Job): void {
    const error = new Error("Docs worker request timed out.");
    this.metrics.timeouts += 1;
    if (this.active === job) {
      this.restartAfter = Date.now() + (this.options.restartDelayMs ?? DOCS_WORKER_LIMITS.restartDelayMs);
      this.cancelAll(error);
      this.retire();
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.metrics.failed += 1;
      job.reject(error);
    }
  }

  private fail(worker: Worker | undefined, error: Error): void {
    if (worker !== this.worker) return;
    this.metrics.crashes += 1;
    this.restartAfter = Date.now() + (this.options.restartDelayMs ?? DOCS_WORKER_LIMITS.restartDelayMs);
    this.cancelAll(error);
    this.retire();
  }

  private cancelAll(error: Error): void {
    const jobs = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    for (const job of jobs) {
      clearTimeout(job.timer);
      this.metrics.failed += 1;
      job.reject(error);
    }
  }

  private retire(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    this.cacheMetrics = { ...EMPTY_CACHE_METRICS };
    if (!worker) return;
    // Never overlap a replacement worker with a still-terminating generation.
    this.retiring = worker.terminate().then(() => undefined, () => undefined).finally(() => {
      this.retiring = undefined;
      this.pump();
    });
  }
}

export type DocsWorkerMetrics = ReturnType<DocsWorkerClient["getMetrics"]>;

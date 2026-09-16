"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsWorkerClient = void 0;
const path = __importStar(require("path"));
const node_perf_hooks_1 = require("node:perf_hooks");
const node_v8_1 = require("node:v8");
const worker_threads_1 = require("worker_threads");
const docsWorkerProtocol_1 = require("./docsWorkerProtocol");
const EMPTY_CACHE_METRICS = {
    cacheHits: 0, cacheMisses: 0, evictions: 0, loads: 0, lastLoadMs: 0,
    cacheRoots: 0, cachedFragments: 0, cachedChars: 0
};
class DocsWorkerClient {
    constructor(options = {}) {
        this.options = options;
        this.queue = [];
        this.disposed = false;
        this.nextId = 0;
        this.restartAfter = 0;
        this.cacheMetrics = { ...EMPTY_CACHE_METRICS };
        this.metrics = {
            requests: 0, completed: 0, failed: 0, rejected: 0, timeouts: 0, crashes: 0,
            workerStarts: 0, restarts: 0, invalidations: 0, staleResponses: 0,
            peakQueuedJobs: 0, lastQueueWaitMs: 0, lastJobMs: 0, lastWorkerMs: 0,
            totalWorkerMs: 0, lastResponseBytes: 0
        };
    }
    request(settings, method, args) {
        this.metrics.requests += 1;
        try {
            if (this.disposed)
                throw new Error("Docs service is disposed.");
            if (Date.now() < this.restartAfter)
                throw new Error("Docs worker is cooling down after a failure.");
            if (this.queue.length >= docsWorkerProtocol_1.DOCS_WORKER_LIMITS.maxQueuedJobs)
                throw new Error("Docs worker queue is full.");
            const request = { id: ++this.nextId, settings, method, args };
            (0, docsWorkerProtocol_1.validateDocsRequest)(request);
            // Only bounded request data is cloned; callers may mutate their options after enqueueing.
            const snapshot = (0, node_v8_1.deserialize)((0, node_v8_1.serialize)(request));
            return new Promise((resolve, reject) => {
                const job = {
                    request: snapshot,
                    enqueuedAt: node_perf_hooks_1.performance.now(),
                    resolve: (result) => resolve(result),
                    reject,
                    timer: setTimeout(() => this.timeout(job), this.options.timeoutMs ?? docsWorkerProtocol_1.DOCS_WORKER_LIMITS.timeoutMs)
                };
                this.queue.push(job);
                this.pump();
                this.metrics.peakQueuedJobs = Math.max(this.metrics.peakQueuedJobs, this.queue.length);
            });
        }
        catch (error) {
            this.metrics.rejected += 1;
            return Promise.reject(error);
        }
    }
    invalidate() {
        this.metrics.invalidations += 1;
        // A generation-wide reset also cancels queued requests and responses already in transit.
        this.cancelAll(new Error("Docs request invalidated."));
        this.retire();
    }
    dispose() {
        if (this.disposed)
            return;
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
    pump() {
        if (this.disposed || this.active || this.retiring || !this.queue.length)
            return;
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        const job = this.queue.shift();
        this.active = job;
        this.metrics.lastQueueWaitMs = node_perf_hooks_1.performance.now() - job.enqueuedAt;
        try {
            if (!this.worker) {
                const filename = path.join(__dirname, "docsRetrievalWorker.js");
                const options = {
                    execArgv: [],
                    resourceLimits: { maxOldGenerationSizeMb: docsWorkerProtocol_1.DOCS_WORKER_LIMITS.maxOldGenerationSizeMb, stackSizeMb: 4 }
                };
                const worker = this.options.workerFactory?.(filename, options) ?? new worker_threads_1.Worker(filename, options);
                this.worker = worker;
                this.metrics.workerStarts += 1;
                if (this.metrics.workerStarts > 1)
                    this.metrics.restarts += 1;
                worker.on("message", (message) => this.receive(worker, message));
                worker.on("messageerror", () => this.fail(worker, new Error("Docs worker message could not be decoded.")));
                worker.on("error", (error) => this.fail(worker, error));
                worker.on("exit", (code) => this.fail(worker, new Error(`Docs worker exited (${code}).`)));
            }
            this.worker.ref();
            this.worker.postMessage(job.request);
        }
        catch (error) {
            this.fail(this.worker, error instanceof Error ? error : new Error(String(error)));
        }
    }
    receive(worker, message) {
        if (worker !== this.worker || !this.active || message?.id !== this.active.request.id) {
            this.metrics.staleResponses += 1;
            return;
        }
        if (!Number.isFinite(message.responseBytes) || message.responseBytes > docsWorkerProtocol_1.DOCS_WORKER_LIMITS.maxResponseBytes
            || !message.metrics || !Number.isFinite(message.elapsedMs)) {
            this.fail(worker, new Error("Invalid docs worker response."));
            return;
        }
        const job = this.active;
        this.active = undefined;
        clearTimeout(job.timer);
        this.metrics.lastJobMs = node_perf_hooks_1.performance.now() - job.enqueuedAt;
        this.metrics.lastWorkerMs = message.elapsedMs;
        this.metrics.totalWorkerMs += message.elapsedMs;
        this.metrics.lastResponseBytes = message.responseBytes;
        this.cacheMetrics = message.metrics;
        if (message.error) {
            this.metrics.failed += 1;
            job.reject(new Error(message.error));
        }
        else {
            this.metrics.completed += 1;
            job.resolve(message.result);
        }
        if (this.queue.length) {
            this.pump();
        }
        else {
            worker.unref();
            this.idleTimer = setTimeout(() => this.retire(), this.options.idleMs ?? docsWorkerProtocol_1.DOCS_WORKER_LIMITS.idleMs);
            this.idleTimer.unref();
        }
    }
    timeout(job) {
        const error = new Error("Docs worker request timed out.");
        this.metrics.timeouts += 1;
        if (this.active === job) {
            this.restartAfter = Date.now() + (this.options.restartDelayMs ?? docsWorkerProtocol_1.DOCS_WORKER_LIMITS.restartDelayMs);
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
    fail(worker, error) {
        if (worker !== this.worker)
            return;
        this.metrics.crashes += 1;
        this.restartAfter = Date.now() + (this.options.restartDelayMs ?? docsWorkerProtocol_1.DOCS_WORKER_LIMITS.restartDelayMs);
        this.cancelAll(error);
        this.retire();
    }
    cancelAll(error) {
        const jobs = this.active ? [this.active, ...this.queue] : [...this.queue];
        this.active = undefined;
        this.queue.length = 0;
        for (const job of jobs) {
            clearTimeout(job.timer);
            this.metrics.failed += 1;
            job.reject(error);
        }
    }
    retire() {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        const worker = this.worker;
        this.worker = undefined;
        this.cacheMetrics = { ...EMPTY_CACHE_METRICS };
        if (!worker)
            return;
        // Never overlap a replacement worker with a still-terminating generation.
        this.retiring = worker.terminate().then(() => undefined, () => undefined).finally(() => {
            this.retiring = undefined;
            this.pump();
        });
    }
}
exports.DocsWorkerClient = DocsWorkerClient;
//# sourceMappingURL=docsWorkerClient.js.map
import { disposeRenderer, renderCodeInnerHtml } from "./engine";
import { checkCodeBudget, LIMITS, normalizeLanguage, PROTOCOL_VERSION } from "./protocol";
import type { HighlightResponse, SupportedLanguage } from "./protocol";

declare const __XBSL_WORKER_SOURCE__: string;

export interface HighlightOptions {
  blockId: string;
  version: number;
}

interface Subscriber {
  blockId?: string;
  token?: number;
  resolve: (html: string) => void;
  reject: (error: Error) => void;
}

interface Job {
  id: number;
  key: string;
  code: string;
  language: SupportedLanguage;
  bytes: number;
  subscribers: Set<Subscriber>;
}

function abortError(): Error {
  const error = new Error("Highlight request superseded or disposed");
  error.name = "AbortError";
  return error;
}

function createHighlighter() {
  const cache = new Map<string, { html: string; bytes: number }>();
  const jobs = new Map<string, Job>();
  const versions = new Map<string, { version: number; token: number }>();
  const queue: Job[] = [];
  let cacheBytes = 0;
  let pendingBytes = 0;
  let sequence = 0;
  let mode: "idle" | "worker" | "fallback" | "disposed" = "idle";
  let worker: Worker | undefined;
  let blobUrl: string | undefined;
  let active: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lastStarted = -Infinity;
  let workerJobs = 0;
  let fallbackJobs = 0;
  let staleResults = 0;
  let evictions = 0;

  const isCurrent = (subscriber: Subscriber): boolean => !subscriber.blockId
    || versions.get(subscriber.blockId)?.token === subscriber.token;

  function revokeBlob(): void {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = undefined;
    }
  }

  function stopWorker(): void {
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    revokeBlob();
    clearTimeout(watchdog);
    watchdog = undefined;
  }

  function failWorker(): void {
    stopWorker();
    if (mode === "disposed") return;
    mode = "fallback";
    if (active) {
      if (active.subscribers.size) queue.unshift(active);
      else removeJob(active);
    }
    active = undefined;
    schedule();
  }

  function startWorker(): void {
    try {
      blobUrl = URL.createObjectURL(new Blob([__XBSL_WORKER_SOURCE__], { type: "text/javascript" }));
      worker = new Worker(blobUrl, { name: "codex-xbsl-highlighter" });
      worker.onmessage = ({ data }: MessageEvent<HighlightResponse>) => {
        if (!data || data.protocol !== PROTOCOL_VERSION) {
          failWorker();
          return;
        }
        if (data.ready) {
          revokeBlob();
          return;
        }
        if (!active || data.id !== active.id) return;
        const job = active;
        active = undefined;
        clearTimeout(watchdog);
        watchdog = undefined;
        finish(job, data.html, data.error ? new Error(data.error) : undefined);
        schedule();
      };
      worker.onerror = worker.onmessageerror = () => failWorker();
      mode = "worker";
    } catch {
      failWorker();
    }
  }

  function removeJob(job: Job): void {
    if (jobs.get(job.key) === job) {
      jobs.delete(job.key);
      pendingBytes -= job.bytes;
    }
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
  }

  function finish(job: Job, html?: string, error?: Error): void {
    removeJob(job);
    if (mode === "disposed") return;
    if (typeof html !== "string" || html.length * 2 > LIMITS.outputBytes) {
      error ??= new RangeError("Highlight result is missing or exceeds output budget");
    }
    let delivered = false;
    for (const subscriber of job.subscribers) {
      if (!isCurrent(subscriber)) {
        staleResults += 1;
        subscriber.reject(abortError());
      } else if (error) {
        subscriber.reject(error);
      } else {
        delivered = true;
        subscriber.resolve(html!);
      }
    }
    job.subscribers.clear();
    if (!delivered || error) return;
    const bytes = 2 * (job.key.length + html!.length) + 128;
    if (bytes > LIMITS.cacheBytes) return;
    while (cache.size >= LIMITS.cacheEntries || cacheBytes + bytes > LIMITS.cacheBytes) {
      const key = cache.keys().next().value as string;
      cacheBytes -= cache.get(key)!.bytes;
      cache.delete(key);
      evictions += 1;
    }
    cache.set(job.key, { html: html!, bytes });
    cacheBytes += bytes;
  }

  function schedule(): void {
    if (timer !== undefined || active || mode === "disposed" || !queue.length) return;
    const interval = mode === "fallback" ? LIMITS.fallbackIntervalMs : LIMITS.workerIntervalMs;
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, Math.max(0, interval - (performance.now() - lastStarted)));
  }

  async function pump(): Promise<void> {
    if (active || mode === "disposed") return;
    if (mode === "idle") startWorker();
    const job = queue.shift();
    if (!job) return;
    active = job;
    lastStarted = performance.now();
    if (worker) {
      workerJobs += 1;
      watchdog = setTimeout(failWorker, LIMITS.workerTimeoutMs);
      try {
        worker.postMessage({ protocol: PROTOCOL_VERSION, id: job.id, code: job.code, language: job.language });
      } catch {
        failWorker();
      }
      return;
    }
    try {
      checkCodeBudget(job.code, true);
      fallbackJobs += 1;
      const html = await renderCodeInnerHtml(job.code, job.language);
      finish(job, html);
    } catch (error) {
      finish(job, undefined, error instanceof Error ? error : new Error(String(error)));
    } finally {
      active = undefined;
      schedule();
    }
  }

  function cancelSubscribers(blockId: string): void {
    for (const job of jobs.values()) {
      for (const subscriber of job.subscribers) {
        if (subscriber.blockId === blockId) {
          job.subscribers.delete(subscriber);
          subscriber.reject(abortError());
          staleResults += 1;
        }
      }
      if (!job.subscribers.size && active !== job) removeJob(job);
    }
  }

  function cancel(blockId: string): void {
    versions.delete(blockId);
    cancelSubscribers(blockId);
  }

  function highlight(code: string, requestedLanguage: string, options?: HighlightOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (mode === "disposed") throw abortError();
      const language = normalizeLanguage(requestedLanguage);
      if (!language) throw new Error(`Unsupported highlight language: ${requestedLanguage}`);
      const token = ++sequence;
      if (options) {
        if (typeof options.blockId !== "string" || !options.blockId || options.blockId.length > 256
          || !Number.isSafeInteger(options.version) || options.version < 0) {
          throw new TypeError("Highlight requires a bounded blockId and nonnegative integer version");
        }
        const previous = versions.get(options.blockId);
        if (previous && previous.version > options.version) throw abortError();
        cancelSubscribers(options.blockId);
        versions.delete(options.blockId);
        versions.set(options.blockId, { version: options.version, token });
        while (versions.size > LIMITS.trackedBlocks) cancel(versions.keys().next().value as string);
      }
      const source = String(code || "");
      checkCodeBudget(source);
      const normalizedCode = source.replace(/\r\n/g, "\n");
      const key = `${language}\u0000${normalizedCode}`;
      const subscriber = { resolve, reject, blockId: options?.blockId, token };
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        // A cached promise must also reject when superseded before delivery.
        queueMicrotask(() => isCurrent(subscriber) && mode !== "disposed" ? resolve(cached.html) : reject(abortError()));
        return;
      }
      let job = jobs.get(key);
      if (!job) {
        const bytes = 2 * (key.length + normalizedCode.length) + 256;
        if (jobs.size >= LIMITS.pendingJobs || pendingBytes + bytes > LIMITS.pendingBytes) {
          throw new RangeError("Highlight queue budget exceeded; keep the plain-text rendering");
        }
        job = { id: token, code: normalizedCode, key, language, bytes, subscribers: new Set() };
        jobs.set(key, job);
        queue.push(job);
        pendingBytes += bytes;
      }
      if (job.subscribers.size >= LIMITS.trackedBlocks) throw new RangeError("Too many highlight subscribers");
      job.subscribers.add(subscriber);
      schedule();
    });
  }

  function dispose(): void {
    if (mode === "disposed") return;
    mode = "disposed";
    clearTimeout(timer);
    timer = undefined;
    stopWorker();
    for (const job of jobs.values()) {
      for (const subscriber of job.subscribers) subscriber.reject(abortError());
      job.subscribers.clear();
    }
    active = undefined;
    queue.length = 0;
    jobs.clear();
    cache.clear();
    versions.clear();
    pendingBytes = cacheBytes = 0;
    disposeRenderer();
    window.removeEventListener?.("pagehide", onPageHide);
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) dispose();
  }
  window.addEventListener?.("pagehide", onPageHide);
  return {
    highlight, cancel, dispose,
    supports: (language: string) => normalizeLanguage(language) !== null,
    getStats: () => ({ mode, cacheBytes, cacheEntries: cache.size, pendingBytes, pendingJobs: jobs.size,
      trackedBlocks: versions.size, workerJobs, fallbackJobs, staleResults, evictions, limits: LIMITS }),
  };
}

export type CodexXbslHighlighter = ReturnType<typeof createHighlighter>;

// Inline bootstrap and a late external preload share exactly one worker/cache.
if (!window.codexXbslHighlighter) {
  window.codexXbslHighlighter = createHighlighter();
  if (typeof window.dispatchEvent === "function" && typeof window.Event === "function") {
    window.dispatchEvent(new window.Event("codex-xbsl-highlighter-ready"));
  }
}

declare global {
  interface Window {
    codexXbslHighlighter: CodexXbslHighlighter;
  }
}

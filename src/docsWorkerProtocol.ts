import type { DocsSearchEngine } from "./docsSearchEngine";

export const DOCS_WORKER_LIMITS = {
  maxCacheRoots: 4,
  maxFragments: 60_000,
  maxChars: 64_000_000,
  maxCorpora: 128,
  maxFiles: 512,
  maxInputBytes: 128_000_000,
  maxRecordChars: 1_000_000,
  maxRequestChars: 128_000,
  maxResponseBytes: 1_048_576,
  maxQueuedJobs: 8,
  timeoutMs: 30_000,
  restartDelayMs: 1_000,
  idleMs: 60_000,
  maxOldGenerationSizeMb: 384
} as const;

export class DocsCapacityError extends Error {}

export type DocsWorkerMethod = "buildContext" | "buildExplicitPathContext" | "buildPlannerInput"
  | "buildContextFromPlan" | "searchTool" | "readTool" | "overviewTool";

export interface DocsWorkerSettings {
  normalizedPath: string;
  sourcePath: string;
  configRoot: string;
  cwd: string;
  serverDocs: string;
}

export interface DocsWorkerRequest {
  id: number;
  settings: DocsWorkerSettings;
  method: DocsWorkerMethod;
  args: unknown[];
}

export type DocsWorkerCacheMetrics = ReturnType<DocsSearchEngine["getMetrics"]>;

export interface DocsWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
  elapsedMs: number;
  responseBytes: number;
  metrics: DocsWorkerCacheMetrics;
}

export function validateDocsRequest(value: unknown): void {
  let chars = 0;
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 1024 || depth > 8) throw new DocsCapacityError("Docs request is too complex.");
    if (typeof item === "string") chars += item.length;
    if (chars > DOCS_WORKER_LIMITS.maxRequestChars) throw new DocsCapacityError("Docs request is too large.");
    if (Array.isArray(item)) {
      if (item.length > 128) throw new DocsCapacityError("Too many docs request items.");
      for (const child of item) visit(child, depth + 1);
    } else if (item && typeof item === "object") {
      const keys = Object.keys(item);
      if (keys.length > 32) throw new DocsCapacityError("Too many docs request fields.");
      for (const key of keys) {
        visit(key, depth + 1);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    } else if (item !== undefined && item !== null && typeof item !== "number" && typeof item !== "boolean" && typeof item !== "string") {
      throw new DocsCapacityError("Unsupported docs request value.");
    }
  };
  visit(value, 0);
}

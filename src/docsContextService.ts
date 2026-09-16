import type { Logger } from "./logger";
import { performance } from "node:perf_hooks";
import type { DocsSettingsView, SettingsService } from "./settingsService";
import type { DocsContextDetails } from "./types";
import { formatDocsMetadataContext } from "./docsSearchEngine";
import type {
  DocsSearchEngine,
  DocsContextResult,
  DocsPlannerInput,
  DocsRetrievalPlan,
  DocsToolOverviewResult,
  DocsToolReadResult,
  DocsToolSearchResult
} from "./docsSearchEngine";
import { DocsWorkerClient, DocsWorkerClientOptions, DocsWorkerMetrics } from "./docsWorkerClient";
import type { DocsWorkerMethod, DocsWorkerSettings } from "./docsWorkerProtocol";

export type {
  DocsContextResult, DocsPlannerInput, DocsPlannerRootSummary, DocsPlannerCorpusMap,
  DocsRetrievalPlan, DocsToolFragmentRef, DocsToolOverviewResult, DocsToolReadResult,
  DocsToolRootSummary, DocsToolSearchResult
} from "./docsSearchEngine";
export { getDocsCorpusDiscoveryForPath } from "./docsSearchEngine";
export type { DocsWorkerMetrics } from "./docsWorkerClient";

export type DocsContextMetrics = DocsWorkerMetrics & {
  metadataCalls: number;
  lastMetadataMs: number;
  totalMetadataMs: number;
};

export interface DocsContextServiceOptions {
  // Integration can supply a cheap paths-only settings accessor, bypassing the
  // legacy SettingsService getter's synchronous validation/discovery side effect.
  getDocsSettingsSnapshot?: () => Pick<DocsSettingsView, "normalizedPath" | "sourcePath">;
  getDocsMetadataSnapshot?: () => DocsContextDetails;
  worker?: DocsWorkerClientOptions;
}

export class DocsContextService {
  private readonly worker: DocsWorkerClient;
  private settingsKey: string | undefined;
  private revision = 0;
  private lastWarningAt = 0;
  private readonly metadataMetrics = { metadataCalls: 0, lastMetadataMs: 0, totalMetadataMs: 0 };

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly options: DocsContextServiceOptions = {}
  ) {
    this.worker = new DocsWorkerClient(options.worker);
  }

  buildContext(prompt: string): Promise<DocsContextResult | undefined> {
    return this.request("buildContext", [prompt]);
  }

  buildExplicitPathContext(prompt: string, workspaceRoot: string): Promise<DocsContextResult | undefined> {
    return this.request("buildExplicitPathContext", [prompt, workspaceRoot]);
  }

  buildPlannerInput(): Promise<DocsPlannerInput | undefined> {
    return this.request("buildPlannerInput", []);
  }

  buildContextFromPlan(prompt: string, plan: DocsRetrievalPlan): Promise<DocsContextResult | undefined> {
    return this.request("buildContextFromPlan", [prompt, plan]);
  }

  async buildMetadataContext(): Promise<DocsContextResult> {
    const started = performance.now();
    try {
      const details = this.options.getDocsMetadataSnapshot?.() ?? this.settings.getDocsContextDetails();
      const roots = details.allowedRoots ?? [];
      const configuredRoots = roots.filter((root) => root.status === "configured");
      return {
        text: formatDocsMetadataContext(details),
        sourcePath: details.normalizedPath || details.sourcePath || roots.map((root) => root.path).join(";"),
        matchCount: configuredRoots.length || roots.length,
        mode: "metadata"
      };
    } finally {
      this.metadataMetrics.metadataCalls += 1;
      this.metadataMetrics.lastMetadataMs = performance.now() - started;
      this.metadataMetrics.totalMetadataMs += this.metadataMetrics.lastMetadataMs;
    }
  }

  searchTool(query: string, options: NonNullable<Parameters<DocsSearchEngine["searchTool"]>[1]> = {}): Promise<DocsToolSearchResult | undefined> {
    return this.request("searchTool", [query, options]);
  }

  readTool(options: Parameters<DocsSearchEngine["readTool"]>[0]): Promise<DocsToolReadResult | undefined> {
    return this.request("readTool", [options]);
  }

  overviewTool(options: NonNullable<Parameters<DocsSearchEngine["overviewTool"]>[0]> = {}): Promise<DocsToolOverviewResult | undefined> {
    return this.request("overviewTool", [options]);
  }

  invalidate(_root?: string): void {
    // Root invalidation conservatively drops the whole bounded worker generation.
    this.revision += 1;
    this.worker.invalidate();
  }

  dispose(): void {
    this.revision += 1;
    this.worker.dispose();
  }

  getMetrics(): DocsContextMetrics {
    return { ...this.worker.getMetrics(), ...this.metadataMetrics };
  }

  private snapshot(): DocsWorkerSettings {
    const docs = this.options.getDocsSettingsSnapshot?.() ?? this.settings.getDocsSettingsView();
    return {
      normalizedPath: docs.normalizedPath,
      sourcePath: docs.sourcePath,
      configRoot: this.settings.getConfigRoot(),
      cwd: process.cwd(),
      serverDocs: process.env.CODEX_ELEMENT_SERVER_DOCS ?? ""
    };
  }

  private async request<T>(method: DocsWorkerMethod, args: unknown[]): Promise<T | undefined> {
    try {
      const explicit = method === "buildExplicitPathContext";
      const snapshot = explicit
        ? { normalizedPath: "", sourcePath: "", configRoot: "", cwd: process.cwd(), serverDocs: "" }
        : this.snapshot();
      const key = JSON.stringify(snapshot);
      if (!explicit) {
        if (this.settingsKey !== undefined && this.settingsKey !== key) this.invalidate();
        this.settingsKey = key;
      }
      const revision = this.revision;
      const result = await this.worker.request<T>(snapshot, method, args);
      if (this.revision !== revision) return undefined;
      if (!explicit && JSON.stringify(this.snapshot()) !== key) {
        this.invalidate();
        return undefined;
      }
      return result;
    } catch (error) {
      // Overload/failure bursts must not turn into another host logging hot path.
      if (Date.now() - this.lastWarningAt >= 5000) {
        this.lastWarningAt = Date.now();
        this.logger.warn(`Docs retrieval skipped: ${(error instanceof Error ? error.message : String(error)).slice(0, 512)}`);
      }
      return undefined;
    }
  }
}

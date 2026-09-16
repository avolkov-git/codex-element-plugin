"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsContextService = exports.getDocsCorpusDiscoveryForPath = void 0;
const node_perf_hooks_1 = require("node:perf_hooks");
const docsSearchEngine_1 = require("./docsSearchEngine");
const docsWorkerClient_1 = require("./docsWorkerClient");
var docsSearchEngine_2 = require("./docsSearchEngine");
Object.defineProperty(exports, "getDocsCorpusDiscoveryForPath", { enumerable: true, get: function () { return docsSearchEngine_2.getDocsCorpusDiscoveryForPath; } });
class DocsContextService {
    constructor(settings, logger, options = {}) {
        this.settings = settings;
        this.logger = logger;
        this.options = options;
        this.revision = 0;
        this.lastWarningAt = 0;
        this.metadataMetrics = { metadataCalls: 0, lastMetadataMs: 0, totalMetadataMs: 0 };
        this.worker = new docsWorkerClient_1.DocsWorkerClient(options.worker);
    }
    buildContext(prompt) {
        return this.request("buildContext", [prompt]);
    }
    buildExplicitPathContext(prompt, workspaceRoot) {
        return this.request("buildExplicitPathContext", [prompt, workspaceRoot]);
    }
    buildPlannerInput() {
        return this.request("buildPlannerInput", []);
    }
    buildContextFromPlan(prompt, plan) {
        return this.request("buildContextFromPlan", [prompt, plan]);
    }
    async buildMetadataContext() {
        const started = node_perf_hooks_1.performance.now();
        try {
            const details = this.options.getDocsMetadataSnapshot?.() ?? this.settings.getDocsContextDetails();
            const roots = details.allowedRoots ?? [];
            const configuredRoots = roots.filter((root) => root.status === "configured");
            return {
                text: (0, docsSearchEngine_1.formatDocsMetadataContext)(details),
                sourcePath: details.normalizedPath || details.sourcePath || roots.map((root) => root.path).join(";"),
                matchCount: configuredRoots.length || roots.length,
                mode: "metadata"
            };
        }
        finally {
            this.metadataMetrics.metadataCalls += 1;
            this.metadataMetrics.lastMetadataMs = node_perf_hooks_1.performance.now() - started;
            this.metadataMetrics.totalMetadataMs += this.metadataMetrics.lastMetadataMs;
        }
    }
    searchTool(query, options = {}) {
        return this.request("searchTool", [query, options]);
    }
    readTool(options) {
        return this.request("readTool", [options]);
    }
    overviewTool(options = {}) {
        return this.request("overviewTool", [options]);
    }
    invalidate(_root) {
        // Root invalidation conservatively drops the whole bounded worker generation.
        this.revision += 1;
        this.worker.invalidate();
    }
    dispose() {
        this.revision += 1;
        this.worker.dispose();
    }
    getMetrics() {
        return { ...this.worker.getMetrics(), ...this.metadataMetrics };
    }
    snapshot() {
        const docs = this.options.getDocsSettingsSnapshot?.() ?? this.settings.getDocsSettingsView();
        return {
            normalizedPath: docs.normalizedPath,
            sourcePath: docs.sourcePath,
            configRoot: this.settings.getConfigRoot(),
            cwd: process.cwd(),
            serverDocs: process.env.CODEX_ELEMENT_SERVER_DOCS ?? ""
        };
    }
    async request(method, args) {
        try {
            const explicit = method === "buildExplicitPathContext";
            const snapshot = explicit
                ? { normalizedPath: "", sourcePath: "", configRoot: "", cwd: process.cwd(), serverDocs: "" }
                : this.snapshot();
            const key = JSON.stringify(snapshot);
            if (!explicit) {
                if (this.settingsKey !== undefined && this.settingsKey !== key)
                    this.invalidate();
                this.settingsKey = key;
            }
            const revision = this.revision;
            const result = await this.worker.request(snapshot, method, args);
            if (this.revision !== revision)
                return undefined;
            if (!explicit && JSON.stringify(this.snapshot()) !== key) {
                this.invalidate();
                return undefined;
            }
            return result;
        }
        catch (error) {
            // Overload/failure bursts must not turn into another host logging hot path.
            if (Date.now() - this.lastWarningAt >= 5000) {
                this.lastWarningAt = Date.now();
                this.logger.warn(`Docs retrieval skipped: ${(error instanceof Error ? error.message : String(error)).slice(0, 512)}`);
            }
            return undefined;
        }
    }
}
exports.DocsContextService = DocsContextService;
//# sourceMappingURL=docsContextService.js.map
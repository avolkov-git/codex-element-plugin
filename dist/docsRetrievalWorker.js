"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const node_perf_hooks_1 = require("node:perf_hooks");
const docsSearchEngine_1 = require("./docsSearchEngine");
const docsWorkerProtocol_1 = require("./docsWorkerProtocol");
if (worker_threads_1.isMainThread || !worker_threads_1.parentPort)
    throw new Error("Docs retrieval must run in a worker thread.");
const port = worker_threads_1.parentPort;
let busy = false;
let engine;
let settingsKey = "";
port.on("message", async (request) => {
    // The host sends one job at a time; do not create an unbounded async worker queue.
    if (busy)
        throw new Error("Concurrent docs worker jobs are not supported.");
    busy = true;
    const started = node_perf_hooks_1.performance.now();
    const response = {
        id: request.id, elapsedMs: 0, responseBytes: 0,
        metrics: { cacheHits: 0, cacheMisses: 0, evictions: 0, loads: 0, lastLoadMs: 0, cacheRoots: 0, cachedFragments: 0, cachedChars: 0 }
    };
    try {
        (0, docsWorkerProtocol_1.validateDocsRequest)(request);
        const key = JSON.stringify(request.settings);
        if (!engine || settingsKey !== key) {
            const settings = request.settings;
            engine = new docsSearchEngine_1.DocsSearchEngine({
                getDocsSettingsView: () => ({ ...settings, validationMessage: "" }),
                getConfigRoot: () => settings.configRoot
            }, { info() { }, warn() { } }, { cwd: settings.cwd, serverDocs: settings.serverDocs });
            settingsKey = key;
        }
        engine.beginRequest();
        switch (request.method) {
            case "buildContext":
                response.result = await engine.buildContext(...request.args);
                break;
            case "buildExplicitPathContext":
                response.result = await engine.buildExplicitPathContext(...request.args);
                break;
            case "buildPlannerInput":
                response.result = await engine.buildPlannerInput();
                break;
            case "buildContextFromPlan":
                response.result = await engine.buildContextFromPlan(...request.args);
                break;
            case "searchTool":
                response.result = await engine.searchTool(...request.args);
                break;
            case "readTool":
                response.result = await engine.readTool(...request.args);
                break;
            case "overviewTool":
                response.result = await engine.overviewTool(...request.args);
                break;
            default: throw new Error("Unknown docs worker method.");
        }
        engine.assertFresh();
        // Bound metadata fields too, not just fragment count and preview length.
        if (Buffer.byteLength(JSON.stringify(response.result) ?? "") > docsWorkerProtocol_1.DOCS_WORKER_LIMITS.maxResponseBytes - 2048) {
            throw new Error("Docs result exceeds the response budget.");
        }
    }
    catch (error) {
        response.result = undefined;
        response.error = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    }
    finally {
        response.metrics = engine?.getMetrics() ?? response.metrics;
        response.elapsedMs = node_perf_hooks_1.performance.now() - started;
        response.responseBytes = Buffer.byteLength(JSON.stringify(response));
        busy = false;
        port.postMessage(response);
    }
});
//# sourceMappingURL=docsRetrievalWorker.js.map
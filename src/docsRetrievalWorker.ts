import { isMainThread, parentPort } from "worker_threads";
import { performance } from "node:perf_hooks";
import { DocsSearchEngine } from "./docsSearchEngine";
import { DOCS_WORKER_LIMITS, DocsWorkerRequest, DocsWorkerResponse, validateDocsRequest } from "./docsWorkerProtocol";

if (isMainThread || !parentPort) throw new Error("Docs retrieval must run in a worker thread.");
const port = parentPort;
let busy = false;
let engine: DocsSearchEngine | undefined;
let settingsKey = "";

port.on("message", async (request: DocsWorkerRequest) => {
  // The host sends one job at a time; do not create an unbounded async worker queue.
  if (busy) throw new Error("Concurrent docs worker jobs are not supported.");
  busy = true;
  const started = performance.now();
  const response: DocsWorkerResponse = {
    id: request.id, elapsedMs: 0, responseBytes: 0,
    metrics: { cacheHits: 0, cacheMisses: 0, evictions: 0, loads: 0, lastLoadMs: 0, cacheRoots: 0, cachedFragments: 0, cachedChars: 0 }
  };
  try {
    validateDocsRequest(request);
    const key = JSON.stringify(request.settings);
    if (!engine || settingsKey !== key) {
      const settings = request.settings;
      engine = new DocsSearchEngine({
        getDocsSettingsView: () => ({ ...settings, validationMessage: "" }),
        getConfigRoot: () => settings.configRoot
      }, { info() {}, warn() {} }, { cwd: settings.cwd, serverDocs: settings.serverDocs });
      settingsKey = key;
    }
    engine.beginRequest();
    switch (request.method) {
      case "buildContext": response.result = await engine.buildContext(...request.args as Parameters<DocsSearchEngine["buildContext"]>); break;
      case "buildExplicitPathContext": response.result = await engine.buildExplicitPathContext(...request.args as Parameters<DocsSearchEngine["buildExplicitPathContext"]>); break;
      case "buildPlannerInput": response.result = await engine.buildPlannerInput(); break;
      case "buildContextFromPlan": response.result = await engine.buildContextFromPlan(...request.args as Parameters<DocsSearchEngine["buildContextFromPlan"]>); break;
      case "searchTool": response.result = await engine.searchTool(...request.args as Parameters<DocsSearchEngine["searchTool"]>); break;
      case "readTool": response.result = await engine.readTool(...request.args as Parameters<DocsSearchEngine["readTool"]>); break;
      case "overviewTool": response.result = await engine.overviewTool(...request.args as Parameters<DocsSearchEngine["overviewTool"]>); break;
      default: throw new Error("Unknown docs worker method.");
    }
    engine.assertFresh();
    // Bound metadata fields too, not just fragment count and preview length.
    if (Buffer.byteLength(JSON.stringify(response.result) ?? "") > DOCS_WORKER_LIMITS.maxResponseBytes - 2048) {
      throw new Error("Docs result exceeds the response budget.");
    }
  } catch (error) {
    response.result = undefined;
    response.error = (error instanceof Error ? error.message : String(error)).slice(0, 512);
  } finally {
    response.metrics = engine?.getMetrics() ?? response.metrics;
    response.elapsedMs = performance.now() - started;
    response.responseBytes = Buffer.byteLength(JSON.stringify(response));
    busy = false;
    port.postMessage(response);
  }
});

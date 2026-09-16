const { parentPort, workerData } = require("node:worker_threads");

async function main() {
  const { DocsContextService } = require(workerData.modulePath);
  const settings = {
    getDocsSettingsView: () => ({ ...workerData.paths, validationMessage: "" }),
    getConfigRoot: () => workerData.configRoot,
    getDocsContextDetails: () => workerData.metadata
  };
  const service = new DocsContextService(settings, { info() {}, warn() {} });
  try {
    const results = [];
    for (const [method, args] of workerData.actions) results.push(await service[method](...args));
    parentPort.postMessage({ results });
  } finally {
    service.dispose?.();
  }
}

main().catch(error => parentPort.postMessage({ error: error.stack }));

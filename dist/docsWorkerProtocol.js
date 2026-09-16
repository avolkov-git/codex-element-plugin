"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsCapacityError = exports.DOCS_WORKER_LIMITS = void 0;
exports.validateDocsRequest = validateDocsRequest;
exports.DOCS_WORKER_LIMITS = {
    maxCacheRoots: 4,
    maxFragments: 60000,
    maxChars: 64000000,
    maxCorpora: 128,
    maxFiles: 512,
    maxInputBytes: 128000000,
    maxRecordChars: 1000000,
    maxRequestChars: 128000,
    maxResponseBytes: 1048576,
    maxQueuedJobs: 8,
    timeoutMs: 30000,
    restartDelayMs: 1000,
    idleMs: 60000,
    maxOldGenerationSizeMb: 384
};
class DocsCapacityError extends Error {
}
exports.DocsCapacityError = DocsCapacityError;
function validateDocsRequest(value) {
    let chars = 0;
    let nodes = 0;
    const visit = (item, depth) => {
        if (++nodes > 1024 || depth > 8)
            throw new DocsCapacityError("Docs request is too complex.");
        if (typeof item === "string")
            chars += item.length;
        if (chars > exports.DOCS_WORKER_LIMITS.maxRequestChars)
            throw new DocsCapacityError("Docs request is too large.");
        if (Array.isArray(item)) {
            if (item.length > 128)
                throw new DocsCapacityError("Too many docs request items.");
            for (const child of item)
                visit(child, depth + 1);
        }
        else if (item && typeof item === "object") {
            const keys = Object.keys(item);
            if (keys.length > 32)
                throw new DocsCapacityError("Too many docs request fields.");
            for (const key of keys) {
                visit(key, depth + 1);
                visit(item[key], depth + 1);
            }
        }
        else if (item !== undefined && item !== null && typeof item !== "number" && typeof item !== "boolean" && typeof item !== "string") {
            throw new DocsCapacityError("Unsupported docs request value.");
        }
    };
    visit(value, 0);
}
//# sourceMappingURL=docsWorkerProtocol.js.map
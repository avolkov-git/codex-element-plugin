"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectToolsService = void 0;
const contextTools_1 = require("./contextTools");
const projectContextService_1 = require("./projectContextService");
const PROJECT_SOURCE = "project";
const DEFAULT_SEARCH_ITEMS = 8;
const DEFAULT_SYMBOL_ITEMS = 60;
const DEFAULT_READ_CHARS = 16000;
const DEFAULT_BLOCK_CHARS = 20000;
class ProjectToolsService {
    constructor(projectContext, logger, getProfileId) {
        this.projectContext = projectContext;
        this.logger = logger;
        this.getProfileId = getProfileId;
    }
    async search(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "project.search",
            source: PROJECT_SOURCE,
            args: { query: options.query },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: {
                workspaceOnly: true,
                allowUnsavedEditorText: false
            }
        }));
    }
    async readFile(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "project.readFile",
            source: PROJECT_SOURCE,
            args: {
                path: options.path,
                startLine: options.startLine,
                endLine: options.endLine
            },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: {
                workspaceOnly: true,
                allowUnsavedEditorText: true
            }
        }));
    }
    async listSymbols(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "project.listSymbols",
            source: PROJECT_SOURCE,
            args: {
                query: options.query,
                path: options.path
            },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: {
                workspaceOnly: true,
                allowUnsavedEditorText: false
            }
        }));
    }
    async execute(request) {
        const startedAt = Date.now();
        const result = await this.executeUnsafe(request).catch((error) => {
            if (error instanceof projectContextService_1.ProjectToolError) {
                return (0, contextTools_1.createContextToolFailure)(request, {
                    code: error.code,
                    message: error.message,
                    retryable: error.code === "unavailable"
                });
            }
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "internalError",
                message: error instanceof Error ? error.message : String(error),
                retryable: false
            });
        });
        const roots = getMetadataStringArray(result.metadata.roots);
        const ledger = (0, contextTools_1.createContextToolLedgerEntry)({
            request,
            result,
            startedAt,
            roots,
            metadata: result.metadata
        });
        this.logger.info(`Project tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; chars=${ledger.chars}; roots=${ledger.roots.length}; elapsed=${ledger.elapsedMs}ms.`);
        return result;
    }
    async executeUnsafe(request) {
        if (request.toolName === "project.search") {
            return this.executeSearch(request);
        }
        if (request.toolName === "project.readFile") {
            return this.executeReadFile(request);
        }
        if (request.toolName === "project.listSymbols") {
            return this.executeListSymbols(request);
        }
        return (0, contextTools_1.createContextToolFailure)(request, {
            code: "unsupported",
            message: `Unsupported project tool: ${request.toolName}`,
            retryable: false
        });
    }
    async executeSearch(request) {
        const query = normalizeString(request.args.query);
        if (!query) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "invalidRequest",
                message: "project.search requires a non-empty query.",
                retryable: false
            });
        }
        const search = await this.projectContext.searchTool(this.getProfileId(), query, {
            maxItems: request.limits.maxItems ?? DEFAULT_SEARCH_ITEMS,
            maxPreviewChars: 420
        });
        if (!search.chunks.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound",
                message: "No project chunks matched the query.",
                retryable: true
            }, [], metadataFromSearch(search));
        }
        const text = trimToolBlock(formatSearchBlock(search), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: PROJECT_SOURCE,
                text,
                matchCount: search.chunks.length,
                mode: "matched",
                score: search.chunks[0]?.score,
                metadata: {
                    query,
                    totalFiles: search.totalFiles,
                    totalChunks: search.totalChunks,
                    truncated: text.endsWith("…")
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: search.workspaceRoot,
                    path: search.chunks.map((chunk) => chunk.path).join(";"),
                    score: search.chunks[0]?.score
                }
            }], metadataFromSearch(search));
    }
    async executeReadFile(request) {
        const filePath = normalizeString(request.args.path);
        if (!filePath) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "invalidRequest",
                message: "project.readFile requires a non-empty path.",
                retryable: false
            });
        }
        const file = await this.projectContext.readFileTool(this.getProfileId(), {
            filePath,
            startLine: asOptionalNumber(request.args.startLine),
            endLine: asOptionalNumber(request.args.endLine),
            maxChars: request.limits.maxChars ?? DEFAULT_READ_CHARS,
            maxBytes: request.limits.maxBytes
        });
        const text = trimToolBlock(formatReadFileBlock(file), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: PROJECT_SOURCE,
                text,
                matchCount: 1,
                mode: "matched",
                metadata: {
                    path: file.path,
                    language: file.language,
                    startLine: file.startLine,
                    endLine: file.endLine,
                    fromOpenDocument: file.fromOpenDocument,
                    truncated: text.endsWith("…") || file.truncated
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: file.workspaceRoot,
                    path: file.path,
                    title: file.path
                }
            }], metadataFromReadFile(file));
    }
    async executeListSymbols(request) {
        const symbols = await this.projectContext.listSymbolsTool(this.getProfileId(), {
            query: normalizeString(request.args.query),
            filePath: normalizeString(request.args.path),
            maxItems: request.limits.maxItems ?? DEFAULT_SYMBOL_ITEMS
        });
        if (!symbols.symbols.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound",
                message: "No project symbols matched the request.",
                retryable: true
            }, [], metadataFromSymbols(symbols));
        }
        const text = trimToolBlock(formatSymbolsBlock(symbols), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: PROJECT_SOURCE,
                text,
                matchCount: symbols.symbols.length,
                mode: "matched",
                score: symbols.symbols[0]?.score,
                metadata: {
                    query: symbols.query,
                    path: symbols.path,
                    totalFiles: symbols.totalFiles,
                    totalChunks: symbols.totalChunks,
                    truncated: text.endsWith("…")
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: symbols.workspaceRoot,
                    path: symbols.path,
                    score: symbols.symbols[0]?.score
                }
            }], metadataFromSymbols(symbols));
    }
}
exports.ProjectToolsService = ProjectToolsService;
function formatSearchBlock(search) {
    return [
        "[PROJECT TOOL: search]",
        `Query: ${search.query}`,
        `Workspace: ${search.workspaceRoot}`,
        `Index: v2, files=${search.totalFiles}, chunks=${search.totalChunks}, updated=${search.updatedAt}`,
        "Use these candidates only as an index. Call project.readFile for exact file content before relying on details outside the preview.",
        "",
        ...search.chunks.map((chunk, index) => formatChunkRef(index + 1, chunk))
    ].join("\n");
}
function formatReadFileBlock(file) {
    return [
        "[PROJECT TOOL: readFile]",
        `File: ${file.path}:${file.startLine}-${file.endLine}`,
        `Language: ${file.language}`,
        `Workspace: ${file.workspaceRoot}`,
        file.fromOpenDocument ? "Source: open editor document, includes unsaved changes." : "Source: workspace file on disk.",
        file.truncated ? "Note: file content was truncated by tool limits." : "",
        "Use this bounded file content as authoritative for the current answer. Do not mention this service block unless the user asks about sources.",
        "",
        file.text
    ].filter(Boolean).join("\n");
}
function formatSymbolsBlock(result) {
    return [
        "[PROJECT TOOL: listSymbols]",
        result.query ? `Query: ${result.query}` : "",
        result.path ? `Path: ${result.path}` : "",
        `Workspace: ${result.workspaceRoot}`,
        `Index: v2, files=${result.totalFiles}, chunks=${result.totalChunks}, updated=${result.updatedAt}`,
        "",
        ...result.symbols.map((symbol, index) => [
            `${index + 1}. ${symbol.name}`,
            `   path: ${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
            `   language: ${symbol.language}`,
            `   score: ${Math.round(symbol.score)}`,
            symbol.preview ? `   preview: ${symbol.preview}` : ""
        ].filter(Boolean).join("\n"))
    ].filter(Boolean).join("\n");
}
function formatChunkRef(index, chunk) {
    return [
        `${index}. ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
        `   id: ${chunk.chunkId}`,
        `   language: ${chunk.language}`,
        chunk.symbols.length ? `   symbols: ${chunk.symbols.join(", ")}` : "",
        chunk.keywords.length ? `   keywords: ${chunk.keywords.join(", ")}` : "",
        `   score: ${Math.round(chunk.score)}`,
        chunk.preview ? `   preview: ${chunk.preview}` : ""
    ].filter(Boolean).join("\n");
}
function metadataFromSearch(search) {
    return {
        roots: [search.workspaceRoot],
        indexPath: search.indexPath,
        updatedAt: search.updatedAt,
        query: search.query,
        files: search.totalFiles,
        chunks: search.totalChunks,
        selectedChunks: search.chunks.length,
        paths: unique(search.chunks.map((chunk) => chunk.path))
    };
}
function metadataFromReadFile(file) {
    return {
        roots: [file.workspaceRoot],
        path: file.path,
        language: file.language,
        size: file.size,
        startLine: file.startLine,
        endLine: file.endLine,
        totalLines: file.totalLines,
        fromOpenDocument: file.fromOpenDocument,
        truncated: file.truncated
    };
}
function metadataFromSymbols(result) {
    return {
        roots: [result.workspaceRoot],
        indexPath: result.indexPath,
        updatedAt: result.updatedAt,
        query: result.query,
        path: result.path,
        files: result.totalFiles,
        chunks: result.totalChunks,
        symbols: result.symbols.length,
        paths: unique(result.symbols.map((symbol) => symbol.path))
    };
}
function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function asOptionalNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function trimToolBlock(value, maxChars) {
    const limit = Math.max(1000, Math.min(30000, Math.floor(maxChars)));
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
function unique(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const key = value.trim();
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(key);
    }
    return result;
}
function getMetadataStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
//# sourceMappingURL=projectToolsService.js.map
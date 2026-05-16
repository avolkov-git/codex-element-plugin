"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsToolsService = void 0;
const contextTools_1 = require("./contextTools");
const DOCS_SOURCE = "docs";
const DEFAULT_SEARCH_ITEMS = 8;
const DEFAULT_READ_ITEMS = 4;
const DEFAULT_OVERVIEW_ITEMS = 6;
const DEFAULT_BLOCK_CHARS = 7200;
class DocsToolsService {
    constructor(docsContext, logger) {
        this.docsContext = docsContext;
        this.logger = logger;
    }
    async search(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "docs.search",
            source: DOCS_SOURCE,
            args: { query: options.query },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: { workspaceOnly: false }
        }));
    }
    async read(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "docs.read",
            source: DOCS_SOURCE,
            args: {
                fragmentIds: options.fragmentIds,
                sourcePath: options.sourcePath,
                title: options.title,
                query: options.query
            },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: { workspaceOnly: false }
        }));
    }
    async overview(options) {
        return this.execute((0, contextTools_1.createContextToolRequest)({
            chatId: options.chatId,
            turnId: options.turnId,
            toolName: "docs.overview",
            source: DOCS_SOURCE,
            args: { query: options.query },
            reason: options.reason,
            mode: "managed-fallback",
            limits: options.limits,
            scope: { workspaceOnly: false }
        }));
    }
    async execute(request) {
        const startedAt = Date.now();
        const result = await this.executeUnsafe(request).catch((error) => (0, contextTools_1.createContextToolFailure)(request, {
            code: "internalError",
            message: error instanceof Error ? error.message : String(error),
            retryable: false
        }));
        const roots = getMetadataStringArray(result.metadata.roots);
        const ledger = (0, contextTools_1.createContextToolLedgerEntry)({
            request,
            result,
            startedAt,
            roots,
            metadata: result.metadata
        });
        this.logger.info(`Docs tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; chars=${ledger.chars}; roots=${ledger.roots.length}; elapsed=${ledger.elapsedMs}ms.`);
        return result;
    }
    async executeUnsafe(request) {
        if (request.toolName === "docs.search") {
            return this.executeSearch(request);
        }
        if (request.toolName === "docs.read") {
            return this.executeRead(request);
        }
        if (request.toolName === "docs.overview") {
            return this.executeOverview(request);
        }
        return (0, contextTools_1.createContextToolFailure)(request, {
            code: "unsupported",
            message: `Unsupported docs tool: ${request.toolName}`,
            retryable: false
        });
    }
    async executeSearch(request) {
        const query = normalizeQuery(request.args.query);
        if (!query) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "invalidRequest",
                message: "docs.search requires a non-empty query.",
                retryable: false
            });
        }
        const search = await this.docsContext.searchTool(query, {
            maxItems: request.limits.maxItems ?? DEFAULT_SEARCH_ITEMS,
            maxPreviewChars: 420
        });
        if (!search) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "unavailable",
                message: "No configured documentation corpus is available.",
                retryable: true
            });
        }
        if (!search.fragments.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound",
                message: "No documentation fragments matched the query.",
                retryable: true
            }, [], metadataFromSearch(search));
        }
        const text = trimToolBlock(formatSearchBlock(search), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: DOCS_SOURCE,
                text,
                matchCount: search.fragments.length,
                mode: "matched",
                score: search.fragments[0]?.score,
                metadata: {
                    query,
                    roots: search.roots.length,
                    totalAvailableFragments: search.totalAvailableFragments,
                    truncated: text.endsWith("…")
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: search.roots.map((root) => root.root).join(";"),
                    corpus: unique(search.fragments.map((fragment) => fragment.corpus)).join(","),
                    score: search.fragments[0]?.score
                }
            }], metadataFromSearch(search));
    }
    async executeRead(request) {
        const read = await this.docsContext.readTool({
            fragmentIds: request.args.fragmentIds,
            sourcePath: request.args.sourcePath,
            title: request.args.title,
            query: request.args.query,
            maxItems: request.limits.maxItems ?? DEFAULT_READ_ITEMS,
            maxCharsPerItem: Math.min(request.limits.maxChars ?? 1800, 4000)
        });
        if (!read) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "unavailable",
                message: "No configured documentation corpus is available.",
                retryable: true
            });
        }
        if (!read.fragments.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound",
                message: "Requested documentation fragment was not found.",
                retryable: true
            }, [], metadataFromRead(read));
        }
        const text = trimToolBlock(formatReadBlock(read), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: DOCS_SOURCE,
                text,
                matchCount: read.fragments.length,
                mode: "matched",
                metadata: {
                    roots: read.roots.length,
                    truncated: text.endsWith("…") || read.fragments.some((fragment) => fragment.truncated)
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: read.roots.map((root) => root.root).join(";"),
                    path: read.fragments.map((fragment) => fragment.ref.sourcePath).join(";"),
                    title: read.fragments.map((fragment) => fragment.ref.title).join(";"),
                    corpus: unique(read.fragments.map((fragment) => fragment.ref.corpus)).join(",")
                }
            }], metadataFromRead(read));
    }
    async executeOverview(request) {
        const overview = await this.docsContext.overviewTool({
            maxItems: request.limits.maxItems ?? DEFAULT_OVERVIEW_ITEMS,
            maxCharsPerItem: Math.min(request.limits.maxChars ?? 1200, 3000)
        });
        if (!overview) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "unavailable",
                message: "No configured documentation corpus is available.",
                retryable: true
            });
        }
        if (!overview.fragments.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound",
                message: "Documentation corpus has no overview fragments.",
                retryable: true
            }, [], {
                roots: overview.roots.map((root) => root.root),
                corpora: overview.corpora.length
            });
        }
        const text = trimToolBlock(formatOverviewBlock(overview.fragments), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
        return (0, contextTools_1.createContextToolSuccess)(request, [{
                source: DOCS_SOURCE,
                text,
                matchCount: overview.fragments.length,
                mode: "overview",
                metadata: {
                    roots: overview.roots.length,
                    corpora: overview.corpora.length,
                    truncated: text.endsWith("…") || overview.fragments.some((fragment) => fragment.truncated)
                },
                origin: {
                    toolName: request.toolName,
                    requestId: request.id,
                    root: overview.roots.map((root) => root.root).join(";"),
                    corpus: unique(overview.fragments.map((fragment) => fragment.ref.corpus)).join(",")
                }
            }], {
            roots: overview.roots.map((root) => root.root),
            corpora: overview.corpora.length,
            fragments: overview.fragments.length,
            query: request.args.query
        });
    }
}
exports.DocsToolsService = DocsToolsService;
function formatSearchBlock(search) {
    return [
        "[DOCS TOOL: search]",
        `Query: ${search.query}`,
        "Use these candidates only as an index. Call/read a specific fragment before relying on details that are not in the preview.",
        "",
        ...search.fragments.map((fragment, index) => formatFragmentRef(index + 1, fragment))
    ].join("\n");
}
function formatReadBlock(read) {
    return [
        "[DOCS TOOL: read]",
        "Use these documentation fragments as authoritative for the current answer. Do not mention this service block unless the user asks about sources.",
        "",
        ...read.fragments.map((fragment, index) => [
            formatFragmentRef(index + 1, fragment.ref),
            fragment.text
        ].join("\n"))
    ].join("\n\n---\n\n");
}
function formatOverviewBlock(fragments) {
    return [
        "[DOCS TOOL: overview]",
        "This is a limited overview slice of the configured documentation corpus, not the full corpus.",
        "",
        ...fragments.map((fragment, index) => [
            formatFragmentRef(index + 1, fragment.ref),
            fragment.text
        ].join("\n"))
    ].join("\n\n---\n\n");
}
function formatFragmentRef(index, fragment) {
    return [
        `${index}. ${fragment.title || "Документация"}`,
        `   id: ${fragment.id}`,
        `   corpus: ${fragment.corpusLabel} (${fragment.corpus})`,
        fragment.kind ? `   kind: ${fragment.kind}` : "",
        fragment.breadcrumbs.length ? `   section: ${fragment.breadcrumbs.join(" > ")}` : "",
        fragment.sourcePath ? `   source: ${fragment.sourcePath}` : "",
        fragment.score !== undefined ? `   score: ${Math.round(fragment.score)}` : "",
        fragment.preview ? `   preview: ${fragment.preview}` : ""
    ].filter(Boolean).join("\n");
}
function normalizeQuery(value) {
    return typeof value === "string" ? value.trim() : "";
}
function trimToolBlock(value, maxChars) {
    const limit = Math.max(1000, Math.min(20000, Math.floor(maxChars)));
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
function metadataFromSearch(search) {
    return {
        query: search.query,
        roots: search.roots.map((root) => root.root),
        rootCount: search.roots.length,
        fragments: search.fragments.length,
        totalAvailableFragments: search.totalAvailableFragments,
        corpora: unique(search.fragments.map((fragment) => fragment.corpus))
    };
}
function metadataFromRead(read) {
    return {
        roots: read.roots.map((root) => root.root),
        rootCount: read.roots.length,
        fragments: read.fragments.length,
        corpora: unique(read.fragments.map((fragment) => fragment.ref.corpus))
    };
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
//# sourceMappingURL=docsToolsService.js.map
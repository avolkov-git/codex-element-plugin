"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsToolsService = void 0;
const contextTools_1 = require("./contextTools");
const documentationCompatibility_1 = require("./documentationCompatibility");
const DOCS_SOURCE = "docs";
const DEFAULT_SEARCH_ITEMS = 8;
const DEFAULT_READ_ITEMS = 4;
const DEFAULT_OVERVIEW_ITEMS = 6;
const DEFAULT_BLOCK_CHARS = 7200;
const SYMBOL_READ_CHARS = 7000;
const MAX_SYMBOLS = 3;
const SYMBOL_IDENTIFIER = "[\\p{L}_][\\p{L}\\p{N}\\p{M}_]*";
const QUALIFIED_SYMBOL = `${SYMBOL_IDENTIFIER}(?:(?:::|\\.)${SYMBOL_IDENTIFIER})*`;
const SYMBOL_PATTERN = new RegExp(`^${QUALIFIED_SYMBOL}$`, "u");
const TITLE_SYMBOL_PATTERN = new RegExp('^["`«]?(' + QUALIFIED_SYMBOL + ')(?=$|[^\\p{L}\\p{N}\\p{M}_:.])', "u");
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
                query: options.query,
                symbolNames: options.symbolNames,
                expectedPlatformVersion: options.expectedPlatformVersion,
                fragmentBlocks: options.fragmentBlocks
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
            args: { query: options.query, expectedPlatformVersion: options.expectedPlatformVersion, fragmentBlocks: options.fragmentBlocks },
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
        const hasExplicitSelection = request.args.fragmentIds?.some(id => id.trim())
            || normalizeQuery(request.args.sourcePath) || normalizeQuery(request.args.title);
        if (request.args.symbolNames !== undefined && !hasExplicitSelection) {
            return this.executeReadSymbols(request);
        }
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
        return createDocsReadResult(request, read, {}, boundedLimit(request.limits.maxChars, DEFAULT_BLOCK_CHARS, 20000));
    }
    async executeReadSymbols(request) {
        const symbolNames = normalizeSymbolNames(request.args.symbolNames);
        if (!symbolNames.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "invalidRequest", message: "Не указаны корректные имена символов документации.", retryable: false
            });
        }
        const selected = new Map();
        const roots = new Set();
        const unavailableSymbols = [];
        const candidates = new Map();
        const expectedPlatformVersion = (0, documentationCompatibility_1.normalizePlatformVersion)(request.args.expectedPlatformVersion);
        const compatibility = (ref) => (0, documentationCompatibility_1.compareDocumentationVersion)(ref.id, expectedPlatformVersion, ref.documentationVersion);
        const maxItems = boundedLimit(request.limits.maxItems, MAX_SYMBOLS, MAX_SYMBOLS);
        for (const symbol of symbolNames) {
            const search = await this.docsContext.searchTool(symbol, { maxItems: 12, maxPreviewChars: 120 });
            if (!search) {
                unavailableSymbols.push(symbol);
                continue;
            }
            search.roots.forEach(root => roots.add(root.root));
            candidates.set(symbol, search.fragments.slice(0, 12).filter(fragment => titleMatchesSymbol(fragment.title, symbol)));
        }
        for (const [symbol, exact] of candidates) {
            const preferred = exact.sort((a, b) => (0, documentationCompatibility_1.documentationVersionRank)(compatibility(b)) - (0, documentationCompatibility_1.documentationVersionRank)(compatibility(a)))[0];
            if (preferred && selected.size < maxItems)
                selected.set(preferred.id, symbol);
        }
        const metadata = {
            roots: [...roots], requestedSymbols: symbolNames, unavailableSymbols,
            titleMatch: "exact-identifier", versionCompatibility: "unverified",
            ...(expectedPlatformVersion ? { expectedPlatformVersion } : {}),
            versionSelectionScope: "retrieved-exact-candidates",
            documentationVersions: []
        };
        if (!selected.size) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: unavailableSymbols.length ? "unavailable" : "notFound",
                message: "Точные заголовки документации для выбранных символов не найдены. Похожие названия не подставлены.",
                retryable: true
            }, [], { ...metadata, matchedSymbols: [], unmatchedSymbols: symbolNames });
        }
        const maxChars = boundedLimit(request.limits.maxChars, SYMBOL_READ_CHARS, SYMBOL_READ_CHARS);
        const read = await this.docsContext.readTool({
            fragmentIds: [...selected.keys()], maxItems: selected.size,
            maxCharsPerItem: Math.max(1, Math.min(4000, Math.floor(maxChars / selected.size)))
        });
        if (!read) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "unavailable", message: "Не удалось прочитать выбранные фрагменты документации.", retryable: true
            }, [], { ...metadata, matchedSymbols: [], unmatchedSymbols: symbolNames });
        }
        // Recheck IDs and titles after reading: a changed corpus must not introduce a fuzzy replacement.
        const fragments = read.fragments.filter(fragment => {
            const symbol = selected.get(fragment.ref.id);
            return symbol !== undefined && titleMatchesSymbol(fragment.ref.title, symbol);
        }).slice(0, maxItems);
        const matchedSymbols = unique(fragments.map(fragment => selected.get(fragment.ref.id)));
        const resultMetadata = {
            ...metadata, ...metadataFromRead({ ...read, fragments }), matchedSymbols,
            unmatchedSymbols: symbolNames.filter(symbol => !matchedSymbols.includes(symbol))
        };
        if (!fragments.length) {
            return (0, contextTools_1.createContextToolFailure)(request, {
                code: "notFound", message: "Выбранные точные фрагменты документации больше не доступны.", retryable: true
            }, [], resultMetadata);
        }
        return createDocsReadResult(request, { ...read, fragments }, resultMetadata, maxChars);
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
        return createDocsReadResult(request, overview, { query: request.args.query }, boundedLimit(request.limits.maxChars, DEFAULT_BLOCK_CHARS, 20000));
    }
}
exports.DocsToolsService = DocsToolsService;
function createDocsReadResult(request, read, metadata, maxChars) {
    const expectedPlatformVersion = (0, documentationCompatibility_1.normalizePlatformVersion)(request.args.expectedPlatformVersion);
    const checksFor = (fragments) => fragments.map(fragment => (0, documentationCompatibility_1.compareDocumentationVersion)(fragment.ref.id, expectedPlatformVersion, fragment.ref.documentationVersion));
    const versionsFor = (fragments) => {
        const checks = checksFor(fragments);
        return {
            ...(expectedPlatformVersion ? { expectedPlatformVersion } : {}),
            versionCompatibility: (0, documentationCompatibility_1.summarizeDocumentationVersions)(checks),
            // Flat evidence survives the context-tool metadata depth limit.
            documentationVersions: checks.map(({ evidence, ...check }) => Object.fromEntries(Object.entries({ ...check, ...evidence }).filter(([, value]) => value !== undefined)))
        };
    };
    const groups = request.args.fragmentBlocks ? read.fragments.map(fragment => [fragment]) : [read.fragments];
    const formattedBlocks = groups.map(fragments => {
        const versionMetadata = versionsFor(fragments);
        const matchedSymbols = getMetadataStringArray(metadata.matchedSymbols)
            .filter(symbol => fragments.some(fragment => titleMatchesSymbol(fragment.ref.title, symbol)));
        const introduction = (matchedSymbols.length ? `Точное совпадение идентификаторов заголовков: ${matchedSymbols.join(", ")}. ` : "")
            + `Совместимость версии документации: ${(0, documentationCompatibility_1.documentationVersionLabel)(versionMetadata.versionCompatibility)}. `
            + "Сопоставлены только явные метки версий; совместимость API и соответствие разрешённому типу не проверены. "
            + "Без точного совпадения версий не считайте описанный API подтверждённым для проекта.";
        const overview = request.toolName === "docs.overview";
        const text = formatReadBlock({ ...read, fragments }, introduction, checksFor(fragments).map(documentationCompatibility_1.formatDocumentationVersion), overview);
        return {
            source: DOCS_SOURCE, text, matchCount: fragments.length, mode: overview ? "overview" : "matched",
            metadata: {
                ...metadata, ...metadataFromRead({ ...read, fragments }), ...versionMetadata,
                ...(matchedSymbols.length ? { matchedSymbols } : {}),
                ...(request.args.fragmentBlocks ? {
                    fragmentId: fragments[0].ref.id,
                    fragmentBodyChars: fragments[0].text.length
                } : {}),
                truncated: fragments.some(fragment => fragment.truncated)
            },
            origin: {
                toolName: request.toolName, requestId: request.id, root: read.roots.map(root => root.root).join(";"),
                path: fragments.map(fragment => fragment.ref.sourcePath).join(";"),
                title: fragments.map(fragment => fragment.ref.title).join(";"),
                corpus: unique(fragments.map(fragment => fragment.ref.corpus)).join(",")
            }
        };
    });
    // Satisfy short fragments first so their unused allocation can preserve longer bodies.
    let remaining = maxChars;
    const limits = new Map();
    formattedBlocks.map((block, index) => ({ index, chars: block.text.length }))
        .sort((a, b) => a.chars - b.chars).forEach((block, index) => {
        const limit = Math.min(block.chars, Math.floor(remaining / (formattedBlocks.length - index)));
        limits.set(block.index, limit);
        remaining -= limit;
    });
    const blocks = formattedBlocks.flatMap((block, index) => {
        const limit = limits.get(index) ?? 0;
        if (!limit)
            return [];
        const trimmed = block.text.length > limit;
        const text = trimmed ? `${block.text.slice(0, limit - 1)}…` : block.text;
        return [{ ...block, text, metadata: {
                    ...block.metadata,
                    ...(request.args.fragmentBlocks ? {
                        fragmentBodyChars: Math.max(0, Number(block.metadata.fragmentBodyChars) - (block.text.length - text.length + (trimmed ? 1 : 0)))
                    } : {}),
                    truncated: trimmed || block.metadata.truncated
                } }];
    });
    return (0, contextTools_1.createContextToolSuccess)(request, blocks, { ...metadata, ...metadataFromRead(read), ...versionsFor(read.fragments) });
}
function formatSearchBlock(search) {
    return [
        "[DOCS TOOL: search]",
        `Query: ${search.query}`,
        "Use these candidates only as an index. Call/read a specific fragment before relying on details that are not in the preview.",
        "",
        ...search.fragments.map((fragment, index) => formatFragmentRef(index + 1, fragment))
    ].join("\n");
}
function formatReadBlock(read, introduction, versionNotes, overview = false) {
    return [
        overview ? "[DOCS TOOL: overview]" : "[DOCS TOOL: read]",
        ...(overview ? ["This is a limited overview slice of the configured documentation corpus, not the full corpus."] : []),
        introduction,
        "",
        ...read.fragments.map((fragment, index) => [
            formatFragmentRef(index + 1, fragment.ref),
            ...(versionNotes[index] ? [versionNotes[index]] : []),
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
function normalizeSymbolNames(value) {
    if (!Array.isArray(value))
        return [];
    const names = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== "string")
            continue;
        const name = item.trim().normalize("NFC");
        const key = name.toLowerCase();
        if (!name || name.length > 200 || !SYMBOL_PATTERN.test(name) || seen.has(key))
            continue;
        seen.add(key);
        names.push(name);
        if (names.length === MAX_SYMBOLS)
            break;
    }
    return names;
}
function titleMatchesSymbol(title, symbol) {
    // Compare the declared heading identifier, not parameter names, generic arguments or prose mentions.
    const heading = title.trim().normalize("NFC").replace(/^#{1,6}\s+/u, "")
        .replace(/^(?:тип|класс|интерфейс|структура|перечисление|метод|свойство|пространство им[её]н|компонент интерфейса|type|class|interface component|interface|structure|enum|method|property|namespace)\s*:?\s+(?=[\p{L}_`"«])/iu, "");
    return TITLE_SYMBOL_PATTERN.exec(heading)?.[1].toLowerCase() === symbol.toLowerCase();
}
function boundedLimit(value, fallback, maximum) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
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
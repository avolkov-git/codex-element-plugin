"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManagedContextToolLoopService = void 0;
const contextTools_1 = require("./contextTools");
const documentationCompatibility_1 = require("./documentationCompatibility");
const DOCS_CONTEXT_CHARS = 22000;
const DOCS_CONTEXT_ITEMS = 8;
const DOCS_OVERVIEW_CHARS = 24000;
const PROJECT_CONTEXT_CHARS = 36000;
const PROJECT_CONTEXT_ITEMS = 8;
const PROJECT_SYMBOLS_CHARS = 8000;
const PROJECT_SYMBOLS_ITEMS = 50;
const DIAGNOSTICS_CONTEXT_CHARS = 16000;
class ManagedContextToolLoopService {
    constructor(options) {
        this.options = options;
    }
    async buildContext(request) {
        const outcomes = [];
        const blocks = [];
        // Both documentation paths must use the same project version evidence.
        const search = request.chatKind === "project" && request.routing.shouldUseProjectContext
            ? await this.options.projectTools.search({
                chatId: request.chatId,
                query: request.prompt,
                reason: `managed fallback project search: ${request.routing.reason}`,
                limits: { maxItems: PROJECT_CONTEXT_ITEMS, maxChars: PROJECT_CONTEXT_CHARS }
            }) : undefined;
        const expectedPlatformVersion = search?.ok ? (0, documentationCompatibility_1.normalizePlatformVersion)(search.metadata.platformVersion) : undefined;
        if (search) {
            outcomes.push({ name: search.toolName, route: routeFromResult(search, "added"), result: search });
            blocks.push(...blocksFromResult(search));
        }
        if (!request.hasExplicitDocs && request.routing.shouldUseDocsContext) {
            const result = request.routing.docsMode === "overview"
                ? await this.options.docsTools.overview({
                    chatId: request.chatId,
                    query: request.prompt,
                    expectedPlatformVersion,
                    fragmentBlocks: true,
                    reason: `managed fallback docs overview: ${request.routing.reason}`,
                    limits: {
                        maxItems: DOCS_CONTEXT_ITEMS,
                        maxChars: DOCS_OVERVIEW_CHARS
                    }
                })
                : await this.options.docsTools.read({
                    chatId: request.chatId,
                    query: request.prompt,
                    expectedPlatformVersion,
                    fragmentBlocks: true,
                    reason: `managed fallback docs lookup: ${request.routing.reason}`,
                    limits: {
                        maxItems: DOCS_CONTEXT_ITEMS,
                        maxChars: DOCS_CONTEXT_CHARS
                    }
                });
            const route = routeFromResult(result, request.routing.docsMode === "overview" ? "overview" : "added");
            outcomes.push({ name: result.toolName, route, result });
            blocks.push(...blocksFromResult(result));
        }
        if (request.shouldUseDiagnostics) {
            const result = await this.options.diagnosticsTools.list({
                chatId: request.chatId,
                priority: request.diagnosticsPriority,
                reason: `managed fallback diagnostics: ${request.routing.reason}`,
                limits: {
                    maxChars: DIAGNOSTICS_CONTEXT_CHARS
                }
            });
            const route = routeFromResult(result, "added");
            outcomes.push({ name: result.toolName, route, result });
            blocks.push(...blocksFromResult(result));
        }
        if (search) {
            // Concrete types from YAML/AST complement prompt-only documentation search.
            // They are lookup candidates, not a claim that the installed docs match the runtime version.
            const linkedQueries = search.ok && Array.isArray(search.metadata.documentationQueries)
                ? search.metadata.documentationQueries.filter((query) => typeof query === "string")
                : [];
            if (!request.hasExplicitDocs && request.routing.shouldUseDocsContext && linkedQueries.length) {
                const linkedDocs = await this.options.docsTools.read({
                    chatId: request.chatId,
                    symbolNames: linkedQueries,
                    expectedPlatformVersion,
                    fragmentBlocks: true,
                    reason: "Документация по точным идентификаторам заголовков из YAML/XBSL с проверкой явных меток версии",
                    limits: { maxItems: 3, maxChars: 7000 }
                });
                outcomes.push({ name: linkedDocs.toolName, route: routeFromResult(linkedDocs, "added"), result: linkedDocs });
                appendDocumentationBlocks(blocks, blocksFromResult(linkedDocs));
            }
            const symbols = await this.options.projectTools.listSymbols({
                chatId: request.chatId,
                query: request.prompt,
                reason: `managed fallback project symbols: ${request.routing.reason}`,
                limits: {
                    maxItems: PROJECT_SYMBOLS_ITEMS,
                    maxChars: PROJECT_SYMBOLS_CHARS
                }
            });
            outcomes.push({ name: symbols.toolName, route: routeFromResult(symbols, "added"), result: symbols });
            blocks.push(...blocksFromResult(symbols));
        }
        const docsRoute = coalesceRoute(outcomes, "docs.", "skip");
        const diagnosticsRoute = coalesceRoute(outcomes, "diagnostics.", "skip");
        const projectRoute = coalesceRoute(outcomes, "project.", "skip");
        const chars = blocks.reduce((total, block) => total + block.text.length, 0);
        const toolSummary = outcomes.map((outcome) => `${outcome.name}:${outcome.route}:${blockCount(outcome.result)}`);
        const worklog = outcomes.map(worklogEntryFromOutcome);
        this.options.logger.info(`Managed context fallback loop: route=${request.routing.route}; tools=${toolSummary.length ? toolSummary.join(",") : "none"}; ` +
            `blocks=${blocks.length}; chars=${chars}; docs=${docsRoute}; project=${projectRoute}; diagnostics=${diagnosticsRoute}.`);
        return {
            blocks,
            docsRoute,
            projectRoute,
            diagnosticsRoute,
            tools: toolSummary,
            worklog
        };
    }
}
exports.ManagedContextToolLoopService = ManagedContextToolLoopService;
function appendDocumentationBlocks(blocks, additions) {
    for (const block of additions) {
        const id = block.metadata?.fragmentId;
        const index = typeof id === "string" && id
            ? blocks.findIndex(existing => existing.source === "docs" && existing.metadata?.fragmentId === id) : -1;
        if (index < 0) {
            blocks.push(block);
            continue;
        }
        const previous = blocks[index];
        // Prefer an actual read to an overview summary; among reads retain the longer body.
        const selected = previous.mode === "overview" && block.mode !== "overview" ? block
            : block.mode === "overview" && previous.mode !== "overview" ? previous
                : Number(previous.metadata?.fragmentBodyChars ?? 0) > Number(block.metadata?.fragmentBodyChars ?? 0) ? previous : block;
        const symbolMatch = block.metadata?.titleMatch === "exact-identifier" ? block : previous;
        blocks[index] = {
            ...selected,
            metadata: {
                ...selected.metadata,
                ...(symbolMatch.metadata?.titleMatch === "exact-identifier" ? {
                    titleMatch: symbolMatch.metadata.titleMatch,
                    matchedSymbols: symbolMatch.metadata.matchedSymbols,
                    requestedSymbols: symbolMatch.metadata.requestedSymbols,
                    unmatchedSymbols: symbolMatch.metadata.unmatchedSymbols,
                    versionSelectionScope: symbolMatch.metadata.versionSelectionScope
                } : {})
            }
        };
    }
}
function blocksFromResult(result) {
    const blocks = result.ok ? result.blocks : result.partialBlocks;
    return blocks.map(contextTools_1.toContextBlock);
}
function blockCount(result) {
    return result.ok ? result.blocks.length : result.partialBlocks.length;
}
function worklogEntryFromOutcome(outcome) {
    const stats = statsFromResult(outcome.result);
    return {
        toolName: outcome.name,
        source: outcome.result.source,
        route: outcome.route,
        status: outcome.result.ok ? "ok" : "error",
        itemCount: stats.itemCount,
        blockCount: stats.blockCount,
        chars: stats.chars,
        truncated: stats.truncated
    };
}
function statsFromResult(result) {
    if (result.ok) {
        return result.stats;
    }
    return {
        itemCount: result.partialBlocks.reduce((total, block) => total + block.matchCount, 0),
        blockCount: result.partialBlocks.length,
        chars: result.partialBlocks.reduce((total, block) => total + block.text.length, 0),
        truncated: result.partialBlocks.some((block) => Boolean(block.metadata?.truncated))
    };
}
function routeFromResult(result, successRoute) {
    if (blockCount(result) > 0) {
        return successRoute;
    }
    return result.ok ? "empty" : "error";
}
function coalesceRoute(outcomes, prefix, fallback) {
    const related = outcomes.filter((outcome) => outcome.name.startsWith(prefix));
    if (!related.length) {
        return fallback;
    }
    if (related.some((outcome) => outcome.route === "overview")) {
        return "overview";
    }
    if (related.some((outcome) => outcome.route === "added")) {
        return "added";
    }
    if (related.some((outcome) => outcome.route === "error")) {
        return "error";
    }
    return "empty";
}
//# sourceMappingURL=managedContextToolLoopService.js.map
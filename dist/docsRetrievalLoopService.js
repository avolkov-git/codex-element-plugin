"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsRetrievalLoopService = void 0;
class DocsRetrievalLoopService {
    constructor(docsContext, logger, runPlanner) {
        this.docsContext = docsContext;
        this.logger = logger;
        this.runPlanner = runPlanner;
        this.lastRetrieval = {
            mode: "none",
            queryCount: 0,
            selectedFragments: 0,
            at: ""
        };
    }
    async buildExplicitPathContext(prompt, workspaceRoot) {
        const result = await this.docsContext.buildExplicitPathContext(prompt, workspaceRoot);
        this.record(result ? "deterministic" : "none", 1, result?.matchCount ?? 0);
        return result;
    }
    async buildContext(prompt) {
        const plannerInput = await this.docsContext.buildPlannerInput();
        if (!plannerInput) {
            return this.buildDeterministicContext(prompt, "no-corpus-map", "deterministic");
        }
        try {
            const rawPlan = await this.runPlanner({
                prompt,
                input: plannerInput,
                timeoutMs: 15000
            });
            const plan = parsePlannerPlan(rawPlan);
            const result = await this.docsContext.buildContextFromPlan(prompt, plan);
            if (result) {
                this.record("model-assisted", plan.queries.length, result.matchCount);
                this.logger.info(`Docs retrieval loop: mode=model-assisted, queries=${plan.queries.length}, preferred=${plan.preferredCorpora.join(",") || "-"}, selected=${result.matchCount}, overview=${plan.needOverview}.`);
                return result;
            }
            return this.buildDeterministicContext(prompt, "planner-selected-no-fragments", "fallback");
        }
        catch (error) {
            this.logger.warn(`Docs retrieval planner fallback: ${error instanceof Error ? error.message : String(error)}.`);
            return this.buildDeterministicContext(prompt, "planner-failed", "fallback");
        }
    }
    invalidate(root) {
        this.docsContext.invalidate(root);
        this.record("none", 0, 0);
    }
    decorateDetails(details) {
        return {
            ...details,
            lastRetrievalMode: this.lastRetrieval.mode,
            lastQueryCount: this.lastRetrieval.queryCount,
            lastSelectedFragments: this.lastRetrieval.selectedFragments,
            lastRetrievalAt: this.lastRetrieval.at || undefined
        };
    }
    async buildDeterministicContext(prompt, reason, mode) {
        const result = await this.docsContext.buildContext(prompt);
        this.record(result ? mode : "none", 1, result?.matchCount ?? 0);
        this.logger.info(`Docs retrieval loop: mode=${result ? mode : "none"}, reason=${reason}, selected=${result?.matchCount ?? 0}.`);
        return result;
    }
    record(mode, queryCount, selectedFragments) {
        this.lastRetrieval = {
            mode,
            queryCount,
            selectedFragments,
            at: new Date().toISOString()
        };
    }
}
exports.DocsRetrievalLoopService = DocsRetrievalLoopService;
function parsePlannerPlan(value) {
    const source = extractJsonObject(value);
    const parsed = JSON.parse(source);
    const queries = normalizeStringArray(parsed.queries).slice(0, 10);
    const preferredCorpora = normalizeStringArray(parsed.preferredCorpora).slice(0, 8);
    const targetTitles = normalizeStringArray(parsed.targetTitles).slice(0, 16);
    const needOverview = parsed.needOverview === true;
    if (!needOverview && !queries.length && !targetTitles.length) {
        throw new Error("planner returned no usable queries.");
    }
    return {
        queries,
        preferredCorpora,
        targetTitles,
        needOverview,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : undefined
    };
}
function extractJsonObject(value) {
    const trimmed = value.trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "")
        .trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed;
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1);
    }
    throw new Error("planner did not return JSON.");
}
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
        if (typeof item !== "string") {
            continue;
        }
        const normalized = item.trim();
        if (!normalized) {
            continue;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(normalized);
    }
    return result;
}
//# sourceMappingURL=docsRetrievalLoopService.js.map
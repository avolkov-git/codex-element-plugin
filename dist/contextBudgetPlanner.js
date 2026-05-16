"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyContextBudget = applyContextBudget;
const MAX_SERVICE_CONTEXT_CHARS = 60000;
const MIN_USEFUL_BLOCK_CHARS = 400;
const DEFAULT_SOURCE_PRIORITIES = {
    docs: 110,
    diagnostics: 95,
    project: 85,
    editorSelection: 75,
    editorFile: 72,
    baseRules: 20,
    rules: 15
};
const ROUTE_SOURCE_PRIORITIES = {
    smallTalk: {
        editorSelection: 90,
        editorFile: 85,
        docs: 70,
        project: 60,
        diagnostics: 50,
        baseRules: 5,
        rules: 0
    },
    generalChat: {
        editorSelection: 95,
        editorFile: 90,
        docs: 80,
        project: 55,
        diagnostics: 45,
        baseRules: 10,
        rules: 0
    },
    docsOverview: {
        docs: 135,
        editorSelection: 70,
        editorFile: 68,
        diagnostics: 55,
        project: 50,
        baseRules: 12,
        rules: 8
    },
    docsLookup: {
        docs: 130,
        diagnostics: 85,
        project: 65,
        editorSelection: 72,
        editorFile: 70,
        baseRules: 12,
        rules: 8
    },
    technicalProject: {
        docs: 118,
        diagnostics: 108,
        project: 100,
        editorSelection: 80,
        editorFile: 76,
        baseRules: 12,
        rules: 8
    },
    explicitProject: {
        docs: 118,
        project: 112,
        diagnostics: 106,
        editorSelection: 84,
        editorFile: 80,
        baseRules: 12,
        rules: 8
    },
    projectNoContext: DEFAULT_SOURCE_PRIORITIES
};
function applyContextBudget(blocks, options = {}) {
    const route = normalizeRoute(options.route);
    const totalCharsLimit = Math.max(0, Math.floor(options.totalChars ?? MAX_SERVICE_CONTEXT_CHARS));
    const minUsefulBlockChars = Math.max(0, Math.floor(options.minUsefulBlockChars ?? MIN_USEFUL_BLOCK_CHARS));
    const beforeChars = blocks.reduce((total, block) => total + block.text.length, 0);
    const trimmed = [];
    const dropped = [];
    const decisions = [];
    const sourceStats = new Map();
    const selected = [];
    let remainingTotal = totalCharsLimit;
    const ordered = blocks
        .map((block, index) => ({
        block,
        originalIndex: index,
        priority: getEffectivePriority(block, route),
        score: getFiniteNumber(block.score),
        tokensEstimate: estimateTokens(block)
    }))
        .sort((left, right) => right.priority - left.priority
        || right.score - left.score
        || left.tokensEstimate - right.tokensEstimate
        || left.originalIndex - right.originalIndex);
    for (const item of ordered) {
        const source = item.block.source;
        const stat = sourceStats.get(source) ?? {
            before: 0,
            after: 0,
            beforeBlocks: 0,
            includedBlocks: 0,
            droppedBlocks: 0,
            trimmedBlocks: 0,
            droppedChars: 0,
            trimmedChars: 0,
            beforeTokens: 0,
            afterTokens: 0
        };
        stat.before += item.block.text.length;
        stat.beforeBlocks += 1;
        stat.beforeTokens += estimateTokens(item.block);
        sourceStats.set(source, stat);
        const limit = remainingTotal;
        if (limit <= 0 || limit < minUsefulBlockChars) {
            stat.droppedChars += item.block.text.length;
            stat.droppedBlocks += 1;
            dropped.push(`${source}:${item.block.text.length}`);
            decisions.push(`${source}:dropped chars=${item.block.text.length}, priority=${item.priority}, score=${formatScore(item.score)}, reason=${limit <= 0 ? "budget-exhausted" : "below-min-useful-budget"}`);
            continue;
        }
        if (item.block.text.length <= limit) {
            selected.push({ block: item.block, originalIndex: item.originalIndex });
            remainingTotal -= item.block.text.length;
            stat.after += item.block.text.length;
            stat.afterTokens += estimateTokens(item.block);
            stat.includedBlocks += 1;
            decisions.push(`${source}:included chars=${item.block.text.length}, priority=${item.priority}, score=${formatScore(item.score)}`);
            continue;
        }
        const trimmedText = trimContextBlock(item.block.text, limit);
        const trimmedBlock = {
            ...item.block,
            text: trimmedText,
            tokensEstimate: Math.ceil(trimmedText.length / 4),
            metadata: {
                ...item.block.metadata,
                budgetTrimmedFromChars: item.block.text.length
            }
        };
        selected.push({
            block: trimmedBlock,
            originalIndex: item.originalIndex
        });
        remainingTotal -= trimmedText.length;
        stat.after += trimmedText.length;
        stat.afterTokens += estimateTokens(trimmedBlock);
        stat.trimmedChars += item.block.text.length - trimmedText.length;
        stat.trimmedBlocks += 1;
        trimmed.push(`${source}:${item.block.text.length}->${trimmedText.length}`);
        decisions.push(`${source}:trimmed chars=${item.block.text.length}->${trimmedText.length}, priority=${item.priority}, score=${formatScore(item.score)}, reason=budget-limit`);
    }
    const budgeted = selected
        .sort((left, right) => left.originalIndex - right.originalIndex)
        .map((item) => item.block);
    const sourceReports = [...sourceStats.entries()].map(([source, stat]) => ({
        source,
        beforeChars: stat.before,
        afterChars: stat.after,
        beforeTokens: stat.beforeTokens,
        afterTokens: stat.afterTokens,
        includedBlocks: stat.includedBlocks,
        trimmedBlocks: stat.trimmedBlocks,
        droppedBlocks: stat.droppedBlocks,
        trimmedChars: stat.trimmedChars,
        droppedChars: stat.droppedChars
    }));
    return {
        mode: "ranked-v3",
        route,
        totalCharsLimit,
        blocks: budgeted,
        beforeChars,
        afterChars: budgeted.reduce((total, block) => total + block.text.length, 0),
        trimmed,
        dropped,
        sourceStats: sourceReports.map((stat) => `${stat.source}:${stat.beforeChars}->${stat.afterChars};tokens=${stat.beforeTokens}->${stat.afterTokens};blocks=${stat.includedBlocks}i/${stat.trimmedBlocks}t/${stat.droppedBlocks}d${stat.trimmedChars ? `,trimmed=${stat.trimmedChars}` : ""}${stat.droppedChars ? `,dropped=${stat.droppedChars}` : ""}`),
        decisions,
        sourceReports
    };
}
function getEffectivePriority(block, route) {
    const routePriority = ROUTE_SOURCE_PRIORITIES[route]?.[block.source];
    const sourcePriority = routePriority ?? DEFAULT_SOURCE_PRIORITIES[block.source] ?? 0;
    const explicitPriority = getFiniteNumber(block.priority);
    return explicitPriority === 0 ? sourcePriority : Math.max(sourcePriority, explicitPriority);
}
function normalizeRoute(route) {
    if (route === "smallTalk"
        || route === "generalChat"
        || route === "docsOverview"
        || route === "docsLookup"
        || route === "technicalProject"
        || route === "explicitProject"
        || route === "projectNoContext") {
        return route;
    }
    return "projectNoContext";
}
function getFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function formatScore(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(2);
}
function estimateTokens(block) {
    if (typeof block.tokensEstimate === "number" && Number.isFinite(block.tokensEstimate)) {
        return Math.max(0, Math.ceil(block.tokensEstimate));
    }
    return Math.ceil(block.text.length / 4);
}
function trimContextBlock(text, maxLength) {
    const suffix = "\n\n[...контекст обрезан по бюджету Codex Element...]";
    if (text.length <= maxLength) {
        return text;
    }
    if (maxLength <= suffix.length + 20) {
        return text.slice(0, maxLength);
    }
    return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}
//# sourceMappingURL=contextBudgetPlanner.js.map
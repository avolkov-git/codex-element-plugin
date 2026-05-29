"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextTurnOrchestrator = void 0;
const contextBudgetPlanner_1 = require("./contextBudgetPlanner");
class ContextTurnOrchestrator {
    constructor(options) {
        this.options = options;
    }
    async buildTurnContext(request) {
        const explicitContextBlocks = request.explicitContextBlocks ?? [];
        const routing = this.options.contextRouter.decide(request.prompt, request.chatKind);
        const contextBlocks = [];
        let baseRulesRoute = "skip";
        let projectRoute = "skip";
        let docsRoute = "skip";
        let diagnosticsRoute = "skip";
        let rulesRoute = "skip";
        let toolWorklog = [];
        const docsMetadataRoute = routing.docsMode === "metadata";
        const explicitDocs = docsMetadataRoute
            ? undefined
            : await this.options.docsContext.buildExplicitPathContext(request.prompt, request.cwd);
        if (docsMetadataRoute) {
            const metadataDocs = await this.options.docsContext.buildMetadataContext();
            docsRoute = "metadata";
            contextBlocks.push({
                source: "docs",
                text: metadataDocs.text,
                matchCount: metadataDocs.matchCount,
                mode: "metadata",
                priority: 140,
                metadata: {
                    route: "docsMetadata",
                    sourcePath: metadataDocs.sourcePath
                }
            });
        }
        else if (explicitDocs?.text) {
            docsRoute = explicitDocs.mode === "overview" ? "explicit-overview" : "explicit";
            contextBlocks.push({
                source: "docs",
                text: explicitDocs.text,
                matchCount: explicitDocs.matchCount,
                mode: explicitDocs.mode === "overview" ? "fallback" : "matched"
            });
        }
        else if (!routing.shouldUseDocsContext) {
            this.options.logger.info(`Docs context skipped by router: route=${routing.route}; reason=${routing.reason}.`);
        }
        const hasExplicitDiagnostics = explicitContextBlocks.some((block) => block.source === "diagnostics");
        const shouldUseDiagnostics = request.chatKind === "project"
            && !routing.isSmallTalk
            && !hasExplicitDiagnostics
            && !request.skipAutoDiagnostics
            && (request.forceDiagnosticsContext
                || routing.shouldUseProjectContext
                || this.options.diagnosticsContext.isDiagnosticsRelevantPrompt(request.prompt));
        const diagnosticsPriority = request.diagnosticsPriority
            ?? (request.forceDiagnosticsContext || this.options.diagnosticsContext.isHighPriorityPrompt(request.prompt) ? 115 : 90);
        const shouldUseDocsToolContext = routing.shouldUseDocsContext && !docsMetadataRoute;
        const shouldUseContextTools = shouldUseDocsToolContext
            || routing.shouldUseProjectContext
            || shouldUseDiagnostics;
        const mode = this.selectMode(shouldUseContextTools);
        if (routing.shouldUseProjectContext) {
            this.options.state.setProjectContext({
                status: "indexing",
                label: "Проектный контекст индексируется"
            });
            this.notify(request.chatId);
        }
        if (shouldUseContextTools) {
            const toolContext = await this.buildToolContext({
                chatId: request.chatId,
                prompt: request.prompt,
                chatKind: request.chatKind,
                routing,
                hasExplicitDocs: Boolean(explicitDocs?.text),
                shouldUseDiagnostics,
                diagnosticsPriority,
                mode
            });
            contextBlocks.push(...toolContext.blocks);
            toolWorklog = toolContext.worklog;
            if (!explicitDocs?.text) {
                docsRoute = normalizeDocsRoute(toolContext.docsRoute);
            }
            diagnosticsRoute = normalizeDiagnosticsRoute(toolContext.diagnosticsRoute);
            projectRoute = normalizeProjectRoute(toolContext.projectRoute);
        }
        await this.updateProjectState(request.chatId, request.chatKind, routing.shouldUseProjectContext);
        contextBlocks.push(...explicitContextBlocks);
        const shouldUseSupportDocsContext = routing.shouldUseDocsContext && !docsMetadataRoute;
        const shouldUseSupportContext = request.chatKind === "project"
            && !routing.isSmallTalk
            && (shouldUseSupportDocsContext
                || routing.shouldUseProjectContext
                || diagnosticsRoute === "added"
                || Boolean(explicitDocs?.text)
                || explicitContextBlocks.length > 0);
        if (shouldUseSupportContext) {
            const baseRules = await this.options.baseContext.buildContext();
            if (baseRules.text) {
                baseRulesRoute = "added";
                contextBlocks.push({
                    source: "baseRules",
                    text: baseRules.text,
                    matchCount: baseRules.matchCount,
                    mode: "matched"
                });
            }
            else {
                baseRulesRoute = "missing";
            }
        }
        if (shouldUseSupportContext && request.chatKind === "project") {
            const rules = await this.options.rulesContext.buildContext(request.chatKind, request.rulesEnabled);
            this.options.state.setRulesContext(rules.status);
            this.notify(request.chatId);
            rulesRoute = rules.status.status === "active" && rules.text
                ? "added"
                : rules.status.status;
            if (rules.text) {
                contextBlocks.push({
                    source: "rules",
                    text: rules.text,
                    matchCount: rules.matchCount,
                    mode: "matched"
                });
            }
        }
        else if (request.chatKind === "general") {
            this.options.state.setRulesContext({
                status: "disabled",
                label: "Обычный чат не использует правила проекта"
            });
            this.notify(request.chatId);
        }
        else {
            this.options.logger.info(`Rules context skipped by router: route=${routing.route}; reason=${routing.reason}.`);
        }
        const budget = (0, contextBudgetPlanner_1.applyContextBudget)(contextBlocks, { route: routing.route });
        const worklog = buildContextTurnWorklog(toolWorklog, explicitContextBlocks, budget.blocks);
        if (contextBlocks.length) {
            this.options.logger.info(`context budget: mode=${budget.mode}, route=${budget.route}, limit=${budget.totalCharsLimit}, ` +
                `beforeChars=${budget.beforeChars}, afterChars=${budget.afterChars}, ` +
                `trimmed=${budget.trimmed.length ? budget.trimmed.join(",") : "none"}, ` +
                `dropped=${budget.dropped.length ? budget.dropped.join(",") : "none"}, ` +
                `sources=${budget.sourceStats.length ? budget.sourceStats.join(";") : "none"}, ` +
                `decisions=${budget.decisions.length ? budget.decisions.join(";") : "none"}.`);
        }
        const input = request.runMode === "planning"
            ? [{ type: "text", text: this.options.contextRouter.buildPlanningEnvelope({ userPrompt: request.prompt, blocks: budget.blocks }) }]
            : budget.blocks.length
                ? [{ type: "text", text: this.options.contextRouter.buildServiceEnvelope({ userPrompt: request.prompt, blocks: budget.blocks }) }]
                : [{ type: "text", text: request.prompt }];
        this.options.logger.info(`context orchestrator: mode=${mode}, route=${routing.route}, docs=${docsRoute}, project=${projectRoute}, ` +
            `diagnostics=${diagnosticsRoute}, baseRules=${baseRulesRoute}, rules=${rulesRoute}, explicit=${explicitContextBlocks.length}, ` +
            `blocks=${budget.blocks.length}, reason=${routing.reason}.`);
        this.options.logger.info(`context routed: route=${routing.route}, docsMode=${routing.docsMode}, projectMode=${routing.projectMode}, ` +
            `baseRules=${baseRulesRoute}, project=${projectRoute}, docs=${docsRoute}, diagnostics=${diagnosticsRoute}, ` +
            `rules=${rulesRoute}, explicit=${explicitContextBlocks.length}, reason=${routing.reason}, blocks=${budget.blocks.length}.`);
        return {
            input,
            mode,
            route: routing.route,
            docsRoute,
            projectRoute,
            diagnosticsRoute,
            baseRulesRoute,
            rulesRoute,
            explicitCount: explicitContextBlocks.length,
            blocks: budget.blocks,
            budget,
            hasContext: budget.blocks.length > 0,
            worklog
        };
    }
    selectMode(shouldUseContextTools) {
        if (!shouldUseContextTools) {
            return "retrieval-only";
        }
        const native = this.options.nativeContextTools.getSnapshot();
        if (native.status === "available" && native.mode === "native-tools") {
            this.options.logger.info("Native context tool-loop is available, but orchestrator keeps managed fallback as effective mode until native result transport is wired into turn/start.");
        }
        return "managed-fallback";
    }
    async buildToolContext(input) {
        const managed = await this.options.managedContextTools.buildContext({
            chatId: input.chatId,
            prompt: input.prompt,
            chatKind: input.chatKind,
            routing: input.routing,
            hasExplicitDocs: input.hasExplicitDocs,
            shouldUseDiagnostics: input.shouldUseDiagnostics,
            diagnosticsPriority: input.diagnosticsPriority
        });
        return managed;
    }
    async updateProjectState(chatId, chatKind, shouldUseProjectContext) {
        if (shouldUseProjectContext) {
            const projectDetails = await this.options.projectContext.getDetails(this.options.profiles.getCurrentProfileId());
            this.options.state.setProjectContext({
                status: projectDetails.status,
                label: projectDetails.label
            });
            this.notify(chatId);
            return;
        }
        if (chatKind === "general") {
            this.options.state.setProjectContext({
                status: "disabled",
                label: "Обычный чат не использует проектный контекст"
            });
            this.notify(chatId);
            return;
        }
        this.options.state.setProjectContext({
            status: "disabled",
            label: "Проектный контекст не требуется для этого запроса"
        });
        this.notify(chatId);
    }
    notify(chatId) {
        this.options.onDidChange();
        this.options.onDidChangeChat(chatId);
    }
}
exports.ContextTurnOrchestrator = ContextTurnOrchestrator;
function normalizeDocsRoute(route) {
    if (route === "overview") {
        return "overview";
    }
    if (route === "added") {
        return "added";
    }
    return "skip";
}
function normalizeDiagnosticsRoute(route) {
    if (route === "added") {
        return "added";
    }
    if (route === "empty") {
        return "empty";
    }
    return "skip";
}
function normalizeProjectRoute(route) {
    return route === "added" ? "added" : "skip";
}
function buildContextTurnWorklog(toolEntries, explicitBlocks, selectedBlocks) {
    const selectedSources = new Set(selectedBlocks.map((block) => block.source));
    const entries = [];
    const docs = aggregateToolEntries(toolEntries, "docs");
    if (docs && shouldShowToolWorklog(docs, selectedSources)) {
        entries.push({
            source: "docs",
            label: docsLabel(docs),
            status: docs.status,
            itemCount: docs.itemCount,
            blockCount: docs.blockCount,
            chars: docs.chars,
            truncated: docs.truncated
        });
    }
    else if (selectedSources.has("docs") && explicitBlocks.some((block) => block.source === "docs")) {
        entries.push({
            source: "docs",
            label: "Подготовлен контекст документации",
            status: "completed",
            itemCount: selectedBlocks.filter((block) => block.source === "docs").reduce((total, block) => total + block.matchCount, 0),
            blockCount: selectedBlocks.filter((block) => block.source === "docs").length,
            chars: selectedBlocks.filter((block) => block.source === "docs").reduce((total, block) => total + block.text.length, 0),
            truncated: false
        });
    }
    const project = aggregateToolEntries(toolEntries, "project");
    if (project && shouldShowToolWorklog(project, selectedSources)) {
        entries.push({
            source: "project",
            label: projectLabel(project),
            status: project.status,
            itemCount: project.itemCount,
            blockCount: project.blockCount,
            chars: project.chars,
            truncated: project.truncated
        });
    }
    const diagnostics = aggregateToolEntries(toolEntries, "diagnostics");
    if (diagnostics && shouldShowToolWorklog(diagnostics, selectedSources)) {
        entries.push({
            source: "diagnostics",
            label: diagnosticsLabel(diagnostics),
            status: diagnostics.status,
            itemCount: diagnostics.itemCount,
            blockCount: diagnostics.blockCount,
            chars: diagnostics.chars,
            truncated: diagnostics.truncated
        });
    }
    const editorFileBlocks = selectedBlocks.filter((block) => block.source === "editorFile");
    if (editorFileBlocks.length) {
        entries.push({
            source: "editorFile",
            label: "Изучен текущий файл",
            status: "completed",
            itemCount: editorFileBlocks.reduce((total, block) => total + block.matchCount, 0),
            blockCount: editorFileBlocks.length,
            chars: editorFileBlocks.reduce((total, block) => total + block.text.length, 0),
            truncated: false
        });
    }
    const editorSelectionBlocks = selectedBlocks.filter((block) => block.source === "editorSelection");
    if (editorSelectionBlocks.length) {
        entries.push({
            source: "editorSelection",
            label: "Изучен выделенный фрагмент",
            status: "completed",
            itemCount: editorSelectionBlocks.reduce((total, block) => total + block.matchCount, 0),
            blockCount: editorSelectionBlocks.length,
            chars: editorSelectionBlocks.reduce((total, block) => total + block.text.length, 0),
            truncated: false
        });
    }
    const visibleEntries = entries.filter((entry) => entry.label.trim().length > 0);
    return {
        entries: visibleEntries,
        label: visibleEntries.map((entry) => entry.label).join(", "),
        details: visibleEntries.map((entry) => `${entry.label}; blocks=${entry.blockCount}; items=${entry.itemCount}; chars=${entry.chars}${entry.truncated ? "; truncated=true" : ""}`)
    };
}
function shouldShowToolWorklog(entry, selectedSources) {
    if (entry.status === "error") {
        return true;
    }
    if (entry.route === "empty" || entry.route === "skip") {
        return false;
    }
    return selectedSources.has(entry.source);
}
function aggregateToolEntries(entries, source) {
    const related = entries.filter((entry) => entry.source === source);
    if (!related.length) {
        return undefined;
    }
    return {
        source,
        route: aggregateRoute(related),
        status: related.some((entry) => entry.status === "error") ? "error" : "completed",
        itemCount: related.reduce((total, entry) => total + entry.itemCount, 0),
        blockCount: related.reduce((total, entry) => total + entry.blockCount, 0),
        chars: related.reduce((total, entry) => total + entry.chars, 0),
        truncated: related.some((entry) => entry.truncated)
    };
}
function aggregateRoute(entries) {
    if (entries.some((entry) => entry.route === "overview")) {
        return "overview";
    }
    if (entries.some((entry) => entry.route === "added")) {
        return "added";
    }
    if (entries.some((entry) => entry.route === "error")) {
        return "error";
    }
    if (entries.some((entry) => entry.route === "empty")) {
        return "empty";
    }
    return "skip";
}
function docsLabel(entry) {
    if (entry.status === "error") {
        return "Документация недоступна";
    }
    if (entry.route === "overview") {
        return "Подготовлен обзор документации";
    }
    return `Найдено ${formatCount(entry.blockCount || entry.itemCount, "фрагмент", "фрагмента", "фрагментов")} документации`;
}
function projectLabel(entry) {
    if (entry.status === "error") {
        return "Проектный контекст недоступен";
    }
    return `Изучено ${formatCount(entry.blockCount || entry.itemCount, "фрагмент", "фрагмента", "фрагментов")} проекта`;
}
function diagnosticsLabel(entry) {
    if (entry.status === "error") {
        return "Диагностики IDE недоступны";
    }
    return `Проверены ошибки IDE: ${formatCount(entry.itemCount || entry.blockCount, "ошибка", "ошибки", "ошибок")}`;
}
function formatCount(count, one, few, many) {
    const value = Math.max(0, count);
    const mod10 = value % 10;
    const mod100 = value % 100;
    const noun = mod10 === 1 && mod100 !== 11
        ? one
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
            ? few
            : many;
    return `${value} ${noun}`;
}
//# sourceMappingURL=contextTurnOrchestrator.js.map
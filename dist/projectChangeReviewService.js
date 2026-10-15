"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectChangeReviewService = void 0;
exports.formatChangeReview = formatChangeReview;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const projectChangeAnalysis_1 = require("./projectChangeAnalysis");
const projectContextService_1 = require("./projectContextService");
/** Validation is read-only. Findings are evidence for the next request, not an edit authorization. */
class ProjectChangeReviewService {
    constructor(project, ast, language, getProfileId, logger) {
        this.project = project;
        this.ast = ast;
        this.language = language;
        this.getProfileId = getProfileId;
        this.logger = logger;
        this.reports = new Map();
    }
    async begin() {
        const profileId = this.getProfileId();
        if (!profileId)
            return undefined;
        try {
            const snapshot = await bounded(signal => this.project.captureChangeSnapshot(profileId, true, signal), 8000);
            if (!snapshot.isCurrent() || profileId !== this.getProfileId())
                return undefined;
            return { snapshot, profileId, diagnostics: this.readDiagnostics(snapshot.workspaceRoot).entries };
        }
        catch {
            this.logger.warn("Change review: baseline unavailable; no claim of a completed check will be made.");
            return undefined;
        }
    }
    async complete(chatId, baseline, isCurrent) {
        const valid = () => isCurrent() && baseline.profileId === this.getProfileId() && baseline.snapshot.isCurrent();
        if (!valid())
            return undefined;
        const after = await bounded(signal => this.project.captureChangeSnapshot(baseline.profileId, true, signal), 8000);
        const resultCurrent = () => valid() && after.isContentCurrent();
        if (!resultCurrent() || after.workspaceRoot !== baseline.snapshot.workspaceRoot)
            return undefined;
        const report = await bounded(signal => (0, projectChangeAnalysis_1.analyzeProjectChanges)({
            before: baseline.snapshot,
            after,
            readFile: filePath => after.readFile(filePath, signal),
            parse: (text, signal) => this.ast.parse(text, { signal }),
            inspect: (filePath, positions) => this.language.inspect(vscode.Uri.file(path.join(after.workspaceRoot, filePath)), positions),
            isCurrent: resultCurrent,
            signal
        }), 12000);
        if (!resultCurrent() || report.status === "stale")
            return undefined;
        const paths = new Set([...report.changedPaths, ...report.findings.map(finding => finding.path)]);
        const old = new Set(baseline.diagnostics.map(entry => entry.key));
        const selected = this.readDiagnostics(after.workspaceRoot, paths, 40);
        const diagnostics = selected.entries
            .map(entry => ({ ...entry, observed: old.has(entry.key) ? "existing" : "not-in-baseline" }));
        const result = { report, diagnostics, omittedDiagnostics: selected.omitted, text: "" };
        result.text = formatChangeReview(result);
        if (report.status !== "unchanged") {
            this.reports.delete(chatId);
            this.reports.set(chatId, { result, snapshot: after, profileId: baseline.profileId, baselineDiagnostics: old });
            while (this.reports.size > 8)
                this.reports.delete(this.reports.keys().next().value);
        }
        this.logger.info(`Change review: status=${report.status}; changed=${report.changedPaths.length}; checked=${report.checkedPaths.length}; findings=${report.findings.length}; IDE=${diagnostics.length}.`);
        return result;
    }
    async context(chatId) {
        const entry = this.reports.get(chatId);
        if (!entry)
            return undefined;
        try {
            if (entry.profileId !== this.getProfileId() || !entry.snapshot.isContentCurrent())
                throw new Error("scope");
            // A report is never replayed merely because the chat is the same.
            await bounded(async (signal) => {
                const current = await this.project.captureChangeSnapshot(entry.profileId, true, signal);
                if (signal.aborted)
                    throw new Error("cancelled");
                if (current.workspaceRoot !== entry.snapshot.workspaceRoot
                    || JSON.stringify(current.files.map(file => [file.path, file.hash])) !== JSON.stringify(entry.snapshot.files.map(file => [file.path, file.hash])))
                    throw new Error("changed");
                for (const filePath of entry.result.report.checkedPaths) {
                    if (signal.aborted)
                        throw new Error("cancelled");
                    await entry.snapshot.readFile(filePath, signal);
                }
                if (signal.aborted)
                    throw new Error("cancelled");
                if (!current.isContentCurrent())
                    throw new Error("changed");
            }, 2000);
            if (entry.profileId !== this.getProfileId() || !entry.snapshot.isContentCurrent())
                throw new Error("scope");
            const paths = new Set([...entry.result.report.changedPaths, ...entry.result.report.findings.map(finding => finding.path)]);
            const selected = this.readDiagnostics(entry.snapshot.workspaceRoot, paths, 40);
            entry.result.diagnostics = selected.entries
                .map(item => ({ ...item, observed: entry.baselineDiagnostics.has(item.key) ? "existing" : "not-in-baseline" }));
            entry.result.omittedDiagnostics = selected.omitted;
            entry.result.text = formatChangeReview(entry.result);
            return {
                source: "project", text: entry.result.text,
                matchCount: entry.result.report.findings.length + entry.result.diagnostics.length,
                mode: "matched", priority: 110,
                metadata: { changeReview: true, ruleRoot: entry.snapshot.workspaceRoot, targets: (0, projectContextService_1.projectRuleTargets)(entry.snapshot.files, [
                        ...entry.result.report.changedPaths, ...entry.result.report.findings.map(finding => finding.path),
                        ...entry.result.report.findings.flatMap(finding => [...(finding.candidatePaths ?? []), ...(finding.targets?.map(target => target.path) ?? [])]),
                        ...entry.result.report.elementTargets.map(target => target.path)
                    ]) }
            };
        }
        catch {
            this.reports.delete(chatId);
            return undefined;
        }
    }
    forget(chatId) { this.reports.delete(chatId); }
    clear() { this.reports.clear(); }
    readDiagnostics(root, paths, limit = 2000) {
        const errors = [];
        const warnings = [];
        const counts = { errors: 0, warnings: 0 };
        try {
            for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
                if (!uri || uri.scheme !== "file" || typeof uri.fsPath !== "string" || !Array.isArray(diagnostics))
                    continue;
                const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
                if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
                    continue;
                if (paths && !paths.has(relative))
                    continue;
                for (const diagnostic of diagnostics) {
                    if (!diagnostic || typeof diagnostic.message !== "string" || !Number.isInteger(diagnostic.range?.start?.line)
                        || diagnostic.range.start.line < 0)
                        continue;
                    const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error"
                        : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning" : undefined;
                    if (!severity)
                        continue;
                    const entries = severity === "error" ? errors : warnings;
                    counts[severity === "error" ? "errors" : "warnings"]++;
                    if (entries.length >= limit)
                        continue;
                    const message = diagnostic.message.replace(/\s+/g, " ").slice(0, 500);
                    const code = diagnostic.code && typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
                    entries.push({ path: relative, line: diagnostic.range.start.line + 1, message, severity,
                        key: JSON.stringify([relative, diagnostic.source, code, severity, message]) });
                }
            }
        }
        catch { /* Public diagnostics are optional in the Element bundle. */ }
        const selectedWarnings = warnings.slice(0, Math.max(0, limit - errors.length));
        return { entries: [...errors, ...selectedWarnings],
            omitted: { errors: counts.errors - errors.length, warnings: counts.warnings - selectedWarnings.length } };
    }
}
exports.ProjectChangeReviewService = ProjectChangeReviewService;
function formatChangeReview(result) {
    const { report } = result;
    const lines = [
        "[Проверка последствий изменений]",
        `Изменённых файлов в доступном индексе: ${report.changedPaths.length}. Проверено файлов: ${report.checkedPaths.length}.`,
        "Это ограниченная проверка, не сборка и не тестирование бизнес-логики. Кандидаты связей не означают подтверждённую ошибку.",
        "Снимки отражают наблюдаемые изменения, включая ручные правки и работу других чатов; авторство изменений не устанавливается.",
        "Не меняй связанные места только по совпадению имени. Проверь определения и текущий код в рамках запроса пользователя.",
        "Наличие синтаксического замечания после правки не доказывает, что оно появилось из-за этой правки.",
        "Диагностики IDE: текущий кеш провайдеров, без подтверждения повторной компиляции. Пустой кеш не означает отсутствие ошибок."
    ];
    const omitted = { errors: result.omittedDiagnostics?.errors ?? 0, warnings: result.omittedDiagnostics?.warnings ?? 0,
        findings: 0, limitations: 0 };
    let length = lines.join("\n").length;
    const append = (text, kind) => {
        // Reserve space for exact omission counts, including IDE errors beyond either budget.
        if (length + text.length + 1 > 15000) {
            omitted[kind]++;
            return;
        }
        lines.push(text);
        length += text.length + 1;
    };
    const diagnostic = (item) => `- ${item.path}:${item.line} [${item.severity === "error" ? "ошибка" : "предупреждение"}; ${item.observed === "existing" ? "было до запроса" : "не было в исходном снимке кеша"}] ${item.message}`;
    const finding = (item) => `- ${item.path}:${item.line} [${item.evidence}; ${item.kind}] ${item.message}`;
    for (const item of result.diagnostics)
        if (item.severity === "error")
            append(diagnostic(item), "errors");
    for (const item of report.findings)
        if (item.kind === "syntax")
            append(finding(item), "findings");
    for (const item of result.diagnostics)
        if (item.severity === "warning")
            append(diagnostic(item), "warnings");
    for (const item of report.findings)
        if (item.kind !== "syntax")
            append(finding(item), "findings");
    for (const item of report.limitations)
        append(`Ограничение: ${item}`, "limitations");
    if (Object.values(omitted).some(count => count > 0)) {
        lines.push("Отчёт сокращён до лимита; часть замечаний не включена.");
        lines.push(`Не включено диагностик IDE: ошибок ${omitted.errors}, предупреждений ${omitted.warnings}. Замечаний анализа: ${omitted.findings}. Ограничений: ${omitted.limitations}.`);
    }
    return lines.join("\n");
}
function bounded(run, timeout) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Истекло время проверки изменений."));
        }, timeout);
        Promise.resolve().then(() => run(controller.signal)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
}
//# sourceMappingURL=projectChangeReviewService.js.map
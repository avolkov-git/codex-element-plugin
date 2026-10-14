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
            const snapshot = await bounded(this.project.captureChangeSnapshot(profileId, true), 8000);
            if (!snapshot.isCurrent() || profileId !== this.getProfileId())
                return undefined;
            return { snapshot, profileId, diagnostics: this.readDiagnostics(snapshot.workspaceRoot) };
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
        const after = await bounded(this.project.captureChangeSnapshot(baseline.profileId, true), 8000);
        const resultCurrent = () => valid() && after.isContentCurrent();
        if (!resultCurrent() || after.workspaceRoot !== baseline.snapshot.workspaceRoot)
            return undefined;
        const report = await bounded((0, projectChangeAnalysis_1.analyzeProjectChanges)({
            before: baseline.snapshot,
            after,
            readFile: filePath => after.readFile(filePath),
            parse: (text, signal) => this.ast.parse(text, { signal }),
            inspect: (filePath, positions) => this.language.inspect(vscode.Uri.file(path.join(after.workspaceRoot, filePath)), positions),
            isCurrent: resultCurrent
        }), 12000);
        if (!resultCurrent() || report.status === "stale")
            return undefined;
        const paths = new Set([...report.changedPaths, ...report.findings.map(finding => finding.path)]);
        const old = new Set(baseline.diagnostics.map(entry => entry.key));
        const diagnostics = this.readDiagnostics(after.workspaceRoot).filter(entry => paths.has(entry.path)).slice(0, 40)
            .map(entry => ({ ...entry, observed: old.has(entry.key) ? "existing" : "not-in-baseline" }));
        const result = { report, diagnostics, text: "" };
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
            await bounded((async () => {
                const current = await this.project.captureChangeSnapshot(entry.profileId, true);
                if (current.workspaceRoot !== entry.snapshot.workspaceRoot
                    || JSON.stringify(current.files.map(file => [file.path, file.hash])) !== JSON.stringify(entry.snapshot.files.map(file => [file.path, file.hash])))
                    throw new Error("changed");
                for (const filePath of entry.result.report.checkedPaths)
                    await entry.snapshot.readFile(filePath);
                if (!current.isContentCurrent())
                    throw new Error("changed");
            })(), 2000);
            if (entry.profileId !== this.getProfileId() || !entry.snapshot.isContentCurrent())
                throw new Error("scope");
            const paths = new Set([...entry.result.report.changedPaths, ...entry.result.report.findings.map(finding => finding.path)]);
            entry.result.diagnostics = this.readDiagnostics(entry.snapshot.workspaceRoot).filter(item => paths.has(item.path)).slice(0, 40)
                .map(item => ({ ...item, observed: entry.baselineDiagnostics.has(item.key) ? "existing" : "not-in-baseline" }));
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
    readDiagnostics(root) {
        const entries = [];
        try {
            for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
                if (!uri || uri.scheme !== "file" || typeof uri.fsPath !== "string" || !Array.isArray(diagnostics))
                    continue;
                const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
                if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
                    continue;
                for (const diagnostic of diagnostics) {
                    if (!diagnostic || typeof diagnostic.message !== "string" || !Number.isInteger(diagnostic.range?.start?.line)
                        || diagnostic.range.start.line < 0)
                        continue;
                    const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error"
                        : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning" : undefined;
                    if (!severity)
                        continue;
                    const message = diagnostic.message.replace(/\s+/g, " ").slice(0, 500);
                    const code = diagnostic.code && typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
                    entries.push({ path: relative, line: diagnostic.range.start.line + 1, message, severity,
                        key: JSON.stringify([relative, diagnostic.source, code, severity, message]) });
                    if (entries.length >= 2000)
                        return entries;
                }
            }
        }
        catch { /* Public diagnostics are optional in the Element bundle. */ }
        return entries;
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
        ...report.findings.map(item => `- ${item.path}:${item.line} [${item.evidence}; ${item.kind}] ${item.message}`),
        "Диагностики IDE: текущий кеш провайдеров, без подтверждения повторной компиляции. Пустой кеш не означает отсутствие ошибок.",
        ...result.diagnostics.map(item => `- ${item.path}:${item.line} [${item.severity === "error" ? "ошибка" : "предупреждение"}; ${item.observed === "existing" ? "было до запроса" : "не было в исходном снимке кеша"}] ${item.message}`),
        ...report.limitations.map(item => `Ограничение: ${item}`)
    ];
    const text = lines.join("\n");
    return text.length > 16000 ? `${text.slice(0, 15800)}\nОтчёт сокращён до лимита; часть замечаний не включена.` : text;
}
function bounded(promise, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Истекло время проверки изменений.")), timeout);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}
//# sourceMappingURL=projectChangeReviewService.js.map
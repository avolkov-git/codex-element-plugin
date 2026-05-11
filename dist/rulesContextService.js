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
exports.RulesContextService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const RULES_RELATIVE_PATH = path.join(".local-codex", "rules.md");
const MAX_RULES_BYTES = 64 * 1024;
const MAX_RULES_CONTEXT_CHARS = 12000;
const DEFAULT_RULES_TEMPLATE = [
    "# Правила проекта для Codex",
    "",
    "Опишите здесь постоянные правила проекта:",
    "",
    "- стиль кода;",
    "- архитектурные соглашения;",
    "- запреты и ограничения;",
    "- команды проверки.",
    ""
].join("\n");
class RulesContextService {
    constructor(logger) {
        this.logger = logger;
    }
    getStatus(chatKind, rulesEnabled) {
        if (chatKind !== "project") {
            return { status: "disabled", label: "Обычный чат не использует правила проекта" };
        }
        if (!rulesEnabled) {
            return { status: "disabled", label: "Правила проекта выключены для этого чата" };
        }
        const rulesPath = this.resolveRulesPath();
        if (!rulesPath) {
            return { status: "missing", label: "Workspace не найден, правила проекта недоступны" };
        }
        if (!fs.existsSync(rulesPath)) {
            return { status: "missing", label: "Файл .local-codex/rules.md не найден" };
        }
        return { status: "active", label: "Правила проекта активны" };
    }
    async buildContext(chatKind, rulesEnabled) {
        const status = this.getStatus(chatKind, rulesEnabled);
        if (status.status !== "active") {
            this.logger.info(`Rules context skipped: ${status.label}.`);
            return { matchCount: 0, status };
        }
        const rulesPath = this.resolveRulesPath();
        if (!rulesPath) {
            return {
                matchCount: 0,
                status: { status: "missing", label: "Workspace не найден, правила проекта недоступны" }
            };
        }
        try {
            const stat = await fs.promises.stat(rulesPath);
            if (stat.size > MAX_RULES_BYTES) {
                const message = `Файл правил слишком большой: ${Math.round(stat.size / 1024)}KB.`;
                this.logger.warn(`Rules context skipped: ${message}`);
                return {
                    sourcePath: rulesPath,
                    matchCount: 0,
                    status: { status: "error", label: "Правила проекта слишком большие" }
                };
            }
            const raw = await fs.promises.readFile(rulesPath, "utf8");
            const rules = raw.trim();
            if (!rules) {
                this.logger.info("Rules context skipped: rules file is empty.");
                return {
                    sourcePath: rulesPath,
                    matchCount: 0,
                    status: { status: "missing", label: "Файл правил пуст" }
                };
            }
            const text = formatRulesContext(rulesPath, rules);
            this.logger.info(`Rules context added: ${rulesPath}.`);
            return {
                text,
                sourcePath: rulesPath,
                matchCount: 1,
                status: { status: "active", label: "Правила проекта активны" }
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Rules context skipped: ${message}.`);
            return {
                sourcePath: rulesPath,
                matchCount: 0,
                status: { status: "error", label: "Правила проекта недоступны" }
            };
        }
    }
    async openRulesFile() {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage("Workspace не найден. Невозможно создать правила проекта.");
            return undefined;
        }
        const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
        await fs.promises.mkdir(path.dirname(rulesPath), { recursive: true });
        if (!fs.existsSync(rulesPath)) {
            await fs.promises.writeFile(rulesPath, DEFAULT_RULES_TEMPLATE, "utf8");
            this.logger.info(`Project rules file created: ${rulesPath}.`);
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rulesPath));
        await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        return rulesPath;
    }
    resolveRulesPath() {
        const workspaceRoot = getWorkspaceRoot();
        return workspaceRoot ? path.join(workspaceRoot, RULES_RELATIVE_PATH) : undefined;
    }
}
exports.RulesContextService = RulesContextService;
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function formatRulesContext(sourcePath, rules) {
    const trimmed = trimText(rules, MAX_RULES_CONTEXT_CHARS);
    return [
        "[Правила проекта]",
        `Источник: ${sourcePath}`,
        "Соблюдай эти правила при ответах по проектному чату.",
        "Не сообщай пользователю, что правила были добавлены в контекст, если он прямо не спрашивает.",
        "",
        trimmed
    ].join("\n");
}
function trimText(value, maxLength) {
    const normalized = value.replace(/\r\n/g, "\n").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
//# sourceMappingURL=rulesContextService.js.map
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
exports.BaseContextService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const BASE_CONTEXT_RELATIVE_PATH = path.join("resources", "context", "codex-element-language-rules.md");
const MAX_BASE_CONTEXT_BYTES = 96 * 1024;
const MAX_BASE_CONTEXT_CHARS = 18000;
class BaseContextService {
    constructor(context, logger) {
        this.context = context;
        this.logger = logger;
    }
    async buildContext() {
        const sourcePath = this.resolveBaseContextPath();
        try {
            const stat = await fs.promises.stat(sourcePath);
            if (stat.size > MAX_BASE_CONTEXT_BYTES) {
                this.logger.warn(`Base context skipped: file is too large: ${Math.round(stat.size / 1024)}KB.`);
                return { sourcePath, matchCount: 0 };
            }
            const raw = await fs.promises.readFile(sourcePath, "utf8");
            const rules = raw.trim();
            if (!rules) {
                this.logger.warn("Base context skipped: bundled rules file is empty.");
                return { sourcePath, matchCount: 0 };
            }
            this.logger.info("Base context added: bundled language rules.");
            return {
                sourcePath,
                text: formatBaseContext(sourcePath, rules),
                matchCount: 1
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Base context skipped: ${message}.`);
            return { sourcePath, matchCount: 0 };
        }
    }
    async openBaseContextFile() {
        const sourcePath = this.resolveBaseContextPath();
        try {
            await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
            if (!fs.existsSync(sourcePath)) {
                await fs.promises.writeFile(sourcePath, DEFAULT_BASE_CONTEXT_TEMPLATE, "utf8");
                this.logger.warn(`Base context file recreated from fallback template: ${sourcePath}.`);
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
            return sourcePath;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Не удалось открыть базовый контекст.";
            this.logger.warn(`Base context open failed: ${message}`);
            vscode.window.showWarningMessage(message);
            return undefined;
        }
    }
    resolveBaseContextPath() {
        return path.join(this.context.extensionUri.fsPath, BASE_CONTEXT_RELATIVE_PATH);
    }
}
exports.BaseContextService = BaseContextService;
function formatBaseContext(sourcePath, rules) {
    return [
        "[Базовые правила Codex Element]",
        `Источник: ${sourcePath}`,
        "Это обязательные правила разработки для проектного чата Codex Element.",
        "Соблюдай их при генерации и правке кода 1C: Element, YAML и XBSL.",
        "Не сообщай пользователю, что базовые правила были добавлены в контекст, если он прямо не спрашивает.",
        "",
        trimText(rules, MAX_BASE_CONTEXT_CHARS)
    ].join("\n");
}
function trimText(value, maxLength) {
    const normalized = value.replace(/\r\n/g, "\n").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
const DEFAULT_BASE_CONTEXT_TEMPLATE = [
    "# Базовый контекст Codex Element",
    "",
    "Опишите обязательные правила разработки для проектных чатов Codex Element.",
    ""
].join("\n");
//# sourceMappingURL=baseContextService.js.map
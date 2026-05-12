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
exports.EditorContextService = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const MAX_EDITOR_CONTEXT_BYTES = 200 * 1024;
class EditorContextService {
    async buildRequest(kind) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Откройте файл в редакторе.");
            return undefined;
        }
        const document = editor.document;
        if (document.uri.scheme !== "file") {
            vscode.window.showWarningMessage("Codex может объяснять только файлы из файловой системы workspace.");
            return undefined;
        }
        return kind === "file"
            ? this.buildFileRequest(document)
            : this.buildSelectionRequest(editor);
    }
    buildFileRequest(document) {
        const text = document.getText();
        const byteLength = Buffer.byteLength(text, "utf8");
        if (byteLength > MAX_EDITOR_CONTEXT_BYTES) {
            vscode.window.showWarningMessage(`Файл слишком большой для отправки в контекст Codex. Лимит: ${formatBytes(MAX_EDITOR_CONTEXT_BYTES)}.`);
            return undefined;
        }
        const relativePath = getRelativePath(document.uri);
        const userPrompt = `Объясни файл ${relativePath}.`;
        return {
            visiblePrompt: userPrompt,
            userPrompt,
            relativePath,
            byteLength,
            contextBlock: {
                source: "editorFile",
                text: [
                    `Файл: ${relativePath}`,
                    `Язык: ${document.languageId || languageFromPath(relativePath)}`,
                    `Размер: ${byteLength} bytes`,
                    "",
                    "Содержимое файла:",
                    "```",
                    text,
                    "```"
                ].join("\n"),
                matchCount: 1,
                mode: "matched"
            }
        };
    }
    buildSelectionRequest(editor) {
        const selection = editor.selections.find((candidate) => !candidate.isEmpty);
        if (!selection) {
            vscode.window.showWarningMessage("Выделите фрагмент файла.");
            return undefined;
        }
        const document = editor.document;
        const text = document.getText(selection);
        const byteLength = Buffer.byteLength(text, "utf8");
        if (byteLength > MAX_EDITOR_CONTEXT_BYTES) {
            vscode.window.showWarningMessage(`Выделенный фрагмент слишком большой для отправки в контекст Codex. Лимит: ${formatBytes(MAX_EDITOR_CONTEXT_BYTES)}.`);
            return undefined;
        }
        const relativePath = getRelativePath(document.uri);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const location = `${relativePath}:${startLine}-${endLine}`;
        const userPrompt = `Объясни выделенный фрагмент ${location}.`;
        return {
            visiblePrompt: userPrompt,
            userPrompt,
            relativePath,
            byteLength,
            contextBlock: {
                source: "editorSelection",
                text: [
                    `Файл: ${relativePath}`,
                    `Диапазон: ${startLine}-${endLine}`,
                    `Язык: ${document.languageId || languageFromPath(relativePath)}`,
                    `Размер: ${byteLength} bytes`,
                    "",
                    "Выделенный фрагмент:",
                    "```",
                    text,
                    "```"
                ].join("\n"),
                matchCount: 1,
                mode: "matched"
            }
        };
    }
}
exports.EditorContextService = EditorContextService;
function getRelativePath(uri) {
    const relative = vscode.workspace.asRelativePath(uri, false);
    return relative && relative !== uri.fsPath ? toPosix(relative) : path.basename(uri.fsPath);
}
function languageFromPath(filePath) {
    const ext = path.extname(filePath).replace(/^\./, "");
    return ext || "text";
}
function toPosix(value) {
    return value.replace(/\\/g, "/");
}
function formatBytes(bytes) {
    return `${Math.round(bytes / 1024)} KB`;
}
//# sourceMappingURL=editorContextService.js.map
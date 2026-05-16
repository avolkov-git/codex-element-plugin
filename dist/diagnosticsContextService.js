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
exports.DiagnosticsContextService = void 0;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const MAX_ERRORS = 40;
const MAX_FILES = 25;
const MAX_MESSAGE_CHARS = 500;
class DiagnosticsContextService {
    constructor(logger) {
        this.logger = logger;
    }
    async buildContext(options) {
        const result = await this.collectErrorContext(options.priority);
        if (!result.block) {
            this.logger.info(`Diagnostics context skipped: reason=${result.reason}; errors=${result.totalErrorsCount}.`);
            return result;
        }
        this.logger.info(`Diagnostics context added: files=${result.filesCount}; errors=${result.errorsCount}; ` +
            `totalErrors=${result.totalErrorsCount}; omitted=${result.omittedErrorsCount}; fingerprint=${result.fingerprint}.`);
        return result;
    }
    async collectErrorContext(priority = 90) {
        const roots = getWorkspaceRoots();
        if (!roots.length) {
            return {
                filesCount: 0,
                errorsCount: 0,
                totalErrorsCount: 0,
                omittedErrorsCount: 0,
                fingerprint: "",
                reason: "no-workspace"
            };
        }
        const activeFile = getActiveFilePath();
        const entries = collectDiagnostics(roots, activeFile);
        if (!entries.length) {
            return {
                filesCount: 0,
                errorsCount: 0,
                totalErrorsCount: 0,
                omittedErrorsCount: 0,
                fingerprint: "",
                reason: "no-errors"
            };
        }
        const selected = selectEntries(entries);
        const fingerprint = hashEntries(entries);
        const selectedFiles = new Set(selected.map((entry) => entry.relativePath));
        const text = formatDiagnostics(selected, entries.length, selected.length);
        return {
            block: {
                source: "diagnostics",
                text,
                matchCount: selected.length,
                mode: "matched",
                score: 100,
                priority,
                tokensEstimate: Math.ceil(text.length / 4),
                metadata: {
                    filesCount: selectedFiles.size,
                    errorsCount: selected.length,
                    totalErrorsCount: entries.length,
                    omittedErrorsCount: Math.max(0, entries.length - selected.length),
                    fingerprint
                }
            },
            filesCount: selectedFiles.size,
            errorsCount: selected.length,
            totalErrorsCount: entries.length,
            omittedErrorsCount: Math.max(0, entries.length - selected.length),
            fingerprint,
            reason: "added"
        };
    }
    isDiagnosticsRelevantPrompt(prompt) {
        const normalized = normalizePrompt(prompt);
        return /(?:ошибк|диагностик|diagnostic|error|исправ|почини|fix|repair|build|сборк|компиляц|typescript|tsc|lint|проверк|проверить|не\s+собира|не\s+компилир)/u.test(normalized);
    }
    isHighPriorityPrompt(prompt) {
        const normalized = normalizePrompt(prompt);
        return /(?:ошибк|диагностик|diagnostic|error|исправ|почини|fix|repair|не\s+собира|не\s+компилир|падает\s+сборк)/u.test(normalized);
    }
}
exports.DiagnosticsContextService = DiagnosticsContextService;
function getWorkspaceRoots() {
    return (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => ({
        fsPath: path.resolve(folder.uri.fsPath),
        comparePath: normalizeForCompare(path.resolve(folder.uri.fsPath))
    }));
}
function getActiveFilePath() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === "file" ? normalizeForCompare(path.resolve(uri.fsPath)) : undefined;
}
function collectDiagnostics(roots, activeFile) {
    const seen = new Set();
    const entries = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== "file") {
            continue;
        }
        const filePath = path.resolve(uri.fsPath);
        const relativePath = getWorkspaceRelativePath(filePath, roots);
        if (!relativePath) {
            continue;
        }
        for (const diagnostic of diagnostics) {
            if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) {
                continue;
            }
            const line = diagnostic.range.start.line + 1;
            const column = diagnostic.range.start.character + 1;
            const source = cleanInline(diagnostic.source || "IDE");
            const code = normalizeDiagnosticCode(diagnostic.code);
            const message = truncate(cleanInline(diagnostic.message), MAX_MESSAGE_CHARS);
            const key = [
                relativePath,
                diagnostic.range.start.line,
                diagnostic.range.start.character,
                diagnostic.range.end.line,
                diagnostic.range.end.character,
                source,
                code,
                message
            ].join("\u0000");
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            entries.push({
                relativePath,
                line,
                column,
                source,
                code,
                message,
                key,
                activeFile: normalizeForCompare(filePath) === activeFile
            });
        }
    }
    return entries.sort((left, right) => Number(right.activeFile) - Number(left.activeFile)
        || left.relativePath.localeCompare(right.relativePath)
        || left.line - right.line
        || left.column - right.column
        || left.message.localeCompare(right.message));
}
function selectEntries(entries) {
    const selected = [];
    const files = new Set();
    for (const entry of entries) {
        if (!files.has(entry.relativePath) && files.size >= MAX_FILES) {
            continue;
        }
        if (selected.length >= MAX_ERRORS) {
            break;
        }
        files.add(entry.relativePath);
        selected.push(entry);
    }
    return selected;
}
function formatDiagnostics(entries, totalErrors, selectedErrors) {
    const lines = [
        "IDE diagnostics: только ошибки текущего workspace.",
        "Предупреждения, info и hints намеренно исключены.",
        "Исправляй только ошибки IDE, если запрос связан с кодом или проектом.",
        "Не упоминай diagnostics пользователю, если он прямо не спрашивает.",
        "",
        "Ошибки:"
    ];
    for (const entry of entries) {
        const code = entry.code ? ` ${entry.code}` : "";
        lines.push(`- ${entry.relativePath}:${entry.line}:${entry.column} [${entry.source}${code}] ${entry.message}`);
    }
    if (totalErrors > selectedErrors) {
        lines.push(`- ... еще ${totalErrors - selectedErrors} ошибок не добавлено из-за лимита контекста.`);
    }
    return lines.join("\n");
}
function getWorkspaceRelativePath(filePath, roots) {
    const comparePath = normalizeForCompare(filePath);
    let best;
    for (const root of roots) {
        if (comparePath !== root.comparePath && !comparePath.startsWith(`${root.comparePath}${path.sep}`)) {
            continue;
        }
        const relative = path.relative(root.fsPath, filePath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            continue;
        }
        if (!best || root.fsPath.length > best.root.fsPath.length) {
            best = { root, relative };
        }
    }
    return best ? toPosix(best.relative) : undefined;
}
function normalizeDiagnosticCode(code) {
    if (typeof code === "number" || typeof code === "string") {
        return String(code);
    }
    if (code && typeof code === "object" && "value" in code) {
        return String(code.value);
    }
    return "";
}
function normalizeForCompare(value) {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function toPosix(value) {
    return value.split(path.sep).join("/");
}
function cleanInline(value) {
    return value.replace(/\s+/g, " ").trim();
}
function truncate(value, maxChars) {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars - 1)}…`;
}
function normalizePrompt(prompt) {
    return prompt.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function hashEntries(entries) {
    const hash = crypto.createHash("sha1");
    for (const entry of entries) {
        hash.update(entry.key);
        hash.update("\n");
    }
    return hash.digest("hex").slice(0, 16);
}
//# sourceMappingURL=diagnosticsContextService.js.map
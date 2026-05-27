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
exports.DiffArtifactService = void 0;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const BEFORE_SCHEME = "codex-diff-before";
const AFTER_SCHEME = "codex-diff-after";
const MAX_VIRTUAL_DIFF_CHARS = 2000000;
class DiffArtifactService {
    constructor(logger) {
        this.logger = logger;
        this.artifacts = new Map();
        this.sequence = 0;
        this.disposables = [
            vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, this),
            vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, this)
        ];
    }
    provideTextDocumentContent(uri) {
        const artifact = this.artifacts.get(getArtifactId(uri));
        if (!artifact) {
            return "";
        }
        return uri.scheme === BEFORE_SCHEME ? artifact.beforeText : artifact.afterText;
    }
    async openDiff(item, file) {
        const artifact = buildArtifact(file);
        if (!artifact) {
            vscode.window.showWarningMessage("Diff недоступен для открытия в редакторе.");
            return;
        }
        const id = `${Date.now()}-${this.sequence++}`;
        this.artifacts.set(id, artifact);
        const fileName = sanitizeFileName(file.path || "changes.patch");
        const beforeUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${id}/${fileName}` });
        const afterUri = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${id}/${fileName}` });
        const title = `${file.path || item.title || "Изменения"} — Codex`;
        this.logger.info(`Opening native diff editor: diff=${item.id}; file=${file.path || "<unknown>"}.`);
        await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, { preview: false });
    }
    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.artifacts.clear();
    }
}
exports.DiffArtifactService = DiffArtifactService;
function buildArtifact(file) {
    const diff = typeof file.diff === "string" ? file.diff : "";
    if (!diff.trim() || diff.length > MAX_VIRTUAL_DIFF_CHARS) {
        return undefined;
    }
    const beforeLines = [];
    const afterLines = [];
    let sawContent = false;
    for (const line of diff.split(/\r?\n/)) {
        if (isMetadataLine(line)) {
            continue;
        }
        if (line.startsWith("@@")) {
            beforeLines.push(line);
            afterLines.push(line);
            continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            afterLines.push(line.slice(1));
            sawContent = true;
            continue;
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
            beforeLines.push(line.slice(1));
            sawContent = true;
            continue;
        }
        if (line.startsWith(" ")) {
            const text = line.slice(1);
            beforeLines.push(text);
            afterLines.push(text);
            sawContent = true;
            continue;
        }
        if (line.trim() && !line.startsWith("\\")) {
            beforeLines.push(line);
            afterLines.push(line);
        }
    }
    if (!sawContent) {
        return undefined;
    }
    return {
        beforeText: beforeLines.join("\n"),
        afterText: afterLines.join("\n")
    };
}
function isMetadataLine(line) {
    return (line.startsWith("diff --git ")
        || line.startsWith("index ")
        || line.startsWith("--- ")
        || line.startsWith("+++ ")
        || line.startsWith("new file mode ")
        || line.startsWith("deleted file mode ")
        || line.startsWith("old mode ")
        || line.startsWith("new mode ")
        || line.startsWith("similarity index ")
        || line.startsWith("rename from ")
        || line.startsWith("rename to "));
}
function getArtifactId(uri) {
    return uri.path.split("/").filter(Boolean)[0] ?? "";
}
function sanitizeFileName(value) {
    const base = path.basename(value.replace(/\\/g, "/")) || "changes.patch";
    return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}
//# sourceMappingURL=diffArtifactService.js.map
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
const featureSafety_1 = require("./featureSafety");
const BEFORE_SCHEME = "codex-diff-before";
const AFTER_SCHEME = "codex-diff-after";
const PATCH_SCHEME = "codex-diff-patch";
const MAX_VIRTUAL_DIFF_CHARS = 2000000;
const MAX_CACHE_CHARS = 8000000;
class DiffArtifactService {
    constructor(logger, resolveSnapshot) {
        this.logger = logger;
        this.resolveSnapshot = resolveSnapshot;
        this.artifacts = new Map();
        this.chars = 0;
        this.disposables = [BEFORE_SCHEME, AFTER_SCHEME, PATCH_SCHEME].map((scheme) => vscode.workspace.registerTextDocumentContentProvider(scheme, this));
    }
    provideTextDocumentContent(uri) {
        const artifact = this.artifacts.get(uri.path.split("/").filter(Boolean)[0] ?? "");
        if (!artifact) {
            return "This review snapshot has expired. Reopen the review to obtain a current snapshot.";
        }
        return uri.scheme === PATCH_SCHEME ? artifact.patch ?? "" : uri.scheme === BEFORE_SCHEME ? artifact.beforeText : artifact.afterText;
    }
    async openSnapshots(snapshot) {
        if (snapshot.beforeText.length + snapshot.afterText.length > MAX_VIRTUAL_DIFF_CHARS)
            throw new Error("Full review exceeds the native snapshot limit.");
        const id = this.store({ beforeText: snapshot.beforeText, afterText: snapshot.afterText });
        const fileName = sanitizeFileName(snapshot.path);
        const beforeUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${id}/${fileName}` });
        const afterUri = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${id}/${fileName}` });
        const title = `${snapshot.path} (${snapshot.beforeLabel ?? "Before"} -> ${snapshot.afterLabel ?? "After"}) - Codex`;
        await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, { preview: false });
        return { beforeUri, afterUri };
    }
    async openDiff(item, file) {
        const full = await this.resolveSnapshot?.(item, file);
        if (full) {
            await this.openSnapshots(full);
            return;
        }
        const patch = file.diff;
        if (!patch?.trim() || patch.length > MAX_VIRTUAL_DIFF_CHARS) {
            await vscode.window.showWarningMessage("The recorded patch is unavailable or exceeds the preview limit.");
            return;
        }
        // Hunk fragments cannot establish either full file revision. Keep them as a patch.
        const id = this.store({ beforeText: "", afterText: "", patch: `# Recorded patch fragment; not full-file revisions${file.truncated ? " (truncated)" : ""}.\n${patch}` });
        const uri = vscode.Uri.from({ scheme: PATCH_SCHEME, path: `/${id}/${sanitizeFileName(file.path)}.patch` });
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        this.logger.info("Opened recorded patch fragment; full revisions were not available.");
    }
    clear() { this.artifacts.clear(); this.chars = 0; }
    dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.clear();
    }
    store(artifact) {
        const id = (0, featureSafety_1.opaqueId)();
        this.artifacts.set(id, artifact);
        this.chars += artifact.beforeText.length + artifact.afterText.length + (artifact.patch?.length ?? 0);
        while (this.chars > MAX_CACHE_CHARS || this.artifacts.size > 32) {
            const oldest = this.artifacts.keys().next().value;
            const entry = this.artifacts.get(oldest);
            this.chars -= entry.beforeText.length + entry.afterText.length + (entry.patch?.length ?? 0);
            this.artifacts.delete(oldest);
        }
        return id;
    }
}
exports.DiffArtifactService = DiffArtifactService;
function sanitizeFileName(value) {
    const base = path.basename(value.replace(/\\/g, "/")) || "changes.patch";
    return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
//# sourceMappingURL=diffArtifactService.js.map
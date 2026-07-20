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
exports.ChatAttachmentService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
class ChatAttachmentService {
    constructor(logger) {
        this.logger = logger;
    }
    async pick(existing) {
        const current = await this.resolve(existing);
        const remaining = Math.max(0, MAX_ATTACHMENTS - current.length);
        if (!remaining) {
            vscode.window.showInformationMessage(`К сообщению можно прикрепить не больше ${MAX_ATTACHMENTS} объектов.`);
            return current;
        }
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            openLabel: "Прикрепить"
        });
        if (!selected?.length) {
            return current;
        }
        const candidates = await this.resolve(selected.slice(0, remaining).map((uri) => ({ path: uri.fsPath })));
        const merged = deduplicateAttachments([...current, ...candidates]).slice(0, MAX_ATTACHMENTS);
        if (selected.length > remaining) {
            vscode.window.showInformationMessage(`Добавлены первые ${remaining} объектов. Лимит вложений: ${MAX_ATTACHMENTS}.`);
        }
        return merged;
    }
    async resolve(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const output = [];
        for (const candidate of value.slice(0, MAX_ATTACHMENTS)) {
            const requestedPath = isObject(candidate) && typeof candidate.path === "string" ? candidate.path : "";
            if (!requestedPath) {
                continue;
            }
            try {
                const attachment = await this.resolvePath(requestedPath, isObject(candidate) && typeof candidate.id === "string" ? candidate.id : undefined);
                output.push(attachment);
            }
            catch (error) {
                this.logger.warn(`Attachment ignored: ${error instanceof Error ? error.message : "validation failed"}.`);
            }
        }
        return deduplicateAttachments(output);
    }
    async open(value) {
        const [attachment] = await this.resolve([value]);
        if (!attachment) {
            throw new Error("Вложение недоступно или находится вне workspace.");
        }
        const uri = vscode.Uri.file(attachment.path);
        if (attachment.kind === "folder") {
            await vscode.commands.executeCommand("revealInExplorer", uri);
            return;
        }
        await vscode.commands.executeCommand("vscode.open", uri);
    }
    async resolvePath(requestedPath, requestedId) {
        const roots = await workspaceRoots();
        if (!roots.length) {
            throw new Error("workspace не открыт");
        }
        const absolutePath = path.resolve(requestedPath);
        const realPath = await fs.promises.realpath(absolutePath);
        const workspace = roots.find((root) => isPathInside(root.realPath, realPath));
        if (!workspace) {
            throw new Error("путь находится вне workspace");
        }
        const stat = await fs.promises.stat(realPath);
        const kind = attachmentKind(realPath, stat.isDirectory());
        if (!stat.isDirectory() && stat.size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) {
            throw new Error(`файл превышает лимит ${kind === "image" ? "20" : "50"} МБ`);
        }
        const relative = path.relative(workspace.realPath, realPath) || path.basename(realPath);
        const displayPath = roots.length > 1 ? `${workspace.name}/${relative}` : relative;
        return {
            id: sanitizeId(requestedId) || `attachment-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
            kind,
            name: path.basename(realPath),
            path: realPath,
            displayPath: displayPath.split(path.sep).join("/"),
            sizeBytes: stat.isFile() ? stat.size : undefined
        };
    }
}
exports.ChatAttachmentService = ChatAttachmentService;
async function workspaceRoots() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return Promise.all(folders
        .filter((folder) => folder.uri.scheme === "file")
        .map(async (folder) => ({ name: folder.name, realPath: await fs.promises.realpath(folder.uri.fsPath) })));
}
function attachmentKind(filePath, directory) {
    if (directory) {
        return "folder";
    }
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "image" : "file";
}
function isPathInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function sanitizeId(value) {
    return value?.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) ?? "";
}
function deduplicateAttachments(attachments) {
    const seen = new Set();
    return attachments.filter((attachment) => {
        const key = process.platform === "win32" ? attachment.path.toLowerCase() : attachment.path;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=chatAttachmentService.js.map
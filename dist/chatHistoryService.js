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
exports.ChatHistoryService = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class ChatHistoryService {
    constructor(context, configRoot, logger) {
        this.context = context;
        this.configRoot = configRoot;
        this.logger = logger;
        this.saveChain = Promise.resolve();
    }
    async load(profileId) {
        const historyPath = this.historyPath(profileId);
        try {
            const raw = await fs.promises.readFile(historyPath, "utf8");
            const parsed = JSON.parse(raw);
            const history = normalizeHistory(parsed);
            this.logger.info(`Chat history loaded: ${historyPath}.`);
            return history;
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                this.logger.info(`Chat history not found for profile ${profileId}.`);
                return undefined;
            }
            this.logger.warn(`Chat history read failed, starting empty: ${normalizeErrorMessage(error)}.`);
            return undefined;
        }
    }
    scheduleSave(profileId, history) {
        this.pendingSave = { profileId, history };
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flush();
        }, 600);
    }
    async saveNow(profileId, history) {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        this.pendingSave = undefined;
        await this.writeQueued(profileId, history);
    }
    async flush() {
        const pending = this.pendingSave;
        if (!pending) {
            return;
        }
        this.pendingSave = undefined;
        await this.writeQueued(pending.profileId, pending.history);
    }
    dispose() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        if (this.pendingSave) {
            void this.flush();
        }
    }
    historyPath(profileId) {
        return path.join(this.configRoot, "users", profileId, "workspaces", this.workspaceId(), "chats.json");
    }
    workspaceId() {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.context.globalStorageUri.fsPath;
        return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
    }
    async writeQueued(profileId, history) {
        this.saveChain = this.saveChain
            .then(() => this.write(profileId, history))
            .catch((error) => {
            this.logger.warn(`Chat history save failed: ${normalizeErrorMessage(error)}.`);
        });
        await this.saveChain;
    }
    async write(profileId, history) {
        const historyPath = this.historyPath(profileId);
        await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
        const tempPath = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
        await fs.promises.rename(tempPath, historyPath);
        this.logger.info(`Chat history saved: ${historyPath}.`);
    }
}
exports.ChatHistoryService = ChatHistoryService;
function normalizeHistory(value) {
    const object = isObject(value) ? value : {};
    const chats = Array.isArray(object.chats)
        ? object.chats.map(normalizeChat).filter((chat) => Boolean(chat))
        : [];
    const chatIds = new Set(chats.map((chat) => chat.id));
    const transcripts = {};
    const rawTranscripts = isObject(object.transcripts) ? object.transcripts : {};
    for (const [chatId, items] of Object.entries(rawTranscripts)) {
        if (!chatIds.has(chatId) || !Array.isArray(items)) {
            continue;
        }
        transcripts[chatId] = items
            .map(normalizeTranscriptItem)
            .filter((item) => Boolean(item));
    }
    const activeChatId = typeof object.activeChatId === "string" && chatIds.has(object.activeChatId)
        ? object.activeChatId
        : undefined;
    return {
        version: 1,
        activeChatId,
        chats,
        transcripts
    };
}
function normalizeChat(value) {
    if (!isObject(value) || typeof value.id !== "string") {
        return undefined;
    }
    const kind = normalizeChatKind(value.kind);
    const now = new Date().toISOString();
    return {
        id: value.id,
        kind,
        title: typeof value.title === "string" && value.title.trim()
            ? value.title.trim()
            : kind === "project" ? "Проектный чат" : "Общий чат",
        createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
        lastReadAt: typeof value.lastReadAt === "string" ? value.lastReadAt : typeof value.updatedAt === "string" ? value.updatedAt : now,
        hasUnread: value.hasUnread === true,
        status: normalizeChatStatus(value.status),
        backendThreadId: typeof value.backendThreadId === "string" ? value.backendThreadId : null,
        activeTurnId: null
    };
}
function normalizeTranscriptItem(value) {
    if (!isObject(value) || typeof value.text !== "string") {
        return undefined;
    }
    const role = value.role === "user" || value.role === "assistant" || value.role === "system" ? value.role : undefined;
    if (!role) {
        return undefined;
    }
    return {
        id: typeof value.id === "string" ? value.id : `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: value.text,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString()
    };
}
function normalizeChatKind(value) {
    return value === "general" ? "general" : "project";
}
function normalizeChatStatus(value) {
    return value === "error" ? "error" : "idle";
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function normalizeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=chatHistoryService.js.map
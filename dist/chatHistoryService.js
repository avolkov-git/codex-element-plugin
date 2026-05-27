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
        archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : null,
        lastReadAt: typeof value.lastReadAt === "string" ? value.lastReadAt : typeof value.updatedAt === "string" ? value.updatedAt : now,
        hasUnread: value.hasUnread === true,
        status: normalizeChatStatus(value.status),
        accessMode: normalizeChatAccessMode(value.accessMode, kind),
        modelId: typeof value.modelId === "string" ? value.modelId : null,
        modelLabel: typeof value.modelLabel === "string" && value.modelLabel.trim() ? value.modelLabel.trim() : "5.5",
        effort: normalizeChatEffort(value.effort),
        speed: normalizeChatSpeed(value.speed),
        rulesEnabled: kind === "project" ? value.rulesEnabled !== false : false,
        pendingApproval: null,
        backendThreadAccessMode: normalizeOptionalChatAccessMode(value.backendThreadAccessMode),
        backendThreadId: typeof value.backendThreadId === "string" ? value.backendThreadId : null,
        activeTurnId: null,
        activeRunMode: null
    };
}
function normalizeTranscriptItem(value) {
    if (!isObject(value)) {
        return undefined;
    }
    const id = typeof value.id === "string" ? value.id : `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
    if (value.kind === "activity") {
        const label = typeof value.label === "string" ? value.label : "";
        if (!label || isHiddenLegacyActivity(label, value.activityKind)) {
            return undefined;
        }
        return {
            kind: "activity",
            id,
            activityKind: normalizeActivityKind(value.activityKind),
            label,
            status: value.status === "completed" || value.status === "error" ? value.status : "running",
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined,
            itemId: typeof value.itemId === "string" ? value.itemId : undefined,
            command: typeof value.command === "string" ? value.command : undefined,
            path: typeof value.path === "string" ? value.path : undefined,
            summary: typeof value.summary === "string" ? value.summary : undefined,
            outputPreview: typeof value.outputPreview === "string" ? value.outputPreview : undefined,
            details: normalizeActivityDetails(value.details)
        };
    }
    if (value.kind === "turn-run") {
        const turnId = typeof value.turnId === "string" ? value.turnId : "";
        if (!turnId) {
            return undefined;
        }
        return {
            kind: "turn-run",
            id,
            turnId,
            status: value.status === "completed" || value.status === "error" ? value.status : "running",
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
            activityIds: normalizeStringArray(value.activityIds),
            worklogIds: normalizeStringArray(value.worklogIds),
            diffIds: normalizeStringArray(value.diffIds),
            compactionIds: normalizeStringArray(value.compactionIds),
            counts: isObject(value.counts) ? normalizeTurnRunCounts(value.counts) : undefined
        };
    }
    if (value.kind === "worklog") {
        const operationKind = normalizeWorklogOperationKind(value.operationKind);
        const title = typeof value.title === "string" ? value.title.trim() : "";
        if (!title) {
            return undefined;
        }
        return {
            kind: "worklog",
            id,
            operationKind,
            status: normalizeWorklogStatus(value.status),
            title,
            summary: typeof value.summary === "string" ? value.summary : undefined,
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined,
            children: normalizeWorklogChildren(value.children)
        };
    }
    if (value.kind === "diff") {
        const files = Array.isArray(value.files)
            ? value.files.map(normalizeDiffFile).filter((file) => Boolean(file))
            : [];
        if (files.length === 0) {
            return undefined;
        }
        return {
            kind: "diff",
            id,
            title: typeof value.title === "string" ? value.title : "Изменения",
            additions: typeof value.additions === "number" ? value.additions : files.reduce((sum, file) => sum + file.additions, 0),
            deletions: typeof value.deletions === "number" ? value.deletions : files.reduce((sum, file) => sum + file.deletions, 0),
            files,
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined
        };
    }
    if (value.kind === "plan" && typeof value.markdown === "string") {
        return {
            kind: "plan",
            id,
            markdown: value.markdown,
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined
        };
    }
    if (value.kind === "clarification" && typeof value.question === "string") {
        return {
            kind: "clarification",
            id,
            question: value.question,
            options: normalizeClarificationOptions(value.options),
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined
        };
    }
    if (value.kind === "compaction") {
        return {
            kind: "compaction",
            id,
            label: typeof value.label === "string" ? value.label : "Контекст автоматически сжат",
            createdAt,
            turnId: typeof value.turnId === "string" ? value.turnId : undefined
        };
    }
    if (value.kind === "connection" && typeof value.message === "string") {
        return {
            kind: "connection",
            id,
            message: value.message,
            status: value.status === "failed" || value.status === "recovered" ? value.status : "reconnecting",
            attempt: typeof value.attempt === "number" ? value.attempt : undefined,
            maxAttempts: typeof value.maxAttempts === "number" ? value.maxAttempts : undefined,
            createdAt,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined
        };
    }
    if (value.kind === "error" && typeof value.message === "string") {
        return {
            kind: "error",
            id,
            message: value.message,
            details: typeof value.details === "string" ? value.details : undefined,
            createdAt
        };
    }
    if (typeof value.text !== "string") {
        return undefined;
    }
    const role = value.role === "user" || value.role === "assistant" || value.role === "system" ? value.role : undefined;
    if (!role) {
        return undefined;
    }
    return {
        kind: "message",
        id,
        role,
        text: value.text,
        createdAt,
        turnId: typeof value.turnId === "string" ? value.turnId : undefined,
        status: value.status === "streaming" ? "streaming" : "complete",
        completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
        durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined
    };
}
function normalizeClarificationOptions(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((option) => {
        const record = isObject(option) ? option : {};
        const title = typeof record.title === "string" ? record.title.trim() : "";
        const answer = typeof record.answer === "string" ? record.answer.trim() : title;
        const description = typeof record.description === "string" ? record.description.trim() : "";
        if (!title || !answer) {
            return undefined;
        }
        return {
            title,
            answer,
            description: description || undefined
        };
    })
        .filter((option) => Boolean(option))
        .slice(0, 5);
}
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const output = [];
    for (const item of value) {
        if (typeof item !== "string" || !item.trim() || seen.has(item)) {
            continue;
        }
        seen.add(item);
        output.push(item);
    }
    return output;
}
function normalizeTurnRunCounts(value) {
    const counts = {};
    for (const key of ["search", "command", "file", "read", "reasoning", "diagnostics", "context", "tool", "compaction", "diff"]) {
        const count = value[key];
        if (typeof count === "number" && Number.isFinite(count) && count > 0) {
            counts[key] = Math.floor(count);
        }
    }
    return counts;
}
function isHiddenLegacyActivity(label, activityKind) {
    const normalizedLabel = label.trim();
    return (normalizedLabel === "userMessage"
        || normalizedLabel === "agentMessage"
        || normalizedLabel === "hookPrompt"
        || normalizedLabel === "contextCompaction"
        || normalizedLabel === "plan"
        || (activityKind === "unknown" && /^userMessage\b/i.test(normalizedLabel))
        || activityKind === "unknown"
        || (activityKind === "reasoning" && normalizedLabel === "Думал"));
}
function normalizeActivityKind(value) {
    if (value === "turn" || value === "command" || value === "file" || value === "search" || value === "reasoning" || value === "context" || value === "tool") {
        return value;
    }
    return "unknown";
}
function normalizeWorklogOperationKind(value) {
    if (value === "search" || value === "command" || value === "file" || value === "read" || value === "reasoning" || value === "diagnostics" || value === "context" || value === "tool") {
        return value;
    }
    return "tool";
}
function normalizeWorklogStatus(value) {
    if (value === "completed" || value === "error") {
        return value;
    }
    return "running";
}
function normalizeWorklogSource(value) {
    if (value === "project" || value === "docs" || value === "web" || value === "shell" || value === "ide" || value === "runtime") {
        return value;
    }
    return undefined;
}
function normalizeWorklogChildren(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => {
        if (!isObject(item)) {
            return undefined;
        }
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
        const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "";
        const createdAt = typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString();
        if (!id || !title) {
            return undefined;
        }
        return {
            id,
            kind: normalizeWorklogOperationKind(item.kind),
            status: normalizeWorklogStatus(item.status),
            title,
            source: normalizeWorklogSource(item.source),
            query: typeof item.query === "string" ? item.query : undefined,
            path: typeof item.path === "string" ? item.path : undefined,
            command: typeof item.command === "string" ? item.command : undefined,
            resultCount: typeof item.resultCount === "number" && Number.isFinite(item.resultCount) ? item.resultCount : undefined,
            outputPreview: typeof item.outputPreview === "string" ? item.outputPreview : undefined,
            createdAt,
            completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined
        };
    })
        .filter((item) => Boolean(item));
}
function normalizeActivityDetails(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const details = value
        .map((item) => {
        if (!isObject(item)) {
            return undefined;
        }
        const label = typeof item.label === "string" ? item.label.trim() : "";
        if (!label) {
            return undefined;
        }
        return {
            activityKind: normalizeActivityKind(item.activityKind),
            label,
            status: item.status === "running" || item.status === "completed" || item.status === "error" ? item.status : undefined,
            command: typeof item.command === "string" ? item.command : undefined,
            path: typeof item.path === "string" ? item.path : undefined,
            summary: typeof item.summary === "string" ? item.summary : undefined,
            outputPreview: typeof item.outputPreview === "string" ? item.outputPreview : undefined
        };
    })
        .filter((item) => Boolean(item))
        .slice(0, 40);
    return details.length ? details : undefined;
}
function normalizeDiffFile(value) {
    if (!isObject(value) || typeof value.path !== "string" || !value.path) {
        return undefined;
    }
    return {
        path: value.path,
        oldPath: typeof value.oldPath === "string" && value.oldPath ? value.oldPath : undefined,
        newPath: typeof value.newPath === "string" && value.newPath ? value.newPath : undefined,
        status: normalizeDiffStatus(value.status),
        additions: typeof value.additions === "number" ? value.additions : 0,
        deletions: typeof value.deletions === "number" ? value.deletions : 0,
        diff: typeof value.diff === "string" ? value.diff : undefined,
        truncated: value.truncated === true
    };
}
function normalizeDiffStatus(value) {
    if (value === "added" || value === "modified" || value === "deleted" || value === "renamed" || value === "unknown") {
        return value;
    }
    return undefined;
}
function normalizeChatKind(value) {
    return value === "general" ? "general" : "project";
}
function normalizeChatStatus(value) {
    return value === "error" ? "error" : "idle";
}
function normalizeChatAccessMode(value, kind) {
    if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") {
        return value;
    }
    return kind === "project" ? "workspace-write" : "read-only";
}
function normalizeOptionalChatAccessMode(value) {
    if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") {
        return value;
    }
    return null;
}
function normalizeChatEffort(value) {
    if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
        return value;
    }
    return "medium";
}
function normalizeChatSpeed(value) {
    if (value === "standard" || value === "fast") {
        return value;
    }
    return "standard";
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
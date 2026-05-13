"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = void 0;
const FALLBACK_MODEL_OPTIONS = [
    { id: null, label: "5.5" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
    { id: "gpt-5.2", label: "GPT-5.2" }
];
const EMPTY_CONTEXT_WINDOW = {
    status: "unknown",
    usedTokens: null,
    maxTokens: null,
    usedPercent: null
};
class StateStore {
    constructor(onDidMutate) {
        this.onDidMutate = onDidMutate;
        this.version = 1;
        this.chats = [];
        this.transcripts = new Map();
        this.contextWindows = new Map();
        this.modelOptions = FALLBACK_MODEL_OPTIONS;
        this.modelOptionsStatus = "idle";
        this.chatHeaderMode = "collapsed";
        this.auth = {
            status: "notAuthenticated",
            accountLabel: "Не авторизованы",
            accountType: "none",
            message: "Выберите способ авторизации.",
            profileLabel: "-",
            deviceCode: {
                status: "idle",
                loginId: "",
                verificationUrl: "",
                userCode: ""
            },
            apiKey: {
                status: "idle"
            }
        };
        this.proxy = {
            status: "notConfigured",
            label: "Proxy не настроен"
        };
        this.docs = {
            status: "notConfigured",
            label: "Документация не настроена"
        };
        this.projectContext = {
            status: "notIndexed",
            label: "Проектный контекст будет собран при отправке"
        };
        this.rulesContext = {
            status: "missing",
            label: "Файл .local-codex/rules.md не найден"
        };
        this.runtime = {
            status: "notStarted",
            label: "Backend не запускался"
        };
        this.rateLimits = {
            status: "unknown",
            rows: []
        };
    }
    getSidebarSnapshot() {
        return {
            kind: "sidebar",
            version: this.version,
            auth: this.auth,
            proxy: this.proxy,
            docs: this.docs,
            projectContext: this.projectContext,
            rulesContext: this.rulesContext,
            runtime: this.runtime,
            rateLimits: this.rateLimits,
            chats: [...this.chats],
            activeChatId: this.activeChatId
        };
    }
    getPendingApprovalCount() {
        return this.chats.reduce((count, chat) => count + (chat.pendingApproval ? 1 : 0), 0);
    }
    setChatHeaderMode(mode) {
        if (this.chatHeaderMode === mode) {
            return;
        }
        this.chatHeaderMode = mode;
        this.version += 1;
    }
    getChatHeaderMode() {
        return this.chatHeaderMode;
    }
    setAuth(auth) {
        this.auth = {
            ...this.auth,
            ...auth,
            deviceCode: {
                ...this.auth.deviceCode,
                ...(auth.deviceCode ?? {})
            },
            apiKey: {
                ...this.auth.apiKey,
                ...(auth.apiKey ?? {})
            }
        };
        this.version += 1;
    }
    setProxy(proxy) {
        this.proxy = proxy;
        this.version += 1;
    }
    setDocs(docs) {
        this.docs = docs;
        this.version += 1;
    }
    setProjectContext(projectContext) {
        this.projectContext = projectContext;
        this.version += 1;
    }
    setRulesContext(rulesContext) {
        this.rulesContext = rulesContext;
        this.version += 1;
    }
    setRuntime(runtime) {
        this.runtime = runtime;
        this.version += 1;
    }
    setRateLimits(rateLimits) {
        this.rateLimits = rateLimits;
        this.version += 1;
    }
    setChatContextWindow(chatId, contextWindow) {
        if (!this.getChat(chatId)) {
            return;
        }
        this.contextWindows.set(chatId, contextWindow);
        this.version += 1;
    }
    getChatContextWindow(chatId) {
        return this.contextWindows.get(chatId) ?? EMPTY_CONTEXT_WINDOW;
    }
    getChatSnapshot(chatId) {
        const chat = this.chats.find((candidate) => candidate.id === chatId);
        if (!chat) {
            return undefined;
        }
        const sidebar = this.getSidebarSnapshot();
        return {
            kind: "chat",
            version: this.version,
            chatHeaderMode: this.chatHeaderMode,
            chat,
            auth: sidebar.auth,
            runtime: sidebar.runtime,
            docs: sidebar.docs,
            projectContext: sidebar.projectContext,
            rulesContext: sidebar.rulesContext,
            contextWindow: this.contextWindows.get(chat.id) ?? EMPTY_CONTEXT_WINDOW,
            modelOptions: this.modelOptions,
            modelOptionsStatus: this.modelOptionsStatus,
            transcript: this.transcripts.get(chat.id) ?? []
        };
    }
    getActiveChatId() {
        return this.activeChatId;
    }
    getActiveChatSnapshot() {
        return this.activeChatId ? this.getChatSnapshot(this.activeChatId) : undefined;
    }
    createChat(kind, title) {
        const now = new Date().toISOString();
        const nextNumber = this.chats.filter((chat) => chat.kind === kind).length + 1;
        const defaultTitle = kind === "project" ? `Проектный чат ${nextNumber}` : `Общий чат ${nextNumber}`;
        const chat = {
            id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            kind,
            title: title?.trim() || defaultTitle,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            lastReadAt: now,
            hasUnread: false,
            status: "idle",
            accessMode: kind === "project" ? "workspace-write" : "read-only",
            modelId: null,
            modelLabel: "5.5",
            effort: "medium",
            speed: "standard",
            rulesEnabled: kind === "project",
            pendingApproval: null,
            backendThreadAccessMode: null,
            backendThreadId: null,
            activeTurnId: null,
            activeRunMode: null
        };
        this.chats.unshift(chat);
        this.activeChatId = chat.id;
        this.transcripts.set(chat.id, [
            {
                id: `${chat.id}-system`,
                role: "system",
                text: kind === "project"
                    ? "Проектный чат будет использовать контекст проекта, документации и правил."
                    : "Общий чат не будет использовать проектный контекст без явного действия пользователя.",
                createdAt: now
            }
        ]);
        this.version += 1;
        this.emitMutation("immediate");
        return chat;
    }
    setActiveChat(chatId) {
        if (this.chats.some((chat) => chat.id === chatId)) {
            this.activeChatId = chatId;
            this.version += 1;
            this.emitMutation("debounced");
        }
    }
    clearActiveChat(chatId) {
        if (!this.activeChatId || (chatId && this.activeChatId !== chatId)) {
            return;
        }
        this.activeChatId = undefined;
        this.version += 1;
        this.emitMutation("immediate");
    }
    getChat(chatId) {
        return this.chats.find((chat) => chat.id === chatId);
    }
    archiveChat(chatId) {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        if (chat.archivedAt) {
            return chat;
        }
        const updated = {
            ...chat,
            archivedAt: new Date().toISOString(),
            hasUnread: false,
            pendingApproval: null
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        if (this.activeChatId === chatId) {
            this.activeChatId = undefined;
        }
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    restoreChat(chatId) {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        if (!chat.archivedAt) {
            this.activeChatId = chatId;
            this.version += 1;
            this.emitMutation("immediate");
            return chat;
        }
        const updated = {
            ...chat,
            archivedAt: null
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.activeChatId = chatId;
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    deleteChat(chatId) {
        const chat = this.getChat(chatId);
        if (!chat || !chat.archivedAt) {
            return false;
        }
        this.chats = this.chats.filter((candidate) => candidate.id !== chatId);
        this.transcripts.delete(chatId);
        this.contextWindows.delete(chatId);
        if (this.activeChatId === chatId) {
            this.activeChatId = undefined;
        }
        this.version += 1;
        this.emitMutation("immediate");
        return true;
    }
    renameChat(chatId, title) {
        const chat = this.getChat(chatId);
        const trimmed = title.trim();
        if (!chat || !trimmed) {
            return undefined;
        }
        if (chat.title === trimmed) {
            return chat;
        }
        const updated = {
            ...chat,
            title: trimmed
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    toggleChatRules(chatId) {
        const chat = this.getChat(chatId);
        if (!chat || chat.kind !== "project") {
            return undefined;
        }
        const updated = {
            ...chat,
            rulesEnabled: !chat.rulesEnabled
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    setChatAccessMode(chatId, accessMode) {
        const chat = this.getChat(chatId);
        if (!chat || chat.accessMode === accessMode) {
            return chat;
        }
        const updated = {
            ...chat,
            accessMode
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    setChatModel(chatId, modelId, modelLabel) {
        const chat = this.getChat(chatId);
        const label = modelLabel.trim() || "5.5";
        if (!chat || (chat.modelId === modelId && chat.modelLabel === label)) {
            return chat;
        }
        const updated = {
            ...chat,
            modelId,
            modelLabel: label
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    setChatEffort(chatId, effort) {
        const chat = this.getChat(chatId);
        if (!chat || chat.effort === effort) {
            return chat;
        }
        const updated = {
            ...chat,
            effort
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    setChatSpeed(chatId, speed) {
        const chat = this.getChat(chatId);
        if (!chat || chat.speed === speed) {
            return chat;
        }
        const updated = {
            ...chat,
            speed
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("immediate");
        return updated;
    }
    setModelOptions(options, status) {
        const normalized = normalizeModelOptions(options);
        this.modelOptions = normalized.length ? normalized : FALLBACK_MODEL_OPTIONS;
        this.modelOptionsStatus = status;
        this.version += 1;
    }
    setModelOptionsStatus(status) {
        this.modelOptionsStatus = status;
        this.version += 1;
    }
    setPendingApproval(chatId, pendingApproval) {
        const status = pendingApproval ? "waitingApproval" : this.getChat(chatId)?.status === "waitingApproval" ? "running" : undefined;
        return this.updateChat(chatId, {
            pendingApproval,
            ...(status ? { status } : {})
        }, "immediate");
    }
    updateChat(chatId, patch, mode = "debounced") {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        const updatedAt = new Date().toISOString();
        const updated = {
            ...chat,
            ...patch,
            updatedAt
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation(mode);
        return updated;
    }
    markChatRead(chatId) {
        const chat = this.getChat(chatId);
        if (!chat || !chat.hasUnread) {
            return false;
        }
        const updated = {
            ...chat,
            hasUnread: false,
            lastReadAt: chat.updatedAt
        };
        this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
        this.version += 1;
        this.emitMutation("debounced");
        return true;
    }
    addTranscriptItem(chatId, role, text, mode = "immediate") {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        const item = {
            id: `${chatId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role,
            text,
            createdAt: new Date().toISOString()
        };
        this.transcripts.set(chatId, [...(this.transcripts.get(chatId) ?? []), item]);
        this.updateChat(chatId, role === "user" ? {} : { hasUnread: true }, mode);
        return item;
    }
    appendAssistantDelta(chatId, delta) {
        const chat = this.getChat(chatId);
        if (!chat || !delta) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const last = transcript[transcript.length - 1];
        if (last?.role === "assistant") {
            const updatedLast = {
                ...last,
                text: `${last.text}${delta}`
            };
            this.transcripts.set(chatId, [...transcript.slice(0, -1), updatedLast]);
        }
        else {
            this.transcripts.set(chatId, [
                ...transcript,
                {
                    id: `${chatId}-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    role: "assistant",
                    text: delta,
                    createdAt: new Date().toISOString()
                }
            ]);
        }
        this.updateChat(chatId, { hasUnread: true }, "debounced");
    }
    setLastAssistantText(chatId, text) {
        const chat = this.getChat(chatId);
        if (!chat || !text) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const last = transcript[transcript.length - 1];
        if (last?.role === "assistant") {
            this.transcripts.set(chatId, [...transcript.slice(0, -1), { ...last, text }]);
        }
        else {
            this.transcripts.set(chatId, [
                ...transcript,
                {
                    id: `${chatId}-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    role: "assistant",
                    text,
                    createdAt: new Date().toISOString()
                }
            ]);
        }
        this.updateChat(chatId, { hasUnread: true }, "immediate");
    }
    findChatByTurnId(turnId) {
        return this.chats.find((chat) => chat.activeTurnId === turnId);
    }
    hasChats() {
        return this.chats.length > 0;
    }
    replaceChatHistory(history) {
        this.contextWindows.clear();
        this.chats = history?.chats.map((chat) => ({
            ...chat,
            archivedAt: chat.archivedAt ?? null,
            lastReadAt: chat.lastReadAt || chat.updatedAt,
            hasUnread: Boolean(chat.hasUnread),
            accessMode: chat.accessMode ?? (chat.kind === "project" ? "workspace-write" : "read-only"),
            modelId: typeof chat.modelId === "string" ? chat.modelId : null,
            modelLabel: chat.modelLabel || "5.5",
            effort: chat.effort ?? "medium",
            speed: chat.speed ?? "standard",
            rulesEnabled: chat.kind === "project" ? chat.rulesEnabled !== false : false,
            pendingApproval: null,
            backendThreadAccessMode: chat.backendThreadAccessMode ?? null,
            status: "idle",
            activeTurnId: null,
            activeRunMode: null
        })) ?? [];
        this.activeChatId = history?.activeChatId && this.chats.some((chat) => chat.id === history.activeChatId)
            ? history.activeChatId
            : this.chats[0]?.id;
        this.transcripts = new Map(Object.entries(history?.transcripts ?? {})
            .filter(([chatId]) => this.chats.some((chat) => chat.id === chatId)));
        this.version += 1;
    }
    exportChatHistory() {
        const transcripts = {};
        for (const chat of this.chats) {
            transcripts[chat.id] = this.transcripts.get(chat.id) ?? [];
        }
        const chats = this.chats.map((chat) => ({
            ...chat,
            pendingApproval: null,
            status: chat.status === "waitingApproval" || chat.status === "running" || chat.status === "cancelling" ? "idle" : chat.status,
            activeTurnId: null,
            activeRunMode: null
        }));
        return {
            version: 1,
            activeChatId: this.activeChatId,
            chats,
            transcripts
        };
    }
    emitMutation(mode) {
        this.onDidMutate?.(mode);
    }
}
exports.StateStore = StateStore;
function normalizeModelOptions(options) {
    const seen = new Set();
    const normalized = [];
    for (const option of options) {
        const label = option.label.trim();
        if (!label) {
            continue;
        }
        const id = option.id?.trim() || null;
        const key = `${id ?? "<default>"}:${label}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push({ id, label });
    }
    return normalized;
}
//# sourceMappingURL=stateStore.js.map
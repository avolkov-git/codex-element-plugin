"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = void 0;
class StateStore {
    constructor(onDidMutate) {
        this.onDidMutate = onDidMutate;
        this.version = 1;
        this.chats = [];
        this.transcripts = new Map();
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
            chats: [...this.chats],
            activeChatId: this.activeChatId
        };
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
    getChatSnapshot(chatId) {
        const chat = this.chats.find((candidate) => candidate.id === chatId);
        if (!chat) {
            return undefined;
        }
        const sidebar = this.getSidebarSnapshot();
        return {
            kind: "chat",
            version: this.version,
            chat,
            auth: sidebar.auth,
            runtime: sidebar.runtime,
            docs: sidebar.docs,
            projectContext: sidebar.projectContext,
            rulesContext: sidebar.rulesContext,
            transcript: this.transcripts.get(chat.id) ?? [],
            shellNotice: "Read-only режим: Codex отвечает в чате, но approvals, diff и правки файлов пока отключены."
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
            lastReadAt: now,
            hasUnread: false,
            status: "idle",
            accessMode: kind === "project" ? "workspace-write" : "read-only",
            rulesEnabled: kind === "project",
            pendingApproval: null,
            backendThreadId: null,
            activeTurnId: null
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
    getChat(chatId) {
        return this.chats.find((chat) => chat.id === chatId);
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
        this.chats = history?.chats.map((chat) => ({
            ...chat,
            lastReadAt: chat.lastReadAt || chat.updatedAt,
            hasUnread: Boolean(chat.hasUnread),
            accessMode: chat.accessMode ?? (chat.kind === "project" ? "workspace-write" : "read-only"),
            rulesEnabled: chat.kind === "project" ? chat.rulesEnabled !== false : false,
            pendingApproval: null,
            status: "idle",
            activeTurnId: null
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
            status: chat.status === "waitingApproval" || chat.status === "running" ? "idle" : chat.status,
            activeTurnId: null
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
//# sourceMappingURL=stateStore.js.map
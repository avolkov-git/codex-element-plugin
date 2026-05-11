"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = void 0;
class StateStore {
    constructor() {
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
            transcript: this.transcripts.get(chat.id) ?? [],
            shellNotice: "Это UI shell. Реальный Codex runtime, streaming и approvals появятся в следующих итерациях."
        };
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
            status: "idle"
        };
        this.chats.unshift(chat);
        this.activeChatId = chat.id;
        this.transcripts.set(chat.id, [
            {
                id: `${chat.id}-system`,
                role: "system",
                text: kind === "project"
                    ? "Проектный чат будет использовать контекст проекта, документации, библиотек и правил."
                    : "Общий чат не будет использовать проектный контекст без явного действия пользователя.",
                createdAt: now
            }
        ]);
        this.version += 1;
        return chat;
    }
    setActiveChat(chatId) {
        if (this.chats.some((chat) => chat.id === chatId)) {
            this.activeChatId = chatId;
            this.version += 1;
        }
    }
    getChat(chatId) {
        return this.chats.find((chat) => chat.id === chatId);
    }
}
exports.StateStore = StateStore;
//# sourceMappingURL=stateStore.js.map
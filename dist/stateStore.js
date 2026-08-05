"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = exports.TRANSCRIPT_MAX_WINDOW_REQUEST_SIZE = exports.TRANSCRIPT_PAGE_SIZE = exports.TRANSCRIPT_INITIAL_WINDOW_SIZE = void 0;
exports.TRANSCRIPT_INITIAL_WINDOW_SIZE = 120;
exports.TRANSCRIPT_PAGE_SIZE = 40;
exports.TRANSCRIPT_MAX_WINDOW_REQUEST_SIZE = 200;
function normalizeTranscriptBoundaryOffset(value, transcriptLength) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return -1;
    }
    return Math.max(0, Math.min(Math.trunc(value), Math.max(0, transcriptLength - 1)));
}
const FALLBACK_MODEL_OPTIONS = [
    { id: null, label: "Авто", description: "Модель по умолчанию Codex" }
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
            transcriptWindow: this.getTranscriptTail(chat.id),
            activeClarification: this.getActiveClarification(chat.id)
        };
    }
    getActiveChatId() {
        return this.activeChatId;
    }
    getActiveChatSnapshot() {
        return this.activeChatId ? this.getChatSnapshot(this.activeChatId) : undefined;
    }
    getTranscriptTail(chatId, count = exports.TRANSCRIPT_INITIAL_WINDOW_SIZE) {
        const transcript = this.transcripts.get(chatId) ?? [];
        const safeCount = normalizeTranscriptWindowCount(count, exports.TRANSCRIPT_INITIAL_WINDOW_SIZE);
        return this.buildTranscriptWindow(chatId, Math.max(0, transcript.length - safeCount), transcript.length);
    }
    getTranscriptBefore(chatId, beforeItemId, count = exports.TRANSCRIPT_PAGE_SIZE, beforeOffset) {
        const transcript = this.transcripts.get(chatId) ?? [];
        const itemIndex = transcript.findIndex((item) => item.id === beforeItemId);
        const index = itemIndex >= 0
            ? itemIndex
            : normalizeTranscriptBoundaryOffset(beforeOffset, transcript.length);
        if (index < 0) {
            return this.buildTranscriptWindow(chatId, 0, 0);
        }
        const safeCount = normalizeTranscriptWindowCount(count, exports.TRANSCRIPT_PAGE_SIZE);
        return this.buildTranscriptWindow(chatId, Math.max(0, index - safeCount), index);
    }
    getTranscriptAfter(chatId, afterItemId, count = exports.TRANSCRIPT_PAGE_SIZE, afterOffset) {
        const transcript = this.transcripts.get(chatId) ?? [];
        const itemIndex = transcript.findIndex((item) => item.id === afterItemId);
        const index = itemIndex >= 0
            ? itemIndex
            : normalizeTranscriptBoundaryOffset(afterOffset, transcript.length);
        if (index < 0) {
            return this.buildTranscriptWindow(chatId, transcript.length, transcript.length);
        }
        const safeCount = normalizeTranscriptWindowCount(count, exports.TRANSCRIPT_PAGE_SIZE);
        return this.buildTranscriptWindow(chatId, index + 1, Math.min(transcript.length, index + 1 + safeCount));
    }
    getActiveClarification(chatId) {
        const chat = this.getChat(chatId);
        if (!chat || chat.status !== "idle") {
            return undefined;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        for (let index = transcript.length - 1; index >= 0; index -= 1) {
            const item = transcript[index];
            if (item.kind === "message" && item.role === "user") {
                return undefined;
            }
            if (item.kind === "clarification") {
                return item;
            }
        }
        return undefined;
    }
    getDiffFile(chatId, diffId, fileIndex) {
        const transcript = this.transcripts.get(chatId) ?? [];
        const item = transcript.find((entry) => entry.kind === "diff" && entry.id === diffId);
        if (!item || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= item.files.length) {
            return undefined;
        }
        return { item, file: item.files[fileIndex] };
    }
    buildTranscriptWindow(chatId, start, end) {
        const transcript = this.transcripts.get(chatId) ?? [];
        const normalizedStart = Math.max(0, Math.min(start, transcript.length));
        const normalizedEnd = Math.max(normalizedStart, Math.min(end, transcript.length));
        const items = transcript.slice(normalizedStart, normalizedEnd);
        return {
            items,
            offset: normalizedStart,
            totalCount: transcript.length,
            hasBefore: normalizedStart > 0,
            hasAfter: normalizedEnd < transcript.length,
            firstItemId: items[0]?.id,
            lastItemId: items[items.length - 1]?.id
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
            archivedAt: null,
            lastReadAt: now,
            hasUnread: false,
            status: "idle",
            accessMode: kind === "project" ? "workspace-write" : "read-only",
            modelId: null,
            modelLabel: "Авто",
            effort: "medium",
            speed: "standard",
            queuedMessages: [],
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
                kind: "message",
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
        const label = modelLabel.trim() || "Авто";
        if (!chat) {
            return chat;
        }
        const option = this.resolveModelOption(modelId);
        const effort = reconcileEffort(chat.effort, option);
        const speed = chat.speed === "fast" && !option?.serviceTiers?.length ? "standard" : chat.speed;
        if (chat.modelId === modelId && chat.modelLabel === label && chat.effort === effort && chat.speed === speed) {
            return chat;
        }
        const updated = {
            ...chat,
            modelId,
            modelLabel: label,
            effort,
            speed
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
    enqueueChatMessage(chatId, text, mode, skills = [], attachments = []) {
        const chat = this.getChat(chatId);
        const normalized = text.trim();
        if (!chat || (!normalized && !attachments.length)) {
            return undefined;
        }
        const queued = {
            id: `queued-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text: normalized,
            mode,
            skills: skills.map((skill) => ({ name: skill.name, path: skill.path })),
            attachments: attachments.map((attachment) => ({ ...attachment })),
            createdAt: new Date().toISOString()
        };
        this.updateChat(chatId, { queuedMessages: [...chat.queuedMessages, queued] }, "immediate");
        return queued;
    }
    removeQueuedChatMessage(chatId, messageId) {
        const chat = this.getChat(chatId);
        if (!chat || !chat.queuedMessages.some((message) => message.id === messageId)) {
            return false;
        }
        this.updateChat(chatId, {
            queuedMessages: chat.queuedMessages.filter((message) => message.id !== messageId)
        }, "immediate");
        return true;
    }
    moveQueuedChatMessage(chatId, messageId, direction) {
        const chat = this.getChat(chatId);
        if (!chat) {
            return false;
        }
        const currentIndex = chat.queuedMessages.findIndex((message) => message.id === messageId);
        const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= chat.queuedMessages.length) {
            return false;
        }
        const queuedMessages = [...chat.queuedMessages];
        [queuedMessages[currentIndex], queuedMessages[targetIndex]] = [queuedMessages[targetIndex], queuedMessages[currentIndex]];
        this.updateChat(chatId, { queuedMessages }, "immediate");
        return true;
    }
    shiftQueuedChatMessage(chatId) {
        const chat = this.getChat(chatId);
        const queued = chat?.queuedMessages[0];
        if (!chat || !queued) {
            return undefined;
        }
        this.updateChat(chatId, { queuedMessages: chat.queuedMessages.slice(1) }, "immediate");
        return queued;
    }
    setModelOptions(options, status) {
        const normalized = normalizeModelOptions(options);
        this.modelOptions = normalized.length ? normalized : FALLBACK_MODEL_OPTIONS;
        this.chats = this.chats.map((chat) => {
            const option = this.resolveModelOption(chat.modelId);
            return {
                ...chat,
                effort: reconcileEffort(chat.effort, option),
                speed: chat.speed === "fast" && !option?.serviceTiers?.length ? "standard" : chat.speed
            };
        });
        this.modelOptionsStatus = status;
        this.version += 1;
    }
    getModelOptionForChat(chatId) {
        const chat = this.getChat(chatId);
        return chat ? this.resolveModelOption(chat.modelId) : undefined;
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
    detachBackendThreads() {
        let detachedCount = 0;
        this.chats = this.chats.map((chat) => {
            if (!chat.backendThreadId && !chat.backendThreadAccessMode) {
                return chat;
            }
            detachedCount += 1;
            return {
                ...chat,
                backendThreadId: null,
                backendThreadAccessMode: null,
                activeTurnId: null,
                activeRunMode: null,
                pendingApproval: null,
                status: chat.status === "error" ? "error" : "idle"
            };
        });
        if (detachedCount > 0) {
            this.version += 1;
            this.emitMutation("immediate");
        }
        return detachedCount;
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
    addTranscriptItem(chatId, role, text, mode = "immediate", turnId, attachments = []) {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        const item = {
            kind: "message",
            id: `${chatId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role,
            text,
            createdAt: new Date().toISOString(),
            status: "complete",
            turnId,
            attachments: attachments.length ? attachments.map((attachment) => ({ ...attachment })) : undefined
        };
        this.transcripts.set(chatId, [...(this.transcripts.get(chatId) ?? []), item]);
        this.updateChat(chatId, role === "user" ? {} : { hasUnread: true }, mode);
        return item;
    }
    appendAssistantDelta(chatId, delta, turnId) {
        const chat = this.getChat(chatId);
        if (!chat || !delta) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const streamingIndex = findLastStreamingAssistantMessageIndex(transcript, turnId);
        if (streamingIndex >= 0) {
            const last = transcript[streamingIndex];
            const updatedLast = {
                ...last,
                text: `${last.text}${delta}`,
                turnId: last.turnId ?? turnId,
                status: "streaming"
            };
            this.transcripts.set(chatId, [
                ...transcript.slice(0, streamingIndex),
                updatedLast,
                ...transcript.slice(streamingIndex + 1)
            ]);
        }
        else {
            this.transcripts.set(chatId, [
                ...transcript,
                {
                    kind: "message",
                    id: `${chatId}-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    role: "assistant",
                    text: delta,
                    createdAt: new Date().toISOString(),
                    turnId,
                    status: "streaming"
                }
            ]);
        }
        this.updateChat(chatId, { hasUnread: true }, "debounced");
    }
    setLastAssistantText(chatId, text, turnId) {
        const chat = this.getChat(chatId);
        if (!chat || !text) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = findLastAssistantMessageIndex(transcript, turnId);
        if (index >= 0) {
            const existing = transcript[index];
            this.transcripts.set(chatId, [
                ...transcript.slice(0, index),
                { ...existing, text, turnId: existing.turnId ?? turnId, status: "complete", completedAt: new Date().toISOString() },
                ...transcript.slice(index + 1)
            ]);
        }
        else {
            this.transcripts.set(chatId, [
                ...transcript,
                {
                    kind: "message",
                    id: `${chatId}-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    role: "assistant",
                    text,
                    createdAt: new Date().toISOString(),
                    turnId,
                    status: "complete",
                    completedAt: new Date().toISOString()
                }
            ]);
        }
        this.updateChat(chatId, { hasUnread: true }, "immediate");
    }
    removeLastStreamingAssistantMessage(chatId, turnId, mode = "debounced") {
        if (!this.getChat(chatId)) {
            return false;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = findLastStreamingAssistantMessageIndex(transcript, turnId);
        if (index < 0) {
            return false;
        }
        this.transcripts.set(chatId, [
            ...transcript.slice(0, index),
            ...transcript.slice(index + 1)
        ]);
        this.emitMutation(mode);
        return true;
    }
    addOrUpdateActivityItem(chatId, patch, mode = "debounced") {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        const now = new Date().toISOString();
        const transcript = this.transcripts.get(chatId) ?? [];
        const existingIndex = transcript.findIndex((item) => item.kind === "activity" && item.id === patch.id);
        const existing = existingIndex >= 0 ? transcript[existingIndex] : undefined;
        const item = {
            ...(existing ?? {
                kind: "activity",
                id: patch.id,
                activityKind: patch.activityKind,
                label: patch.label,
                status: patch.status,
                createdAt: now
            }),
            ...patch,
            updatedAt: now,
            completedAt: patch.status === "completed" || patch.status === "error" ? now : existing?.completedAt
        };
        item.details = mergeActivityDetails(existing?.details, patch.details);
        if (existingIndex >= 0) {
            this.transcripts.set(chatId, [
                ...transcript.slice(0, existingIndex),
                item,
                ...transcript.slice(existingIndex + 1)
            ]);
        }
        else {
            this.transcripts.set(chatId, [...transcript, item]);
        }
        if (patch.turnId) {
            this.linkTurnRunItem(chatId, patch.turnId, {
                status: patch.activityKind === "turn" ? item.status : undefined,
                activityIds: patch.activityKind === "turn" ? [] : [item.id]
            });
        }
        this.updateChat(chatId, { hasUnread: true }, mode);
        return item;
    }
    appendActivityOutput(chatId, activityId, delta, mode = "debounced") {
        if (!this.getChat(chatId) || !delta) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = transcript.findIndex((item) => item.kind === "activity" && item.id === activityId);
        if (index < 0) {
            return;
        }
        const existing = transcript[index];
        const output = `${existing.outputPreview ?? ""}${delta}`;
        const detailOutput = appendActivityDetailOutput(existing, delta);
        const updated = {
            ...existing,
            outputPreview: existing.activityKind === "command" ? existing.outputPreview : limitActivityOutput(output),
            details: detailOutput,
            updatedAt: new Date().toISOString()
        };
        this.transcripts.set(chatId, [...transcript.slice(0, index), updated, ...transcript.slice(index + 1)]);
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addOrUpdateWorklogItem(chatId, patch, mode = "debounced") {
        const chat = this.getChat(chatId);
        if (!chat) {
            return undefined;
        }
        const now = new Date().toISOString();
        const transcript = this.transcripts.get(chatId) ?? [];
        const existingIndex = transcript.findIndex((item) => item.kind === "worklog" && item.id === patch.id);
        const existing = existingIndex >= 0 ? transcript[existingIndex] : undefined;
        const item = {
            ...(existing ?? {
                kind: "worklog",
                id: patch.id,
                operationKind: patch.operationKind,
                status: patch.status,
                title: patch.title,
                createdAt: now,
                children: []
            }),
            ...patch,
            children: mergeWorklogChildren(existing?.children, patch.children),
            updatedAt: now,
            completedAt: patch.status === "completed" || patch.status === "error" ? now : existing?.completedAt
        };
        if (existingIndex >= 0) {
            this.transcripts.set(chatId, [
                ...transcript.slice(0, existingIndex),
                item,
                ...transcript.slice(existingIndex + 1)
            ]);
        }
        else {
            this.transcripts.set(chatId, [...transcript, item]);
        }
        if (patch.turnId) {
            this.linkTurnRunItem(chatId, patch.turnId, { worklogIds: [item.id] });
        }
        this.updateChat(chatId, { hasUnread: true }, mode);
        return item;
    }
    appendWorklogChildOutput(chatId, worklogId, childId, delta, mode = "debounced") {
        if (!this.getChat(chatId) || !delta) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = transcript.findIndex((item) => item.kind === "worklog" && item.id === worklogId);
        if (index < 0) {
            return;
        }
        const existing = transcript[index];
        const children = existing.children.map((child) => child.id === childId
            ? {
                ...child,
                outputPreview: limitActivityOutput(`${child.outputPreview ?? ""}${delta}`)
            }
            : child);
        const updated = {
            ...existing,
            children,
            updatedAt: new Date().toISOString()
        };
        this.transcripts.set(chatId, [...transcript.slice(0, index), updated, ...transcript.slice(index + 1)]);
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addOrUpdateDiffItem(chatId, turnId, title, files, mode = "debounced") {
        if (!this.getChat(chatId) || files.length === 0) {
            return;
        }
        const id = turnId ? `diff-${turnId}` : `${chatId}-diff`;
        const now = new Date().toISOString();
        const additions = files.reduce((sum, file) => sum + file.additions, 0);
        const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = transcript.findIndex((item) => item.kind === "diff" && item.id === id);
        const item = {
            kind: "diff",
            id,
            title,
            additions,
            deletions,
            files,
            createdAt: index >= 0 ? transcript[index].createdAt : now,
            updatedAt: now,
            turnId
        };
        this.transcripts.set(chatId, index >= 0
            ? [...transcript.slice(0, index), item, ...transcript.slice(index + 1)]
            : [...transcript, item]);
        if (turnId) {
            this.linkTurnRunItem(chatId, turnId, { diffIds: [id] });
        }
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addOrUpdatePlanItem(chatId, turnId, markdown, mode = "debounced") {
        if (!this.getChat(chatId) || !markdown.trim()) {
            return;
        }
        const id = turnId ? `plan-${turnId}` : `${chatId}-plan`;
        const now = new Date().toISOString();
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = transcript.findIndex((item) => item.kind === "plan" && item.id === id);
        const item = {
            kind: "plan",
            id,
            markdown,
            createdAt: index >= 0 ? transcript[index].createdAt : now,
            updatedAt: now,
            turnId
        };
        this.transcripts.set(chatId, index >= 0
            ? [...transcript.slice(0, index), item, ...transcript.slice(index + 1)]
            : [...transcript, item]);
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addOrUpdateClarificationItem(chatId, turnId, question, options, mode = "immediate") {
        if (!this.getChat(chatId) || !question.trim()) {
            return;
        }
        const id = turnId ? `clarification-${turnId}` : `${chatId}-clarification`;
        const now = new Date().toISOString();
        const transcript = this.transcripts.get(chatId) ?? [];
        const index = transcript.findIndex((item) => item.kind === "clarification" && item.id === id);
        const normalizedOptions = options
            .map((option) => ({
            title: option.title.trim(),
            description: option.description?.trim() || undefined,
            answer: option.answer.trim()
        }))
            .filter((option) => option.title && option.answer)
            .slice(0, 5);
        const item = {
            kind: "clarification",
            id,
            question: question.trim(),
            options: normalizedOptions,
            createdAt: index >= 0 ? transcript[index].createdAt : now,
            updatedAt: now,
            turnId
        };
        this.transcripts.set(chatId, index >= 0
            ? [...transcript.slice(0, index), item, ...transcript.slice(index + 1)]
            : [...transcript, item]);
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addCompactionItem(chatId, label = "Контекст автоматически сжат", mode = "immediate", turnId) {
        if (!this.getChat(chatId)) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const now = Date.now();
        const hasRecentMarker = transcript.some((item) => {
            if (item.kind !== "compaction" || item.label !== label) {
                return false;
            }
            const createdAt = Date.parse(item.createdAt);
            return Number.isFinite(createdAt) && now - createdAt < 5 * 60000;
        });
        if (hasRecentMarker) {
            return;
        }
        const item = {
            kind: "compaction",
            id: `${chatId}-compaction-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            label,
            createdAt: new Date().toISOString(),
            turnId
        };
        this.transcripts.set(chatId, [
            ...transcript,
            item
        ]);
        if (turnId) {
            this.linkTurnRunItem(chatId, turnId, { compactionIds: [item.id] });
        }
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addConnectionItem(chatId, message, status, attempt, maxAttempts, mode = "debounced") {
        if (!this.getChat(chatId)) {
            return;
        }
        const transcript = this.transcripts.get(chatId) ?? [];
        const id = `connection-${chatId}`;
        const now = new Date().toISOString();
        const index = transcript.findIndex((item) => item.kind === "connection" && item.id === id);
        const existing = index >= 0 ? transcript[index] : undefined;
        const item = {
            kind: "connection",
            id,
            message,
            status,
            attempt,
            maxAttempts,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
        };
        this.transcripts.set(chatId, index >= 0
            ? [...transcript.slice(0, index), item, ...transcript.slice(index + 1)]
            : [...transcript, item]);
        this.updateChat(chatId, { hasUnread: true }, mode);
    }
    addErrorItem(chatId, message, details, mode = "immediate") {
        if (!this.getChat(chatId)) {
            return;
        }
        this.transcripts.set(chatId, [
            ...(this.transcripts.get(chatId) ?? []),
            {
                kind: "error",
                id: `${chatId}-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                message,
                details,
                createdAt: new Date().toISOString()
            }
        ]);
        this.updateChat(chatId, { hasUnread: true }, mode);
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
            modelLabel: typeof chat.modelId === "string" ? chat.modelLabel || chat.modelId : "Авто",
            effort: chat.effort ?? "medium",
            speed: chat.speed ?? "standard",
            queuedMessages: Array.isArray(chat.queuedMessages) ? chat.queuedMessages : [],
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
    linkTurnRunItem(chatId, turnId, patch) {
        if (!turnId) {
            return;
        }
        const now = new Date().toISOString();
        const transcript = this.transcripts.get(chatId) ?? [];
        const id = `turn-run-${turnId}`;
        const existingIndex = transcript.findIndex((item) => item.kind === "turn-run" && item.id === id);
        const existing = existingIndex >= 0 ? transcript[existingIndex] : undefined;
        const status = patch.status ?? existing?.status ?? "running";
        const item = {
            ...(existing ?? {
                kind: "turn-run",
                id,
                turnId,
                status,
                createdAt: now,
                activityIds: [],
                worklogIds: [],
                diffIds: [],
                compactionIds: []
            }),
            status,
            updatedAt: now,
            completedAt: status === "completed" || status === "error" ? now : existing?.completedAt,
            activityIds: mergeUniqueStrings(existing?.activityIds, patch.activityIds),
            worklogIds: mergeUniqueStrings(existing?.worklogIds, patch.worklogIds),
            diffIds: mergeUniqueStrings(existing?.diffIds, patch.diffIds),
            compactionIds: mergeUniqueStrings(existing?.compactionIds, patch.compactionIds)
        };
        item.counts = buildTurnRunCounts(item, transcript);
        if (existingIndex >= 0) {
            this.transcripts.set(chatId, [
                ...transcript.slice(0, existingIndex),
                item,
                ...transcript.slice(existingIndex + 1)
            ]);
        }
        else {
            this.transcripts.set(chatId, [...transcript, item]);
        }
    }
    resolveModelOption(modelId) {
        if (modelId) {
            return this.modelOptions.find((option) => option.id === modelId);
        }
        return this.modelOptions.find((option) => option.id === null)
            ?? this.modelOptions.find((option) => option.isDefault);
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
        normalized.push({
            ...option,
            id,
            label,
            supportedEfforts: option.supportedEfforts?.filter((effort) => isChatEffort(effort.value)),
            defaultEffort: isChatEffort(option.defaultEffort) ? option.defaultEffort : undefined,
            serviceTiers: option.serviceTiers?.filter((tier) => tier.id.trim()).map((tier) => ({
                id: tier.id.trim(),
                label: tier.label.trim() || tier.id.trim(),
                description: tier.description.trim()
            }))
        });
    }
    return normalized;
}
function reconcileEffort(current, option) {
    const supported = option?.supportedEfforts;
    if (!supported?.length || supported.some((candidate) => candidate.value === current)) {
        return current;
    }
    return option?.defaultEffort ?? supported[0]?.value ?? "medium";
}
function isChatEffort(value) {
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";
}
function normalizeTranscriptWindowCount(count, fallback) {
    if (!Number.isFinite(count)) {
        return fallback;
    }
    return Math.max(1, Math.min(exports.TRANSCRIPT_MAX_WINDOW_REQUEST_SIZE, Math.floor(count)));
}
function mergeActivityDetails(existing, next) {
    if (!existing?.length) {
        return next?.length ? next : undefined;
    }
    if (!next?.length) {
        return existing;
    }
    const merged = next.map((detail, index) => ({
        ...existing[index],
        ...detail,
        outputPreview: detail.outputPreview ?? existing[index]?.outputPreview
    }));
    if (existing.length > next.length) {
        merged.push(...existing.slice(next.length));
    }
    return merged;
}
function appendActivityDetailOutput(item, delta) {
    const details = item.details?.length
        ? item.details
        : [{
                activityKind: item.activityKind,
                label: item.label,
                status: item.status,
                command: item.command,
                path: item.path,
                summary: item.summary,
                outputPreview: item.outputPreview
            }];
    const target = details[0] ?? {
        activityKind: item.activityKind,
        label: item.label,
        status: item.status
    };
    return [
        {
            ...target,
            outputPreview: limitActivityOutput(`${target.outputPreview ?? ""}${delta}`)
        },
        ...details.slice(1)
    ];
}
function mergeWorklogChildren(existing, next) {
    const merged = new Map();
    for (const child of existing ?? []) {
        merged.set(child.id, child);
    }
    for (const child of next ?? []) {
        const current = merged.get(child.id);
        merged.set(child.id, {
            ...(current ?? child),
            ...child,
            createdAt: current?.createdAt ?? child.createdAt,
            outputPreview: child.outputPreview ?? current?.outputPreview,
            completedAt: child.completedAt ?? current?.completedAt
        });
    }
    return [...merged.values()];
}
function mergeUniqueStrings(existing, next) {
    const result = [];
    const seen = new Set();
    for (const value of [...(existing ?? []), ...(next ?? [])]) {
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
}
function buildTurnRunCounts(turnRun, transcript) {
    const counts = {};
    const byId = new Map(transcript.map((item) => [item.id, item]));
    for (const id of turnRun.worklogIds) {
        const item = byId.get(id);
        if (item?.kind === "worklog") {
            counts[item.operationKind] = (counts[item.operationKind] ?? 0) + Math.max(1, item.children?.length || 0);
        }
    }
    for (const id of turnRun.activityIds) {
        const item = byId.get(id);
        if (item?.kind === "activity" && item.activityKind !== "turn" && item.activityKind !== "unknown") {
            const kind = activityKindToTurnRunCounter(item.activityKind);
            if (kind) {
                counts[kind] = (counts[kind] ?? 0) + 1;
            }
        }
    }
    if (turnRun.diffIds.length) {
        counts.diff = turnRun.diffIds.length;
    }
    if (turnRun.compactionIds.length) {
        counts.compaction = turnRun.compactionIds.length;
    }
    return counts;
}
function activityKindToTurnRunCounter(kind) {
    if (kind === "command" || kind === "file" || kind === "search" || kind === "reasoning" || kind === "context" || kind === "tool") {
        return kind;
    }
    return undefined;
}
function limitActivityOutput(output) {
    return output.length > 1200 ? output.slice(output.length - 1200) : output;
}
function findLastAssistantMessageIndex(items, turnId) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.kind === "message" && item.role === "assistant" && (!turnId || !item.turnId || item.turnId === turnId)) {
            return index;
        }
    }
    return -1;
}
function findLastStreamingAssistantMessageIndex(items, turnId) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.kind === "message" && item.role === "assistant" && item.status === "streaming" && (!turnId || !item.turnId || item.turnId === turnId)) {
            return index;
        }
    }
    return -1;
}
//# sourceMappingURL=stateStore.js.map
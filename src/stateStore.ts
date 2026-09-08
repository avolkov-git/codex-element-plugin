import { ChatActivityDetail, ChatActivityKind, ChatActivityTranscriptItem, ChatAttachment, ChatClarificationOption, ChatClarificationTranscriptItem, ChatDiffFileSummary, ChatDiffTranscriptItem, ChatEffort, ChatHeaderMode, ChatKind, ChatMessageTranscriptItem, ChatPanelSnapshot, ChatQueuedMessage, ChatRunMode, ChatSpeed, ChatSummary, ChatTranscriptItem, ChatTranscriptWindow, ChatTurnRunCounterKind, ChatTurnRunTranscriptItem, ChatWorklogTranscriptItem, ContextWindowUsage, ModelOption, PersistedChatHistory, SidebarSnapshot, WorklogChild } from "./types";

type AuthPatch = Omit<Partial<SidebarSnapshot["auth"]>, "deviceCode" | "apiKey"> & {
  deviceCode?: Partial<SidebarSnapshot["auth"]["deviceCode"]>;
  apiKey?: Partial<SidebarSnapshot["auth"]["apiKey"]>;
};

export type StateMutationMode = "debounced" | "immediate";

export const TRANSCRIPT_INITIAL_WINDOW_SIZE = 120;
export const TRANSCRIPT_PAGE_SIZE = 40;
export const TRANSCRIPT_MAX_WINDOW_REQUEST_SIZE = 200;

function normalizeTranscriptBoundaryOffset(value: number | undefined, transcriptLength: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  return Math.max(0, Math.min(Math.trunc(value), Math.max(0, transcriptLength - 1)));
}

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { id: null, label: "Авто", description: "Модель по умолчанию Codex" }
];

const EMPTY_CONTEXT_WINDOW: ContextWindowUsage = {
  status: "unknown",
  usedTokens: null,
  maxTokens: null,
  usedPercent: null
};

export class StateStore {
  private version = 1;
  private activeChatId: string | undefined;
  private chats: ChatSummary[] = [];
  private transcripts = new Map<string, ChatTranscriptItem[]>();
  private contextWindows = new Map<string, ContextWindowUsage>();
  private modelOptions: ModelOption[] = FALLBACK_MODEL_OPTIONS;
  private modelOptionsStatus: ChatPanelSnapshot["modelOptionsStatus"] = "idle";
  private chatHeaderMode: ChatHeaderMode = "collapsed";
  private auth: SidebarSnapshot["auth"] = {
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
  private proxy: SidebarSnapshot["proxy"] = {
    status: "notConfigured",
    label: "Proxy не настроен"
  };
  private docs: SidebarSnapshot["docs"] = {
    status: "notConfigured",
    label: "Документация не настроена"
  };
  private projectContext: SidebarSnapshot["projectContext"] = {
    status: "notIndexed",
    label: "Проектный контекст будет собран при отправке"
  };
  private rulesContext: SidebarSnapshot["rulesContext"] = {
    status: "missing",
    label: "Файл .local-codex/rules.md не найден"
  };
  private runtime: SidebarSnapshot["runtime"] = {
    status: "notStarted",
    label: "Backend не запускался"
  };
  private rateLimits: SidebarSnapshot["rateLimits"] = {
    status: "unknown",
    rows: []
  };

  constructor(private readonly onDidMutate?: (mode: StateMutationMode) => void) {}

  getSidebarSnapshot(): SidebarSnapshot {
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

  getPendingApprovalCount(): number {
    return this.chats.reduce((count, chat) => count + (chat.pendingApproval ? 1 : 0), 0);
  }

  setChatHeaderMode(mode: ChatHeaderMode): void {
    if (this.chatHeaderMode === mode) {
      return;
    }
    this.chatHeaderMode = mode;
    this.version += 1;
  }

  getChatHeaderMode(): ChatHeaderMode {
    return this.chatHeaderMode;
  }

  setAuth(auth: AuthPatch): void {
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

  setProxy(proxy: SidebarSnapshot["proxy"]): void {
    this.proxy = proxy;
    this.version += 1;
  }

  setDocs(docs: SidebarSnapshot["docs"]): void {
    this.docs = docs;
    this.version += 1;
  }

  setProjectContext(projectContext: SidebarSnapshot["projectContext"]): void {
    this.projectContext = projectContext;
    this.version += 1;
  }

  setRulesContext(rulesContext: SidebarSnapshot["rulesContext"]): void {
    this.rulesContext = rulesContext;
    this.version += 1;
  }

  setRuntime(runtime: SidebarSnapshot["runtime"]): void {
    this.runtime = runtime;
    this.version += 1;
  }

  setRateLimits(rateLimits: SidebarSnapshot["rateLimits"]): void {
    this.rateLimits = rateLimits;
    this.version += 1;
  }

  setChatContextWindow(chatId: string, contextWindow: ContextWindowUsage): void {
    if (!this.getChat(chatId)) {
      return;
    }
    this.contextWindows.set(chatId, contextWindow);
    this.version += 1;
  }

  getChatContextWindow(chatId: string): ContextWindowUsage {
    return this.contextWindows.get(chatId) ?? EMPTY_CONTEXT_WINDOW;
  }

  getChatSnapshot(chatId: string): ChatPanelSnapshot | undefined {
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

  getActiveChatId(): string | undefined {
    return this.activeChatId;
  }

  getActiveChatSnapshot(): ChatPanelSnapshot | undefined {
    return this.activeChatId ? this.getChatSnapshot(this.activeChatId) : undefined;
  }

  getTranscriptTail(chatId: string, count = TRANSCRIPT_INITIAL_WINDOW_SIZE): ChatTranscriptWindow {
    const transcript = this.transcripts.get(chatId) ?? [];
    const safeCount = normalizeTranscriptWindowCount(count, TRANSCRIPT_INITIAL_WINDOW_SIZE);
    return this.buildTranscriptWindow(chatId, Math.max(0, transcript.length - safeCount), transcript.length);
  }

  getTranscriptBefore(chatId: string, beforeItemId: string, count = TRANSCRIPT_PAGE_SIZE, beforeOffset?: number): ChatTranscriptWindow {
    const transcript = this.transcripts.get(chatId) ?? [];
    const itemIndex = transcript.findIndex((item) => item.id === beforeItemId);
    const index = itemIndex >= 0
      ? itemIndex
      : normalizeTranscriptBoundaryOffset(beforeOffset, transcript.length);
    if (index < 0) {
      return this.buildTranscriptWindow(chatId, 0, 0);
    }

    const safeCount = normalizeTranscriptWindowCount(count, TRANSCRIPT_PAGE_SIZE);
    return this.buildTranscriptWindow(chatId, Math.max(0, index - safeCount), index);
  }

  getTranscriptAfter(chatId: string, afterItemId: string, count = TRANSCRIPT_PAGE_SIZE, afterOffset?: number): ChatTranscriptWindow {
    const transcript = this.transcripts.get(chatId) ?? [];
    const itemIndex = transcript.findIndex((item) => item.id === afterItemId);
    const index = itemIndex >= 0
      ? itemIndex
      : normalizeTranscriptBoundaryOffset(afterOffset, transcript.length);
    if (index < 0) {
      return this.buildTranscriptWindow(chatId, transcript.length, transcript.length);
    }

    const safeCount = normalizeTranscriptWindowCount(count, TRANSCRIPT_PAGE_SIZE);
    return this.buildTranscriptWindow(chatId, index + 1, Math.min(transcript.length, index + 1 + safeCount));
  }

  private getActiveClarification(chatId: string): ChatClarificationTranscriptItem | undefined {
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

  getDiffFile(chatId: string, diffId: string, fileIndex: number): { item: ChatDiffTranscriptItem; file: ChatDiffFileSummary } | undefined {
    const transcript = this.transcripts.get(chatId) ?? [];
    const item = transcript.find((entry): entry is ChatDiffTranscriptItem => entry.kind === "diff" && entry.id === diffId);
    if (!item || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= item.files.length) {
      return undefined;
    }
    return { item, file: item.files[fileIndex] };
  }

  private buildTranscriptWindow(chatId: string, start: number, end: number): ChatTranscriptWindow {
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

  createChat(kind: ChatKind, title?: string): ChatSummary {
    const now = new Date().toISOString();
    const nextNumber = this.chats.filter((chat) => chat.kind === kind).length + 1;
    const defaultTitle = kind === "project" ? `Проектный чат ${nextNumber}` : `Общий чат ${nextNumber}`;
    const chat: ChatSummary = {
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

  setActiveChat(chatId: string): void {
    if (this.chats.some((chat) => chat.id === chatId)) {
      this.activeChatId = chatId;
      this.version += 1;
      this.emitMutation("debounced");
    }
  }

  clearActiveChat(chatId?: string): void {
    if (!this.activeChatId || (chatId && this.activeChatId !== chatId)) {
      return;
    }
    this.activeChatId = undefined;
    this.version += 1;
    this.emitMutation("immediate");
  }

  getChat(chatId: string): ChatSummary | undefined {
    return this.chats.find((chat) => chat.id === chatId);
  }

  archiveChat(chatId: string): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }
    if (chat.archivedAt) {
      return chat;
    }

    const updated: ChatSummary = {
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

  restoreChat(chatId: string): ChatSummary | undefined {
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

    const updated: ChatSummary = {
      ...chat,
      archivedAt: null
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.activeChatId = chatId;
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  deleteChat(chatId: string): boolean {
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

  renameChat(chatId: string, title: string): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    const trimmed = title.trim();
    if (!chat || !trimmed) {
      return undefined;
    }
    if (chat.title === trimmed) {
      return chat;
    }

    const updated: ChatSummary = {
      ...chat,
      title: trimmed
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  toggleChatRules(chatId: string): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat || chat.kind !== "project") {
      return undefined;
    }

    const updated: ChatSummary = {
      ...chat,
      rulesEnabled: !chat.rulesEnabled
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  setChatAccessMode(chatId: string, accessMode: ChatSummary["accessMode"]): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat || chat.accessMode === accessMode) {
      return chat;
    }

    const updated: ChatSummary = {
      ...chat,
      accessMode
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  setChatModel(chatId: string, modelId: string | null, modelLabel: string): ChatSummary | undefined {
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

    const updated: ChatSummary = {
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

  setChatEffort(chatId: string, effort: ChatEffort): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat || chat.effort === effort) {
      return chat;
    }

    const updated: ChatSummary = {
      ...chat,
      effort
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  setChatSpeed(chatId: string, speed: ChatSpeed): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat || chat.speed === speed) {
      return chat;
    }

    const updated: ChatSummary = {
      ...chat,
      speed
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("immediate");
    return updated;
  }

  enqueueChatMessage(chatId: string, text: string, mode: ChatRunMode, skills: ChatQueuedMessage["skills"] = [], attachments: ChatAttachment[] = []): ChatQueuedMessage | undefined {
    const chat = this.getChat(chatId);
    const normalized = text.trim();
    if (!chat || (!normalized && !attachments.length)) {
      return undefined;
    }
    const queued: ChatQueuedMessage = {
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

  removeQueuedChatMessage(chatId: string, messageId: string): boolean {
    const chat = this.getChat(chatId);
    if (!chat || !chat.queuedMessages.some((message) => message.id === messageId)) {
      return false;
    }
    this.updateChat(chatId, {
      queuedMessages: chat.queuedMessages.filter((message) => message.id !== messageId)
    }, "immediate");
    return true;
  }

  moveQueuedChatMessage(chatId: string, messageId: string, direction: "up" | "down"): boolean {
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

  shiftQueuedChatMessage(chatId: string): ChatQueuedMessage | undefined {
    const chat = this.getChat(chatId);
    const queued = chat?.queuedMessages[0];
    if (!chat || !queued) {
      return undefined;
    }
    this.updateChat(chatId, { queuedMessages: chat.queuedMessages.slice(1) }, "immediate");
    return queued;
  }

  setModelOptions(options: ModelOption[], status: ChatPanelSnapshot["modelOptionsStatus"]): void {
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

  getModelOptionForChat(chatId: string): ModelOption | undefined {
    const chat = this.getChat(chatId);
    return chat ? this.resolveModelOption(chat.modelId) : undefined;
  }

  setModelOptionsStatus(status: ChatPanelSnapshot["modelOptionsStatus"]): void {
    this.modelOptionsStatus = status;
    this.version += 1;
  }

  invalidateModelOptions(): void {
    this.modelOptions = FALLBACK_MODEL_OPTIONS;
    this.modelOptionsStatus = "idle";
    this.version += 1;
  }

  setPendingApproval(chatId: string, pendingApproval: ChatSummary["pendingApproval"]): ChatSummary | undefined {
    const status = pendingApproval ? "waitingApproval" : this.getChat(chatId)?.status === "waitingApproval" ? "running" : undefined;
    return this.updateChat(
      chatId,
      {
        pendingApproval,
        ...(status ? { status } : {})
      },
      "immediate"
    );
  }

  updateChat(chatId: string, patch: Partial<ChatSummary>, mode: StateMutationMode = "debounced"): ChatSummary | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }

    const updatedAt = new Date().toISOString();
    const updated: ChatSummary = {
      ...chat,
      ...patch,
      updatedAt
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation(mode);
    return updated;
  }

  detachBackendThreads(): number {
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

  markChatRead(chatId: string): boolean {
    const chat = this.getChat(chatId);
    if (!chat || !chat.hasUnread) {
      return false;
    }

    const updated: ChatSummary = {
      ...chat,
      hasUnread: false,
      lastReadAt: chat.updatedAt
    };
    this.chats = this.chats.map((candidate) => candidate.id === chatId ? updated : candidate);
    this.version += 1;
    this.emitMutation("debounced");
    return true;
  }

  addTranscriptItem(
    chatId: string,
    role: ChatMessageTranscriptItem["role"],
    text: string,
    mode: StateMutationMode = "immediate",
    turnId?: string,
    attachments: readonly ChatAttachment[] = []
  ): ChatMessageTranscriptItem | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }

    const item: ChatMessageTranscriptItem = {
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

  appendAssistantDelta(chatId: string, delta: string, turnId?: string): void {
    const chat = this.getChat(chatId);
    if (!chat || !delta) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const streamingIndex = findLastStreamingAssistantMessageIndex(transcript, turnId);
    if (streamingIndex >= 0) {
      const last = transcript[streamingIndex] as ChatMessageTranscriptItem;
      const updatedLast: ChatMessageTranscriptItem = {
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
    } else {
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

  setLastAssistantText(chatId: string, text: string, turnId?: string): void {
    const chat = this.getChat(chatId);
    if (!chat || !text) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const index = findLastAssistantMessageIndex(transcript, turnId);
    if (index >= 0) {
      const existing = transcript[index] as ChatMessageTranscriptItem;
      this.transcripts.set(chatId, [
        ...transcript.slice(0, index),
        { ...existing, text, turnId: existing.turnId ?? turnId, status: "complete", completedAt: new Date().toISOString() },
        ...transcript.slice(index + 1)
      ]);
    } else {
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

  removeLastStreamingAssistantMessage(chatId: string, turnId?: string, mode: StateMutationMode = "debounced"): boolean {
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

  addOrUpdateActivityItem(
    chatId: string,
    patch: {
      id: string;
      activityKind: ChatActivityKind;
      label: string;
      status: ChatActivityTranscriptItem["status"];
      turnId?: string;
      itemId?: string;
      command?: string;
      path?: string;
      summary?: string;
      outputPreview?: string;
      details?: ChatActivityDetail[];
    },
    mode: StateMutationMode = "debounced"
  ): ChatActivityTranscriptItem | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }

    const now = new Date().toISOString();
    const transcript = this.transcripts.get(chatId) ?? [];
    const existingIndex = transcript.findIndex((item) => item.kind === "activity" && item.id === patch.id);
    const existing = existingIndex >= 0 ? transcript[existingIndex] as ChatActivityTranscriptItem : undefined;
    const item: ChatActivityTranscriptItem = {
      ...(existing ?? {
        kind: "activity" as const,
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
    } else {
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

  appendActivityOutput(chatId: string, activityId: string, delta: string, mode: StateMutationMode = "debounced"): void {
    if (!this.getChat(chatId) || !delta) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const index = transcript.findIndex((item) => item.kind === "activity" && item.id === activityId);
    if (index < 0) {
      return;
    }

    const existing = transcript[index] as ChatActivityTranscriptItem;
    const output = `${existing.outputPreview ?? ""}${delta}`;
    const detailOutput = appendActivityDetailOutput(existing, delta);
    const updated: ChatActivityTranscriptItem = {
      ...existing,
      outputPreview: existing.activityKind === "command" ? existing.outputPreview : limitActivityOutput(output),
      details: detailOutput,
      updatedAt: new Date().toISOString()
    };
    this.transcripts.set(chatId, [...transcript.slice(0, index), updated, ...transcript.slice(index + 1)]);
    this.updateChat(chatId, { hasUnread: true }, mode);
  }

  addOrUpdateWorklogItem(
    chatId: string,
    patch: {
      id: string;
      operationKind: ChatWorklogTranscriptItem["operationKind"];
      status: ChatWorklogTranscriptItem["status"];
      title: string;
      turnId?: string;
      summary?: string;
      children?: WorklogChild[];
    },
    mode: StateMutationMode = "debounced"
  ): ChatWorklogTranscriptItem | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }

    const now = new Date().toISOString();
    const transcript = this.transcripts.get(chatId) ?? [];
    const existingIndex = transcript.findIndex((item) => item.kind === "worklog" && item.id === patch.id);
    const existing = existingIndex >= 0 ? transcript[existingIndex] as ChatWorklogTranscriptItem : undefined;
    const item: ChatWorklogTranscriptItem = {
      ...(existing ?? {
        kind: "worklog" as const,
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
    } else {
      this.transcripts.set(chatId, [...transcript, item]);
    }
    if (patch.turnId) {
      this.linkTurnRunItem(chatId, patch.turnId, { worklogIds: [item.id] });
    }
    this.updateChat(chatId, { hasUnread: true }, mode);
    return item;
  }

  appendWorklogChildOutput(chatId: string, worklogId: string, childId: string, delta: string, mode: StateMutationMode = "debounced"): void {
    if (!this.getChat(chatId) || !delta) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const index = transcript.findIndex((item) => item.kind === "worklog" && item.id === worklogId);
    if (index < 0) {
      return;
    }

    const existing = transcript[index] as ChatWorklogTranscriptItem;
    const children = existing.children.map((child) => child.id === childId
      ? {
        ...child,
        outputPreview: limitActivityOutput(`${child.outputPreview ?? ""}${delta}`)
      }
      : child);
    const updated: ChatWorklogTranscriptItem = {
      ...existing,
      children,
      updatedAt: new Date().toISOString()
    };
    this.transcripts.set(chatId, [...transcript.slice(0, index), updated, ...transcript.slice(index + 1)]);
    this.updateChat(chatId, { hasUnread: true }, mode);
  }

  addOrUpdateDiffItem(
    chatId: string,
    turnId: string,
    title: string,
    files: ChatDiffFileSummary[],
    mode: StateMutationMode = "debounced"
  ): void {
    if (!this.getChat(chatId) || files.length === 0) {
      return;
    }
    const id = turnId ? `diff-${turnId}` : `${chatId}-diff`;
    const now = new Date().toISOString();
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const transcript = this.transcripts.get(chatId) ?? [];
    const index = transcript.findIndex((item) => item.kind === "diff" && item.id === id);
    const item: ChatTranscriptItem = {
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

  addOrUpdatePlanItem(chatId: string, turnId: string, markdown: string, mode: StateMutationMode = "debounced"): void {
    if (!this.getChat(chatId) || !markdown.trim()) {
      return;
    }
    const id = turnId ? `plan-${turnId}` : `${chatId}-plan`;
    const now = new Date().toISOString();
    const transcript = this.transcripts.get(chatId) ?? [];
    const index = transcript.findIndex((item) => item.kind === "plan" && item.id === id);
    const item: ChatTranscriptItem = {
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

  addOrUpdateClarificationItem(
    chatId: string,
    turnId: string,
    question: string,
    options: ChatClarificationOption[],
    mode: StateMutationMode = "immediate"
  ): void {
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
    const item: ChatTranscriptItem = {
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

  addCompactionItem(chatId: string, label = "Контекст автоматически сжат", mode: StateMutationMode = "immediate", turnId?: string): void {
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
      return Number.isFinite(createdAt) && now - createdAt < 5 * 60_000;
    });
    if (hasRecentMarker) {
      return;
    }
    const item: ChatTranscriptItem = {
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

  addConnectionItem(
    chatId: string,
    message: string,
    status: "reconnecting" | "failed" | "recovered",
    attempt?: number,
    maxAttempts?: number,
    mode: StateMutationMode = "debounced"
  ): void {
    if (!this.getChat(chatId)) {
      return;
    }
    const transcript = this.transcripts.get(chatId) ?? [];
    const id = `connection-${chatId}`;
    const now = new Date().toISOString();
    const index = transcript.findIndex((item) => item.kind === "connection" && item.id === id);
    const existing = index >= 0 ? transcript[index] : undefined;
    const item: ChatTranscriptItem = {
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

  addErrorItem(chatId: string, message: string, details?: string, mode: StateMutationMode = "immediate"): void {
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

  findChatByTurnId(turnId: string): ChatSummary | undefined {
    return this.chats.find((chat) => chat.activeTurnId === turnId);
  }

  hasChats(): boolean {
    return this.chats.length > 0;
  }

  replaceChatHistory(history: PersistedChatHistory | undefined): void {
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
    this.transcripts = new Map(
      Object.entries(history?.transcripts ?? {})
        .filter(([chatId]) => this.chats.some((chat) => chat.id === chatId))
    );
    this.version += 1;
  }

  exportChatHistory(): PersistedChatHistory {
    const transcripts: Record<string, ChatTranscriptItem[]> = {};
    for (const chat of this.chats) {
      transcripts[chat.id] = this.transcripts.get(chat.id) ?? [];
    }
    const chats = this.chats.map((chat) => ({
      ...chat,
      pendingApproval: null,
      status: chat.status === "waitingApproval" || chat.status === "running" || chat.status === "cancelling" ? "idle" as const : chat.status,
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

  private linkTurnRunItem(
    chatId: string,
    turnId: string,
    patch: {
      status?: ChatTurnRunTranscriptItem["status"];
      activityIds?: string[];
      worklogIds?: string[];
      diffIds?: string[];
      compactionIds?: string[];
    }
  ): void {
    if (!turnId) {
      return;
    }

    const now = new Date().toISOString();
    const transcript = this.transcripts.get(chatId) ?? [];
    const id = `turn-run-${turnId}`;
    const existingIndex = transcript.findIndex((item) => item.kind === "turn-run" && item.id === id);
    const existing = existingIndex >= 0 ? transcript[existingIndex] as ChatTurnRunTranscriptItem : undefined;
    const status = patch.status ?? existing?.status ?? "running";
    const item: ChatTurnRunTranscriptItem = {
      ...(existing ?? {
        kind: "turn-run" as const,
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
    } else {
      this.transcripts.set(chatId, [...transcript, item]);
    }
  }

  private resolveModelOption(modelId: string | null): ModelOption | undefined {
    if (modelId) {
      return this.modelOptions.find((option) => option.id === modelId);
    }
    return this.modelOptions.find((option) => option.id === null)
      ?? this.modelOptions.find((option) => option.isDefault);
  }

  private emitMutation(mode: StateMutationMode): void {
    this.onDidMutate?.(mode);
  }
}

function normalizeModelOptions(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const normalized: ModelOption[] = [];
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

function reconcileEffort(current: ChatEffort, option: ModelOption | undefined): ChatEffort {
  const supported = option?.supportedEfforts;
  if (!supported?.length || supported.some((candidate) => candidate.value === current)) {
    return current;
  }
  return option?.defaultEffort ?? supported[0]?.value ?? "medium";
}

function isChatEffort(value: unknown): value is ChatEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";
}

function normalizeTranscriptWindowCount(count: number, fallback: number): number {
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.max(1, Math.min(TRANSCRIPT_MAX_WINDOW_REQUEST_SIZE, Math.floor(count)));
}

function mergeActivityDetails(existing: ChatActivityDetail[] | undefined, next: ChatActivityDetail[] | undefined): ChatActivityDetail[] | undefined {
  if (!existing?.length) {
    return next?.length ? next : undefined;
  }
  if (!next?.length) {
    return existing;
  }
  const merged: ChatActivityDetail[] = next.map((detail, index) => ({
    ...existing[index],
    ...detail,
    outputPreview: detail.outputPreview ?? existing[index]?.outputPreview
  }));
  if (existing.length > next.length) {
    merged.push(...existing.slice(next.length));
  }
  return merged;
}

function appendActivityDetailOutput(item: ChatActivityTranscriptItem, delta: string): ChatActivityDetail[] {
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

function mergeWorklogChildren(existing: WorklogChild[] | undefined, next: WorklogChild[] | undefined): WorklogChild[] {
  const merged = new Map<string, WorklogChild>();
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

function mergeUniqueStrings(existing: string[] | undefined, next: string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(existing ?? []), ...(next ?? [])]) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildTurnRunCounts(turnRun: ChatTurnRunTranscriptItem, transcript: ChatTranscriptItem[]): Partial<Record<ChatTurnRunCounterKind, number>> {
  const counts: Partial<Record<ChatTurnRunCounterKind, number>> = {};
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

function activityKindToTurnRunCounter(kind: ChatActivityKind): ChatTurnRunCounterKind | undefined {
  if (kind === "command" || kind === "file" || kind === "search" || kind === "reasoning" || kind === "context" || kind === "tool") {
    return kind;
  }
  return undefined;
}

function limitActivityOutput(output: string): string {
  return output.length > 1200 ? output.slice(output.length - 1200) : output;
}

function findLastAssistantMessageIndex(items: ChatTranscriptItem[], turnId?: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "assistant" && (!turnId || !item.turnId || item.turnId === turnId)) {
      return index;
    }
  }
  return -1;
}

function findLastStreamingAssistantMessageIndex(items: ChatTranscriptItem[], turnId?: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "assistant" && item.status === "streaming" && (!turnId || !item.turnId || item.turnId === turnId)) {
      return index;
    }
  }
  return -1;
}

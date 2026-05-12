import { ChatEffort, ChatHeaderMode, ChatKind, ChatPanelSnapshot, ChatSpeed, ChatSummary, ChatTranscriptItem, ModelOption, PersistedChatHistory, SidebarSnapshot } from "./types";

type AuthPatch = Omit<Partial<SidebarSnapshot["auth"]>, "deviceCode" | "apiKey"> & {
  deviceCode?: Partial<SidebarSnapshot["auth"]["deviceCode"]>;
  apiKey?: Partial<SidebarSnapshot["auth"]["apiKey"]>;
};

export type StateMutationMode = "debounced" | "immediate";

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { id: null, label: "5.5" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  { id: "gpt-5.2", label: "GPT-5.2" }
];

export class StateStore {
  private version = 1;
  private activeChatId: string | undefined;
  private chats: ChatSummary[] = [];
  private transcripts = new Map<string, ChatTranscriptItem[]>();
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
      modelOptions: this.modelOptions,
      modelOptionsStatus: this.modelOptionsStatus,
      transcript: this.transcripts.get(chat.id) ?? []
    };
  }

  getActiveChatId(): string | undefined {
    return this.activeChatId;
  }

  getActiveChatSnapshot(): ChatPanelSnapshot | undefined {
    return this.activeChatId ? this.getChatSnapshot(this.activeChatId) : undefined;
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
    const label = modelLabel.trim() || "5.5";
    if (!chat || (chat.modelId === modelId && chat.modelLabel === label)) {
      return chat;
    }

    const updated: ChatSummary = {
      ...chat,
      modelId,
      modelLabel: label,
      backendThreadAccessMode: null,
      backendThreadId: null,
      activeTurnId: null
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

  setModelOptions(options: ModelOption[], status: ChatPanelSnapshot["modelOptionsStatus"]): void {
    const normalized = normalizeModelOptions(options);
    this.modelOptions = normalized.length ? normalized : FALLBACK_MODEL_OPTIONS;
    this.modelOptionsStatus = status;
    this.version += 1;
  }

  setModelOptionsStatus(status: ChatPanelSnapshot["modelOptionsStatus"]): void {
    this.modelOptionsStatus = status;
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
    role: ChatTranscriptItem["role"],
    text: string,
    mode: StateMutationMode = "immediate"
  ): ChatTranscriptItem | undefined {
    const chat = this.getChat(chatId);
    if (!chat) {
      return undefined;
    }

    const item: ChatTranscriptItem = {
      id: `${chatId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      text,
      createdAt: new Date().toISOString()
    };
    this.transcripts.set(chatId, [...(this.transcripts.get(chatId) ?? []), item]);
    this.updateChat(chatId, role === "user" ? {} : { hasUnread: true }, mode);
    return item;
  }

  appendAssistantDelta(chatId: string, delta: string): void {
    const chat = this.getChat(chatId);
    if (!chat || !delta) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const last = transcript[transcript.length - 1];
    if (last?.role === "assistant") {
      const updatedLast: ChatTranscriptItem = {
        ...last,
        text: `${last.text}${delta}`
      };
      this.transcripts.set(chatId, [...transcript.slice(0, -1), updatedLast]);
    } else {
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

  setLastAssistantText(chatId: string, text: string): void {
    const chat = this.getChat(chatId);
    if (!chat || !text) {
      return;
    }

    const transcript = this.transcripts.get(chatId) ?? [];
    const last = transcript[transcript.length - 1];
    if (last?.role === "assistant") {
      this.transcripts.set(chatId, [...transcript.slice(0, -1), { ...last, text }]);
    } else {
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

  findChatByTurnId(turnId: string): ChatSummary | undefined {
    return this.chats.find((chat) => chat.activeTurnId === turnId);
  }

  hasChats(): boolean {
    return this.chats.length > 0;
  }

  replaceChatHistory(history: PersistedChatHistory | undefined): void {
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
    normalized.push({ id, label });
  }
  return normalized;
}

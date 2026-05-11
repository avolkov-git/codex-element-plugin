import { ChatKind, ChatPanelSnapshot, ChatSummary, ChatTranscriptItem, PersistedChatHistory, SidebarSnapshot } from "./types";

type AuthPatch = Omit<Partial<SidebarSnapshot["auth"]>, "deviceCode" | "apiKey"> & {
  deviceCode?: Partial<SidebarSnapshot["auth"]["deviceCode"]>;
  apiKey?: Partial<SidebarSnapshot["auth"]["apiKey"]>;
};

export type StateMutationMode = "debounced" | "immediate";

export class StateStore {
  private version = 1;
  private activeChatId: string | undefined;
  private chats: ChatSummary[] = [];
  private transcripts = new Map<string, ChatTranscriptItem[]>();
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
      runtime: this.runtime,
      chats: [...this.chats],
      activeChatId: this.activeChatId
    };
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
      chat,
      auth: sidebar.auth,
      runtime: sidebar.runtime,
      transcript: this.transcripts.get(chat.id) ?? [],
      shellNotice: "Read-only режим: Codex отвечает в чате, но approvals, diff и правки файлов пока отключены."
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
      lastReadAt: now,
      hasUnread: false,
      status: "idle",
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
          ? "Проектный чат будет использовать контекст проекта, документации, библиотек и правил."
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

  getChat(chatId: string): ChatSummary | undefined {
    return this.chats.find((chat) => chat.id === chatId);
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
      lastReadAt: chat.lastReadAt || chat.updatedAt,
      hasUnread: Boolean(chat.hasUnread),
      status: "idle",
      activeTurnId: null
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

    return {
      version: 1,
      activeChatId: this.activeChatId,
      chats: this.chats,
      transcripts
    };
  }

  private emitMutation(mode: StateMutationMode): void {
    this.onDidMutate?.(mode);
  }
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatEffort, ChatKind, ChatSpeed, ChatStatus, ChatSummary, ChatTranscriptItem, PersistedChatHistory } from "./types";

interface PendingSave {
  profileId: string;
  history: PersistedChatHistory;
}

export class ChatHistoryService implements vscode.Disposable {
  private pendingSave: PendingSave | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saveChain = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configRoot: string,
    private readonly logger: Logger
  ) {}

  async load(profileId: string): Promise<PersistedChatHistory | undefined> {
    const historyPath = this.historyPath(profileId);
    try {
      const raw = await fs.promises.readFile(historyPath, "utf8");
      const parsed = JSON.parse(raw);
      const history = normalizeHistory(parsed);
      this.logger.info(`Chat history loaded: ${historyPath}.`);
      return history;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.logger.info(`Chat history not found for profile ${profileId}.`);
        return undefined;
      }
      this.logger.warn(`Chat history read failed, starting empty: ${normalizeErrorMessage(error)}.`);
      return undefined;
    }
  }

  scheduleSave(profileId: string, history: PersistedChatHistory): void {
    this.pendingSave = { profileId, history };
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 600);
  }

  async saveNow(profileId: string, history: PersistedChatHistory): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.pendingSave = undefined;
    await this.writeQueued(profileId, history);
  }

  async flush(): Promise<void> {
    const pending = this.pendingSave;
    if (!pending) {
      return;
    }
    this.pendingSave = undefined;
    await this.writeQueued(pending.profileId, pending.history);
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.pendingSave) {
      void this.flush();
    }
  }

  private historyPath(profileId: string): string {
    return path.join(this.configRoot, "users", profileId, "workspaces", this.workspaceId(), "chats.json");
  }

  private workspaceId(): string {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.context.globalStorageUri.fsPath;
    return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  }

  private async writeQueued(profileId: string, history: PersistedChatHistory): Promise<void> {
    this.saveChain = this.saveChain
      .then(() => this.write(profileId, history))
      .catch((error) => {
        this.logger.warn(`Chat history save failed: ${normalizeErrorMessage(error)}.`);
      });
    await this.saveChain;
  }

  private async write(profileId: string, history: PersistedChatHistory): Promise<void> {
    const historyPath = this.historyPath(profileId);
    await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
    const tempPath = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await fs.promises.rename(tempPath, historyPath);
    this.logger.info(`Chat history saved: ${historyPath}.`);
  }
}

function normalizeHistory(value: unknown): PersistedChatHistory {
  const object = isObject(value) ? value : {};
  const chats = Array.isArray(object.chats)
    ? object.chats.map(normalizeChat).filter((chat): chat is ChatSummary => Boolean(chat))
    : [];
  const chatIds = new Set(chats.map((chat) => chat.id));
  const transcripts: Record<string, ChatTranscriptItem[]> = {};
  const rawTranscripts = isObject(object.transcripts) ? object.transcripts : {};

  for (const [chatId, items] of Object.entries(rawTranscripts)) {
    if (!chatIds.has(chatId) || !Array.isArray(items)) {
      continue;
    }
    transcripts[chatId] = items
      .map(normalizeTranscriptItem)
      .filter((item): item is ChatTranscriptItem => Boolean(item));
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

function normalizeChat(value: unknown): ChatSummary | undefined {
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

function normalizeTranscriptItem(value: unknown): ChatTranscriptItem | undefined {
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

function normalizeChatKind(value: unknown): ChatKind {
  return value === "general" ? "general" : "project";
}

function normalizeChatStatus(value: unknown): ChatStatus {
  return value === "error" ? "error" : "idle";
}

function normalizeChatAccessMode(value: unknown, kind: ChatKind): ChatSummary["accessMode"] {
  if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") {
    return value;
  }
  return kind === "project" ? "workspace-write" : "read-only";
}

function normalizeOptionalChatAccessMode(value: unknown): ChatSummary["backendThreadAccessMode"] {
  if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") {
    return value;
  }
  return null;
}

function normalizeChatEffort(value: unknown): ChatEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return "medium";
}

function normalizeChatSpeed(value: unknown): ChatSpeed {
  if (value === "standard" || value === "fast") {
    return value;
  }
  return "standard";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

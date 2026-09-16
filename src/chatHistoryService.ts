import * as vscode from "vscode";
import { performance } from "perf_hooks";
import { ElementIdentity } from "./elementIdentityService";
import { Logger } from "./logger";
import { ProjectHistoryStore, validateHistory } from "./projectHistoryStore";
import { ChatMessageQuestion } from "./types";
import { ChatActivityDetail, ChatActivityKind, ChatAttachment, ChatClarificationOption, ChatDiffFileStatus, ChatDiffFileSummary, ChatEffort, ChatKind, ChatSpeed, ChatStatus, ChatSummary, ChatTranscriptItem, ChatTurnRunCounterKind, PersistedChatHistory, WorklogChild, WorklogOperationKind, WorklogSource, WorklogStatus } from "./types";

interface PendingSave {
  identity: ElementIdentity;
  workspacePath: string;
  history: PersistedChatHistory;
}

interface SaveBatch extends PendingSave { completion: Promise<void>; }
export interface ChatHistorySaveOptions {
  saveDelayMs?: number;
  /** Includes running operations. A separate debounce slot holds at most one snapshot. */
  maxQueuedOperations?: number;
}

export class ChatHistoryService implements vscode.Disposable {
  private pendingSave: PendingSave | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saveChain = Promise.resolve();
  private tailSave: SaveBatch | undefined;
  private saveFailure: { error: unknown } | undefined;
  private loading = 0;
  private loadedWorkspacePath: string | undefined;
  private readonly saveDelayMs: number;
  private readonly maxQueuedOperations: number;
  private readonly metrics = {
    saveNowRequests: 0, scheduledSaveRequests: 0, coalescedSaves: 0,
    snapshotCaptures: 0, snapshotMs: 0, snapshotMaxMs: 0, serializations: 0, serializedBytes: 0, serializationMs: 0,
    savesStarted: 0, savesCompleted: 0, saveFailures: 0, rejectedSaveRequests: 0,
    saveMs: 0, saveMaxMs: 0, queueCurrent: 0, queueMax: 0, queueWaitMs: 0, queueWaitMaxMs: 0
  };
  private readonly store: ProjectHistoryStore;
  private identity: ElementIdentity | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    configRoot: string,
    private readonly logger: Logger,
    private readonly getIdentity: () => ElementIdentity | undefined,
    private readonly onSaveError: (message: string) => void = () => undefined,
    options: ChatHistorySaveOptions = {}
  ) {
    this.store = new ProjectHistoryStore(configRoot, normalizeHistory);
    this.saveDelayMs = options.saveDelayMs ?? 600;
    this.maxQueuedOperations = options.maxQueuedOperations ?? 32;
    if (!Number.isFinite(this.saveDelayMs) || this.saveDelayMs < 0 || !Number.isSafeInteger(this.maxQueuedOperations) || this.maxQueuedOperations < 2) {
      throw new Error("Invalid history save scheduling limits.");
    }
  }

  getMetrics() {
    const store = this.store.getMetrics();
    return { ...this.metrics, serializations: this.metrics.serializations + store.serializations,
      serializedBytes: this.metrics.serializedBytes + store.serializedBytes, serializationMs: this.metrics.serializationMs + store.serializationMs,
      scheduledSavePending: Boolean(this.pendingSave), store };
  }

  async load(profileId: string): Promise<PersistedChatHistory | undefined> {
    const verified = this.getIdentity();
    if (!verified || verified.userKey !== profileId) { throw new Error("Пользователь IDE не подтвержден. История не открыта."); }
    const identity = { ...verified };
    const workspacePath = this.workspacePath();
    // An explicit idle reload is recovery. A load behind outstanding saves still observes their failures.
    if (!this.pendingSave && this.metrics.queueCurrent === 0) { this.saveFailure = undefined; }
    const flushed = this.flush();
    this.loading++;
    try {
      return await this.enqueue(async () => {
        this.identity = undefined;
        this.loadedWorkspacePath = undefined;
        await flushed;
        const loaded = await this.store.load(identity, workspacePath);
        const current = this.getIdentity();
        if (current?.userKey !== identity.userKey || current.projectKey !== identity.projectKey || this.workspacePath() !== workspacePath) { throw new Error("Пользователь или проект IDE изменился при загрузке истории."); }
        this.identity = identity;
        this.loadedWorkspacePath = workspacePath;
        this.logger.info(`Project chat history loaded: ${this.store.file(identity)}.`);
        return loaded;
      });
    } finally { this.loading--; }
  }

  scheduleSave(profileId: string, history: PersistedChatHistory): void {
    const identity = this.requireLoadedIdentity(profileId);
    this.metrics.scheduledSaveRequests++;
    if (this.pendingSave) { this.metrics.coalescedSaves++; }
    this.pendingSave = { identity, workspacePath: this.loadedWorkspacePath!, history };
    // A fixed deadline guarantees progress even during a continuous token stream.
    if (this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch((error) => this.reportSaveError(error));
    }, this.saveDelayMs);
  }

  saveNow(profileId: string, history: PersistedChatHistory): Promise<void> {
    this.metrics.saveNowRequests++;
    try {
      const completion = this.writeQueued({ identity: this.requireLoadedIdentity(profileId), workspacePath: this.loadedWorkspacePath!, history });
      this.clearSaveTimer();
      if (this.pendingSave) { this.metrics.coalescedSaves++; }
      this.pendingSave = undefined;
      return completion;
    } catch (error) {
      this.metrics.rejectedSaveRequests++;
      return Promise.reject(error);
    }
  }

  flush(): Promise<void> {
    try {
      this.clearSaveTimer();
      if (this.pendingSave) {
        this.writeQueued(this.pendingSave);
        this.pendingSave = undefined;
      }
      // Later snapshots must not replace a revision covered by this barrier.
      this.tailSave = undefined;
      const barrier = this.saveChain.then(() => { if (this.saveFailure) { throw this.saveFailure.error; } });
      // load/import may not reach their await until earlier operations finish.
      void barrier.catch(() => undefined);
      return barrier;
    } catch (error) {
      const rejected = Promise.reject<void>(error);
      void rejected.catch(() => undefined);
      return rejected;
    }
  }

  dispose(): void {
    this.clearSaveTimer();
    if (this.pendingSave) {
      void this.flush().catch((error) => this.reportSaveError(error));
    }
  }

  async listLegacy() {
    const identity = this.identity;
    if (!identity) { throw new Error("Сначала откройте историю текущего проекта."); }
    return this.enqueue(async () => {
      if (this.identity !== identity) { throw new Error("Область истории изменилась. Обновите список переноса."); }
      return this.store.listLegacy(identity);
    });
  }

  async importLegacy(id: string, current: PersistedChatHistory): Promise<PersistedChatHistory> {
    const identity = this.identity;
    if (!identity) { throw new Error("Сначала откройте историю текущего проекта."); }
    const workspacePath = this.loadedWorkspacePath!;
    const started = performance.now();
    const serialized = JSON.stringify(current);
    this.metrics.serializations++;
    this.metrics.serializedBytes += Buffer.byteLength(serialized);
    this.metrics.serializationMs += performance.now() - started;
    const snapshot = JSON.parse(serialized) as PersistedChatHistory;
    const flushed = this.flush();
    return this.enqueue(async () => {
      await flushed;
      if (this.identity !== identity) { throw new Error("Область истории изменилась. Повторите перенос."); }
      return this.store.importLegacy(identity, workspacePath, id, snapshot);
    });
  }

  private workspacePath(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || this.context.globalStorageUri.fsPath; }

  private requireLoadedIdentity(profileId: string): ElementIdentity {
    if (this.loading || !this.identity || this.identity.userKey !== profileId) { throw new Error("Запись истории до подтверждения пользователя и загрузки проекта запрещена."); }
    return this.identity;
  }

  private writeQueued(pending: PendingSave): Promise<void> {
    const tail = this.tailSave;
    const replace = tail?.identity === pending.identity && tail.workspacePath === pending.workspacePath;
    if (!replace) { this.requireQueueSpace(); }
    const start = performance.now();
    // Exported transcripts are mutable. Detach now, without a JSON string/parse round-trip.
    const history = normalizeHistory(pending.history);
    const elapsed = performance.now() - start;
    this.metrics.snapshotCaptures++;
    this.metrics.snapshotMs += elapsed;
    this.metrics.snapshotMaxMs = Math.max(this.metrics.snapshotMaxMs, elapsed);
    if (replace) {
      tail.history = history;
      this.metrics.coalescedSaves++;
      return tail.completion;
    }
    const batch: SaveBatch = { ...pending, history, completion: Promise.resolve() };
    batch.completion = this.enqueue(async () => {
      if (this.tailSave === batch) { this.tailSave = undefined; }
      const started = performance.now();
      this.metrics.savesStarted++;
      try {
        await this.store.save(batch.identity, batch.workspacePath, batch.history);
        this.saveFailure = undefined;
        this.metrics.savesCompleted++;
      } catch (error) {
        this.saveFailure = { error };
        this.metrics.saveFailures++;
        throw error;
      } finally {
        const duration = performance.now() - started;
        this.metrics.saveMs += duration;
        this.metrics.saveMaxMs = Math.max(this.metrics.saveMaxMs, duration);
      }
    });
    this.tailSave = batch;
    return batch.completion;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.requireQueueSpace();
    this.tailSave = undefined;
    const queuedAt = performance.now();
    this.metrics.queueCurrent++;
    this.metrics.queueMax = Math.max(this.metrics.queueMax, this.metrics.queueCurrent);
    const result = this.saveChain.then(async () => {
      const wait = performance.now() - queuedAt;
      this.metrics.queueWaitMs += wait;
      this.metrics.queueWaitMaxMs = Math.max(this.metrics.queueWaitMaxMs, wait);
      try { return await operation(); }
      finally { this.metrics.queueCurrent--; }
    });
    this.saveChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireQueueSpace(): void {
    if (this.metrics.queueCurrent >= this.maxQueuedOperations) { throw new Error("History persistence queue is full. Await flush() before retrying."); }
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
  }

  private reportSaveError(error: unknown): void {
    const message = normalizeErrorMessage(error);
    this.logger.error(`Chat history save failed: ${message}`);
    this.onSaveError(message);
  }
}

export function normalizeHistory(value: unknown): PersistedChatHistory {
  validateHistory(value);
  const object = value;
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
    modelLabel: typeof value.modelId === "string"
      ? typeof value.modelLabel === "string" && value.modelLabel.trim() ? value.modelLabel.trim() : value.modelId
      : "Авто",
    effort: normalizeChatEffort(value.effort),
    speed: normalizeChatSpeed(value.speed),
    queuedMessages: normalizeQueuedMessages(value.queuedMessages),
    rulesEnabled: kind === "project" ? value.rulesEnabled !== false : false,
    pendingApproval: null,
    backendThreadAccessMode: normalizeOptionalChatAccessMode(value.backendThreadAccessMode),
    backendThreadId: typeof value.backendThreadId === "string" ? value.backendThreadId : null,
    backendContextRestored: typeof value.backendContextRestored === "boolean" ? value.backendContextRestored : undefined,
    backendWorkspacePath: typeof value.backendWorkspacePath === "string" ? value.backendWorkspacePath : undefined,
    activeTurnId: null,
    activeRunMode: null
  };
}

function normalizeQueuedMessages(value: unknown): ChatSummary["queuedMessages"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isObject(entry) || entry.dispatchState === "accepted" || typeof entry.id !== "string" || typeof entry.text !== "string") {
      return [];
    }
    const attachments = normalizeAttachments(entry.attachments);
    if (!entry.text.trim() && !attachments.length) {
      return [];
    }
    return [{
      id: entry.id,
      text: entry.text.trim(),
      mode: entry.mode === "planning" || entry.mode === "implementPlan" ? entry.mode : "normal",
      skills: normalizeSkillSelections(entry.skills),
      attachments,
      dispatchState: entry.dispatchState === "failed" || entry.dispatchState === "dispatching" ? "failed" as const : "queued" as const,
      dispatchError: entry.dispatchState === "dispatching" ? "Отправка была прервана перезапуском. Проверьте ответ перед повтором." : typeof entry.dispatchError === "string" ? entry.dispatchError : undefined,
      dispatchAttempt: typeof entry.dispatchAttempt === "number" ? entry.dispatchAttempt : undefined,
      transcriptMessageId: typeof entry.transcriptMessageId === "string" ? entry.transcriptMessageId : undefined,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString()
    }];
  });
}

function normalizeAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isObject(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.name !== "string"
      || typeof candidate.path !== "string"
      || typeof candidate.displayPath !== "string"
      || (candidate.kind !== "file" && candidate.kind !== "folder" && candidate.kind !== "image")) {
      return [];
    }
    return [{
      id: candidate.id,
      kind: candidate.kind as ChatAttachment["kind"],
      name: candidate.name,
      path: candidate.path,
      displayPath: candidate.displayPath,
      sizeBytes: typeof candidate.sizeBytes === "number" ? candidate.sizeBytes : undefined,
      source: candidate.source === "upload"
        ? "upload" as const
        : candidate.source === "workspace"
          ? "workspace" as const
          : undefined
    }];
  }).slice(0, 10);
}

function normalizeSkillSelections(value: unknown): ChatSummary["queuedMessages"][number]["skills"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isObject(candidate) || typeof candidate.name !== "string" || typeof candidate.path !== "string") {
      return [];
    }
    return [{ name: candidate.name, path: candidate.path }];
  });
}

function normalizeTranscriptItem(value: unknown): ChatTranscriptItem | undefined {
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
      ? value.files.map(normalizeDiffFile).filter((file): file is NonNullable<ReturnType<typeof normalizeDiffFile>> => Boolean(file))
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
      answer: typeof value.answer === "string" ? value.answer : undefined,
      backendThreadId: typeof value.backendThreadId === "string" ? value.backendThreadId : undefined,
      backendItemId: typeof value.backendItemId === "string" ? value.backendItemId : undefined,
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
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    attachments: normalizeAttachments(value.attachments),
    questions: normalizeMessageQuestions(value.questions),
    backendThreadId: typeof value.backendThreadId === "string" ? value.backendThreadId : undefined,
    backendItemId: typeof value.backendItemId === "string" ? value.backendItemId : undefined
  };
}

function normalizeMessageQuestions(value: unknown): ChatMessageQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((question) => ({
    id: question.id, title: question.title, options: question.options === null ? null : [...question.options],
    answer: typeof question.answer === "string" ? question.answer : undefined
  }));
}

function normalizeClarificationOptions(value: unknown): ChatClarificationOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((option): ChatClarificationOption | undefined => {
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
    .filter((option): option is ChatClarificationOption => Boolean(option))
    .slice(0, 5);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || seen.has(item)) {
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function normalizeTurnRunCounts(value: Record<string, unknown>): Partial<Record<ChatTurnRunCounterKind, number>> {
  const counts: Partial<Record<ChatTurnRunCounterKind, number>> = {};
  for (const key of ["search", "command", "file", "read", "reasoning", "diagnostics", "context", "tool", "compaction", "diff"] as ChatTurnRunCounterKind[]) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      counts[key] = Math.floor(count);
    }
  }
  return counts;
}

function isHiddenLegacyActivity(label: string, activityKind: unknown): boolean {
  const normalizedLabel = label.trim();
  return (
    normalizedLabel === "userMessage"
    || normalizedLabel === "agentMessage"
    || normalizedLabel === "hookPrompt"
    || normalizedLabel === "contextCompaction"
    || normalizedLabel === "plan"
    || (activityKind === "unknown" && /^userMessage\b/i.test(normalizedLabel))
    || activityKind === "unknown"
    || (activityKind === "reasoning" && normalizedLabel === "Думал")
  );
}

function normalizeActivityKind(value: unknown): ChatActivityKind {
  if (value === "turn" || value === "command" || value === "file" || value === "search" || value === "reasoning" || value === "context" || value === "tool") {
    return value;
  }
  return "unknown";
}

function normalizeWorklogOperationKind(value: unknown): WorklogOperationKind {
  if (value === "search" || value === "command" || value === "file" || value === "read" || value === "reasoning" || value === "diagnostics" || value === "context" || value === "tool") {
    return value;
  }
  return "tool";
}

function normalizeWorklogStatus(value: unknown): WorklogStatus {
  if (value === "completed" || value === "error") {
    return value;
  }
  return "running";
}

function normalizeWorklogSource(value: unknown): WorklogSource | undefined {
  if (value === "project" || value === "docs" || value === "web" || value === "shell" || value === "ide" || value === "runtime") {
    return value;
  }
  return undefined;
}

function normalizeWorklogChildren(value: unknown): WorklogChild[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): WorklogChild | undefined => {
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
        server: typeof item.server === "string" ? item.server : undefined,
        tool: typeof item.tool === "string" ? item.tool : undefined,
        argumentsPreview: typeof item.argumentsPreview === "string" ? item.argumentsPreview : undefined,
        resultCount: typeof item.resultCount === "number" && Number.isFinite(item.resultCount) ? item.resultCount : undefined,
        outputPreview: typeof item.outputPreview === "string" ? item.outputPreview : undefined,
        createdAt,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined
      };
    })
    .filter((item): item is WorklogChild => Boolean(item));
}

function normalizeActivityDetails(value: unknown): ChatActivityDetail[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const details = value
    .map((item): ChatActivityDetail | undefined => {
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
    .filter((item): item is ChatActivityDetail => Boolean(item))
    .slice(0, 40);
  return details.length ? details : undefined;
}

function normalizeDiffFile(value: unknown): ChatDiffFileSummary | undefined {
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
    diff: typeof value.diff === "string" ? value.diff.slice(0, 2048) : undefined,
    truncated: value.truncated === true || typeof value.diff === "string" && value.diff.length > 2048,
    patchArtifact: normalizePatchArtifact(value.patchArtifact)
  };
}

function normalizePatchArtifact(value: unknown): ChatDiffFileSummary["patchArtifact"] {
  const maxBytes = 8 * 1024 * 1024;
  if (!isObject(value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
    || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope)
    || typeof value.start !== "number" || !Number.isSafeInteger(value.start) || value.start < 0 || value.start > maxBytes
    || typeof value.length !== "number" || !Number.isSafeInteger(value.length) || value.length < 0 || value.length > maxBytes
    || value.start + value.length > maxBytes) { return undefined; }
  return { id: value.id, scope: value.scope, start: value.start, length: value.length };
}

function normalizeDiffStatus(value: unknown): ChatDiffFileStatus | undefined {
  if (value === "added" || value === "modified" || value === "deleted" || value === "renamed" || value === "unknown") {
    return value;
  }
  return undefined;
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
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra") {
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

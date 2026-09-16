import type { ChatBridgeFrame, ChatBridgeMeta } from "../../src/chatPanelManager";
import type { ChatAttachment, ChatTranscriptItem, ChatTurnRunTranscriptItem, SkillSelection } from "../../src/types";

export interface Draft { text: string; attachments: ChatAttachment[]; skills: SkillSelection[]; planning: boolean }
export interface SavedState {
  activeChatId?: string;
  drafts?: Record<string, Draft>;
  anchors?: Record<string, { index: number; offset: number; following: boolean }>;
}
interface VsCodeApi { postMessage(value: unknown): void; getState(): SavedState | undefined; setState(value: SavedState): void }
declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
export const saved = vscode.getState() ?? {};
export const emptyDraft = (): Draft => ({ text: "", attachments: [], skills: [], planning: false });
export function saveDraft(chatId: string, draft: Draft): void {
  saved.drafts ??= {};
  saved.drafts[chatId] = draft;
  vscode.setState(saved);
}
export function command(chatId: string, name: string, payload?: unknown): void {
  vscode.postMessage({ type: "command", chatId, command: name, payload });
}
export interface ChatView {
  chatId: string; meta: ChatBridgeMeta | null; total: number; revision: number;
  rows: ReadonlyMap<number, ChatTranscriptItem>; turns: ReadonlyMap<string, ChatTurnRunTranscriptItem>;
}
export interface HostEvent { type: string; event?: string; chatId?: string; payload?: any; requestId?: string; result?: any; error?: string }
type Subscriber = () => void;

export class ChatStore {
  private view: ChatView = { chatId: "", meta: null, total: 0, revision: 0, rows: new Map(), turns: new Map() };
  private subscribers = new Set<Subscriber>();
  private events = new Set<(event: HostEvent) => void>();
  private epoch = "";
  private retiredEpochs = new Set<string>();
  private revision = 0;
  private viewport = 0;
  private pinned = new Set<number>();
  private requestCounter = 0;
  private receiveMs = 0;
  private eventLoopLagMs = 0;
  private lagTimer: ReturnType<typeof setInterval> | undefined;
  private requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor() {
    let expected = performance.now() + 1000;
    let wasVisible = document.visibilityState === "visible";
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      // Background-tab timer clamping is not a foreground UI stall.
      const visible = document.visibilityState === "visible";
      if (visible && wasVisible) this.eventLoopLagMs = Math.max(this.eventLoopLagMs, Math.min(3_600_000, Math.max(0, now - expected)));
      wasVisible = visible;
      expected = now + 1000;
    }, 1000);
  }
  subscribe = (fn: Subscriber): (() => void) => { this.subscribers.add(fn); return () => this.subscribers.delete(fn); };
  getSnapshot = (): ChatView => this.view;
  onEvent = (fn: (event: HostEvent) => void): (() => void) => { this.events.add(fn); return () => this.events.delete(fn); };
  pin(indices: number[]): void { this.pinned = new Set(indices); }
  setViewport(index: number): void {
    if (Math.abs(index - this.viewport) < 20 && this.view.rows.has(index)) return;
    this.viewport = index;
    vscode.postMessage({ type: "chat.viewport", chatId: this.view.chatId, offset: Math.max(0, index) });
  }
  request(commandName: string, payload?: unknown, chatId = this.view.chatId): Promise<any> {
    if (this.requests.size >= 32) return Promise.reject(new Error("Слишком много запросов. Дождитесь завершения."));
    const requestId = `${Date.now().toString(36)}-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error("Время ожидания истекло. Обновите список перед повтором."));
      }, 30000);
      this.requests.set(requestId, { resolve, reject, timer });
      vscode.postMessage({ type: "features.request", requestId, chatId, command: commandName, payload });
    });
  }
  receive = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const event = raw as HostEvent;
    if (event.type === "features.result" && event.requestId) {
      const pending = this.requests.get(event.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.requests.delete(event.requestId);
      if (event.error) pending.reject(new Error(event.error)); else pending.resolve(event.result);
      return;
    }
    if (event.type !== "chat.bridge") {
      if (event.event === "chat.jump" && event.chatId && Number.isSafeInteger(event.payload?.offset)) {
        saved.anchors ??= {};
        saved.anchors[event.chatId] = { index: event.payload.offset, offset: 0, following: false };
        vscode.setState(saved);
      }
      const chatId = event.chatId ?? event.payload?.chatId;
      if (chatId && chatId !== this.view.chatId) {
        const draft = saved.drafts?.[chatId] ?? emptyDraft();
        if (event.event === "chat.error" && typeof event.payload?.restorePrompt === "string") {
          saveDraft(chatId, { ...draft, text: draft.text ? `${draft.text}\n\n${event.payload.restorePrompt}` : event.payload.restorePrompt,
            attachments: [...new Map([...draft.attachments, ...(event.payload.restoreAttachments ?? [])].map(item => [item.id, item])).values()].slice(0, 10) });
        }
        if (event.event === "chat.attachments.selected" && Array.isArray(event.payload?.attachments)) saveDraft(chatId, { ...draft, attachments: event.payload.attachments });
      }
      for (const fn of this.events) fn(event);
      return;
    }
    const frame = raw as ChatBridgeFrame;
    const startedAt = performance.now();
    if (!Array.isArray(frame.rows) || !Array.isArray(frame.appends) || !Number.isSafeInteger(frame.revision)
      || !Number.isSafeInteger(frame.totalCount) || frame.totalCount < 0 || typeof frame.epoch !== "string") return;
    if (this.retiredEpochs.has(frame.epoch)) return;
    if (frame.kind !== "snapshot" && frame.kind !== "patch") return;
    if (frame.kind === "snapshot" && (frame.revision !== 1 || frame.baseRevision !== 0 || frame.meta === undefined)) return;
    if (frame.epoch === this.epoch && frame.revision <= this.revision) { this.ack(); return; }
    if (frame.kind !== "snapshot" && (frame.epoch !== this.epoch || frame.baseRevision !== this.revision || frame.chatId !== this.view.chatId)) {
      vscode.postMessage({ type: "chat.resync", chatId: this.view.chatId, epoch: this.epoch, revision: this.revision });
      return;
    }
    const changedChat = frame.chatId !== this.view.chatId;
    const rows = new Map(changedChat ? [] : this.view.rows);
    const turns = new Map(changedChat ? [] : this.view.turns);
    if (changedChat) { this.viewport = 0; this.pinned.clear(); }
    for (const { index, item } of frame.rows) {
      if (Number.isSafeInteger(index) && index >= 0 && index < frame.totalCount && item?.id) rows.set(index, item);
    }
    for (const append of frame.appends) {
      const previous = rows.get(append.index);
      if (previous?.kind !== "message" || previous.id !== append.id) {
        vscode.postMessage({ type: "chat.resync", chatId: frame.chatId });
        return;
      }
      rows.set(append.index, { ...previous, text: previous.text + append.text, status: append.status });
    }
    for (const item of frame.turns ?? []) if (item.kind === "turn-run") turns.set(item.turnId, item);
    for (const [index] of rows) if (index >= frame.totalCount) rows.delete(index);
    // Retain the reading window, live tail, and selected nodes, not 10k message bodies.
    if (rows.size > 600) {
      const removable = [...rows.keys()].filter(index => !this.pinned.has(index))
        .sort((a, b) => this.distance(b, frame.totalCount) - this.distance(a, frame.totalCount));
      for (const index of removable) { if (rows.size <= 480) break; rows.delete(index); }
    }
    const referencedTurns = new Set([...rows.values()].flatMap(item => "turnId" in item && item.turnId ? [item.turnId] : []));
    for (const id of turns.keys()) if (!referencedTurns.has(id)) turns.delete(id);
    if (this.epoch && this.epoch !== frame.epoch) {
      this.retiredEpochs.add(this.epoch);
      if (this.retiredEpochs.size > 8) this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    }
    this.epoch = frame.epoch;
    this.revision = frame.revision;
    this.view = { chatId: frame.chatId, meta: frame.meta === undefined ? this.view.meta : frame.meta,
      total: frame.totalCount, revision: frame.revision, rows, turns };
    if (changedChat) { saved.activeChatId = frame.chatId; vscode.setState(saved); }
    for (const fn of this.subscribers) fn();
    this.receiveMs = Math.max(this.receiveMs, performance.now() - startedAt);
    // ACK means the bounded entity store accepted the frame, not durable history storage.
    this.ack();
  };
  private distance(index: number, total: number): number { return Math.min(Math.abs(index - this.viewport), Math.abs(total - index)); }
  private ack(): void {
    vscode.postMessage({ type: "chat.ack", chatId: this.view.chatId, epoch: this.epoch, revision: this.revision,
      metrics: { eventLoopLagMs: this.eventLoopLagMs, receiveMs: this.receiveMs } });
    this.eventLoopLagMs = 0; this.receiveMs = 0;
  }
  dispose(): void {
    clearInterval(this.lagTimer);
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error("Панель закрыта.")); }
    this.requests.clear(); this.subscribers.clear(); this.events.clear();
  }
}
export const store = new ChatStore();

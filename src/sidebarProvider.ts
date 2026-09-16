import * as vscode from "vscode";
import { Logger } from "./logger";
import { StateStore } from "./stateStore";
import { ChatKind, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private dirty = false;
  private sending = false;
  private waitingAck = 0;
  private revision = 0;
  private lastSnapshot = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly metrics = { frames: 0, bytes: 0, maxFrameBytes: 0, failures: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly handlers: SidebarHandlers
  ) {}

  getMetrics(): object { return { ...this.metrics, pendingPosts: Number(this.sending), pendingAck: Number(Boolean(this.waitingAck)), ready: this.ready }; }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    this.waitingAck = 0;
    this.lastSnapshot = "";
    this.logger.info("Sidebar webview resolved.");

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };

    webviewView.webview.html = renderWebviewHtml({
      extensionUri: this.context.extensionUri,
      webview: webviewView.webview,
      scriptPath: "media/sidebar.js",
      stylePath: "media/sidebar.css",
      title: "Codex"
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView === this.view && webviewView.visible) {
        this.ready = true; this.waitingAck = 0; this.lastSnapshot = ""; this.postSnapshot();
      }
    });
    webviewView.onDidDispose(() => {
      if (webviewView !== this.view) return;
      this.ready = false; this.view = undefined; this.waitingAck = 0; this.lastSnapshot = "";
      clearTimeout(this.timer); this.timer = undefined;
    });
    webviewView.webview.onDidReceiveMessage((message: WebviewCommand | { type: "sidebar.ack"; revision: number }) => {
      if (webviewView !== this.view) return;
      if (message?.type === "sidebar.ack") {
        if (message.revision === this.waitingAck) { this.waitingAck = 0; if (this.dirty) this.postSnapshot(); }
        return;
      }
      void this.handleMessage(message).catch((error) => {
        const detail = error instanceof Error ? error.message : "Не удалось выполнить действие.";
        this.logger.warn(`Sidebar action failed: ${detail}`);
        this.postEvent("shell.notice", detail);
      });
    });
  }

  postSnapshot(): void {
    this.dirty = true;
    if (this.timer || !this.ready || !this.view || this.view.visible === false || this.sending || this.waitingAck) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flushSnapshot(); }, 100);
  }

  private async flushSnapshot(): Promise<void> {
    const view = this.view;
    if (!view || !this.ready || view.visible === false || this.sending || this.waitingAck || !this.dirty) return;
    this.dirty = false;
    const raw = this.state.getSidebarSnapshot();
    // The list does not need queued prompt bodies, attachments, approvals or backend identifiers.
    const snapshot = { kind: raw.kind, auth: raw.auth, proxy: raw.proxy, activeChatId: raw.activeChatId, rateLimits: raw.rateLimits,
      chats: raw.chats.map(chat => ({ id: chat.id, title: chat.title, kind: chat.kind, status: chat.status, hasUnread: chat.hasUnread,
        archivedAt: chat.archivedAt, updatedAt: chat.updatedAt })) };
    const key = JSON.stringify({ ...snapshot, chats: snapshot.chats.map(chat => ({ ...chat,
      updatedAt: ["running", "cancelling", "waitingApproval"].includes(chat.status) ? "" : chat.updatedAt })) });
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    const frame = { type: "sidebar.snapshot", revision: ++this.revision, snapshot };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    this.metrics.frames++; this.metrics.bytes += bytes; this.metrics.maxFrameBytes = Math.max(this.metrics.maxFrameBytes, bytes);
    this.sending = true;
    this.waitingAck = frame.revision;
    try {
      if (!await view.webview.postMessage(frame)) {
        this.metrics.failures++;
        if (this.view === view) { this.ready = false; this.waitingAck = 0; this.lastSnapshot = ""; this.dirty = true; }
      }
    } catch {
      this.metrics.failures++;
      if (this.view === view) { this.ready = false; this.waitingAck = 0; this.lastSnapshot = ""; this.dirty = true; }
    } finally { this.sending = false; if (this.dirty) this.postSnapshot(); }
  }

  postEvent(event: string, payload?: unknown): void {
    this.view?.webview.postMessage({ type: "event", event, payload });
  }

  private async handleMessage(message: WebviewCommand): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ready") {
      this.ready = true;
      this.waitingAck = 0;
      this.lastSnapshot = "";
      this.logger.info("Sidebar webview ready.");
      this.logger.info(`Sidebar webview assets: ${message.assetMode ?? "unknown"}.`);
      this.postSnapshot();
      this.logger.info("Auth restore requested from sidebar ready.");
      void this.handlers.restoreAuth().catch((error) => this.postEvent("shell.notice", error instanceof Error ? error.message : "Не удалось проверить авторизацию."));
      return;
    }

    if (message.type !== "command") {
      return;
    }

    this.logger.info(`Sidebar command: ${message.command}`);

    switch (message.command) {
      case "auth.restore":
        await this.handlers.restoreAuth();
        return;
      case "auth.deviceCode.start":
        await this.handlers.startDeviceCodeLogin();
        return;
      case "auth.deviceCode.openUrl":
        await this.handlers.openDeviceCodeUrl();
        return;
      case "auth.deviceCode.copyCode":
        await this.handlers.copyDeviceCode();
        return;
      case "auth.deviceCode.copyUrl":
        await this.handlers.copyDeviceCodeUrl();
        return;
      case "auth.deviceCode.copyBundle":
        await this.handlers.copyDeviceCodeBundle();
        return;
      case "auth.apiKey.login":
        if (isObject(message.payload) && typeof message.payload.apiKey === "string") {
          await this.handlers.loginWithApiKey(message.payload.apiKey);
        }
        return;
      case "auth.logout":
        await this.handlers.logoutAccount();
        return;
      case "settings.proxy.open":
      case "settings.open":
        await this.handlers.openSettings();
        return;
      case "logs.open":
        this.handlers.openLogs();
        return;
      case "chat.createProject":
        await this.handlers.createChat("project");
        return;
      case "chat.createGeneral":
        await this.handlers.createChat("general");
        return;
      case "chat.open":
        if (isObject(message.payload) && typeof message.payload.chatId === "string") {
          await this.handlers.openChat(message.payload.chatId);
        }
        return;
      case "chat.rename":
        if (isObject(message.payload) && typeof message.payload.chatId === "string") {
          await this.handlers.renameChat(message.payload.chatId);
        }
        return;
      case "chat.archive":
        if (isObject(message.payload) && typeof message.payload.chatId === "string") {
          await this.handlers.archiveChat(message.payload.chatId);
        }
        return;
      case "chat.restore":
        if (isObject(message.payload) && typeof message.payload.chatId === "string") {
          await this.handlers.restoreChat(message.payload.chatId);
        }
        return;
      case "chat.delete":
        if (isObject(message.payload) && typeof message.payload.chatId === "string") {
          await this.handlers.deleteChat(message.payload.chatId);
        }
        return;
      default:
        this.postEvent("shell.notice", `Команда ${message.command} пока не подключена.`);
    }
  }
}

export interface SidebarHandlers {
  createChat(kind: ChatKind): Promise<void>;
  openChat(chatId: string): Promise<void>;
  renameChat(chatId: string): Promise<void>;
  archiveChat(chatId: string): Promise<void>;
  restoreChat(chatId: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  openSettings(): Promise<void>;
  openLogs(): void;
  restoreAuth(): Promise<void>;
  startDeviceCodeLogin(): Promise<void>;
  loginWithApiKey(apiKey: string): Promise<void>;
  logoutAccount(): Promise<void>;
  openDeviceCodeUrl(): Promise<void>;
  copyDeviceCode(): Promise<void>;
  copyDeviceCodeUrl(): Promise<void>;
  copyDeviceCodeBundle(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

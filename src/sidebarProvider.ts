import * as vscode from "vscode";
import { Logger } from "./logger";
import { StateStore } from "./stateStore";
import { ChatKind, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly handlers: SidebarHandlers
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
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

    webviewView.webview.onDidReceiveMessage((message: WebviewCommand) => {
      void this.handleMessage(message);
    });
  }

  postSnapshot(): void {
    this.view?.webview.postMessage({
      type: "sidebar.snapshot",
      snapshot: this.state.getSidebarSnapshot()
    });
  }

  postEvent(event: string, payload?: unknown): void {
    this.view?.webview.postMessage({ type: "event", event, payload });
  }

  private async handleMessage(message: WebviewCommand): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ready") {
      this.logger.info("Sidebar webview ready.");
      this.logger.info(`Sidebar webview assets: ${message.assetMode ?? "unknown"}.`);
      this.postSnapshot();
      void this.handlers.restoreAuth();
      return;
    }

    if (message.type !== "command") {
      return;
    }

    this.logger.info(`Sidebar command: ${message.command}`);

    switch (message.command) {
      case "auth.deviceCode.start":
        await this.handlers.startDeviceCodeLogin();
        return;
      case "auth.deviceCode.openUrl":
        await this.handlers.openDeviceCodeUrl();
        return;
      case "auth.deviceCode.copyCode":
        await this.handlers.copyDeviceCode();
        return;
      case "auth.apiKey.login":
        if (isObject(message.payload) && typeof message.payload.apiKey === "string") {
          await this.handlers.loginWithApiKey(message.payload.apiKey);
        }
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
        this.postEvent("shell.notice", "Архивация будет добавлена позже.");
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
  openSettings(): Promise<void>;
  openLogs(): void;
  restoreAuth(): Promise<void>;
  startDeviceCodeLogin(): Promise<void>;
  loginWithApiKey(apiKey: string): Promise<void>;
  openDeviceCodeUrl(): Promise<void>;
  copyDeviceCode(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

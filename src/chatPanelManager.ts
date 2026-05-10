import * as vscode from "vscode";
import { Logger } from "./logger";
import { StateStore } from "./stateStore";
import { ChatPanelState, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";

export class ChatPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: StateStore,
    private readonly logger: Logger
  ) {}

  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, rawState) => {
        const state = parsePanelState(rawState);
        if (!state) {
          panel.dispose();
          return;
        }
        this.logger.info(`Restoring chat panel ${state.chatId}.`);
        this.setupPanel(panel, state.chatId);
      }
    });
  }

  openChat(chatId: string): void {
    const existing = this.panels.get(chatId);
    if (existing) {
      existing.reveal();
      return;
    }

    const chat = this.state.getChat(chatId);
    if (!chat) {
      vscode.window.showWarningMessage("Чат не найден.");
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_VIEW_TYPE,
      chat.title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
          vscode.Uri.joinPath(this.context.extensionUri, "resources")
        ]
      }
    );

    this.setupPanel(panel, chatId);
  }

  postSnapshot(chatId: string): void {
    const panel = this.panels.get(chatId);
    const snapshot = this.state.getChatSnapshot(chatId);
    if (!panel || !snapshot) {
      return;
    }
    panel.webview.postMessage({ type: "chat.snapshot", snapshot });
  }

  private setupPanel(panel: vscode.WebviewPanel, chatId: string): void {
    const chat = this.state.getChat(chatId);
    panel.title = chat?.title ?? "Codex";
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icons", "codex.svg");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources")
      ]
    };
    panel.webview.html = renderWebviewHtml({
      extensionUri: this.context.extensionUri,
      webview: panel.webview,
      scriptPath: "media/chat.js",
      stylePath: "media/chat.css",
      title: panel.title,
      rootData: {
        "chat-id": chatId
      }
    });

    this.panels.set(chatId, panel);

    panel.webview.onDidReceiveMessage((message: WebviewCommand) => {
      this.handleMessage(panel, chatId, message);
    });

    panel.onDidDispose(() => {
      this.panels.delete(chatId);
      this.logger.info(`Chat panel disposed: ${chatId}.`);
    });
  }

  private handleMessage(panel: vscode.WebviewPanel, chatId: string, message: WebviewCommand): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ready") {
      this.logger.info(`Chat panel webview ready ${chatId}.`);
      this.logger.info(`Chat panel webview assets ${chatId}: ${message.assetMode ?? "unknown"}.`);
      panel.webview.postMessage({
        type: "chat.snapshot",
        snapshot: this.state.getChatSnapshot(chatId)
      });
      return;
    }

    if (message.type !== "command") {
      return;
    }

    this.logger.info(`Chat panel command ${chatId}: ${message.command}`);
    panel.webview.postMessage({
      type: "event",
      event: "shell.notice",
      payload: "Команда принята UI shell. Runtime будет подключен в следующих итерациях."
    });
  }
}

function parsePanelState(rawState: unknown): ChatPanelState | undefined {
  if (!rawState || typeof rawState !== "object") {
    return undefined;
  }
  const value = rawState as Record<string, unknown>;
  return typeof value.chatId === "string" ? { chatId: value.chatId } : undefined;
}

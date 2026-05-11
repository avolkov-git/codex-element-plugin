import * as vscode from "vscode";
import { Logger } from "./logger";
import { getCodexPanelIconPath } from "./panelIcon";
import { StateStore } from "./stateStore";
import { ChatPanelState, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";

export interface ChatPanelHandlers {
  sendPrompt(chatId: string, prompt: string): Promise<void>;
  markReadToBottom(chatId: string): void;
  toggleRules(chatId: string): Promise<void>;
  resolveApproval(chatId: string, approvalId: string, approved: boolean): Promise<void> | void;
}

export class ChatPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly handlers: ChatPanelHandlers
  ) {}

  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, rawState) => {
        if (this.panel) {
          panel.dispose();
          return;
        }

        const restoredState = parsePanelState(rawState);
        const restoredChatId = restoredState?.activeChatId ?? restoredState?.chatId;
        if (restoredChatId && this.state.getChat(restoredChatId)) {
          this.state.setActiveChat(restoredChatId);
        }

        this.logger.info(`Restoring singleton chat panel${restoredChatId ? ` for ${restoredChatId}` : ""}.`);
        this.setupPanel(panel);
      }
    });
  }

  openChat(chatId: string): void {
    const chat = this.state.getChat(chatId);
    if (!chat) {
      vscode.window.showWarningMessage("Чат не найден.");
      return;
    }
    this.state.setActiveChat(chatId);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.postActiveSnapshot();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_VIEW_TYPE,
      "Codex",
      vscode.ViewColumn.One,
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

    this.setupPanel(panel);
  }

  postSnapshot(chatId?: string): void {
    if (chatId && chatId !== this.state.getActiveChatId()) {
      return;
    }
    this.postActiveSnapshot();
  }

  postAllSnapshots(): void {
    this.postActiveSnapshot();
  }

  private postActiveSnapshot(): void {
    this.panel?.webview.postMessage({
      type: "chat.snapshot",
      snapshot: this.state.getActiveChatSnapshot() ?? null
    });
  }

  private setupPanel(panel: vscode.WebviewPanel): void {
    panel.title = "Codex";
    panel.iconPath = getCodexPanelIconPath(this.context);
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
        "panel-kind": "active-chat"
      }
    });

    this.panel = panel;

    panel.webview.onDidReceiveMessage((message: WebviewCommand) => {
      void this.handleMessage(panel, message);
    });

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
      this.logger.info("Singleton chat panel disposed.");
    });
  }

  private async handleMessage(panel: vscode.WebviewPanel, message: WebviewCommand): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ready") {
      this.logger.info("Chat panel webview ready.");
      this.logger.info(`Chat panel webview assets: ${message.assetMode ?? "unknown"}.`);
      this.postActiveSnapshot();
      return;
    }

    if (message.type !== "command") {
      return;
    }

    if (message.command === "chat.readToBottom") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      this.handlers.markReadToBottom(chatId);
      return;
    }

    if (message.command === "chat.rules.toggle") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      await this.handlers.toggleRules(chatId);
      return;
    }

    if (message.command === "approval.approve" || message.command === "approval.deny") {
      const chatId = this.state.getActiveChatId();
      if (!chatId || !isObject(message.payload) || typeof message.payload.approvalId !== "string") {
        return;
      }
      await this.handlers.resolveApproval(chatId, message.payload.approvalId, message.command === "approval.approve");
      return;
    }

    this.logger.info(`Chat panel command: ${message.command}`);
    if (message.command === "chat.send") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: "Выберите диалог в sidebar или создайте новый."
        });
        return;
      }
      if (!isObject(message.payload) || typeof message.payload.prompt !== "string") {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: "Введите сообщение для Codex."
        });
        return;
      }

      await this.handlers.sendPrompt(chatId, message.payload.prompt);
      return;
    }

    panel.webview.postMessage({
      type: "event",
      event: "chat.error",
      payload: `Команда ${message.command} пока не подключена.`
    });
  }
}

function parsePanelState(rawState: unknown): ChatPanelState | undefined {
  if (!rawState || typeof rawState !== "object") {
    return {};
  }
  const value = rawState as Record<string, unknown>;
  const activeChatId = typeof value.activeChatId === "string" ? value.activeChatId : undefined;
  const chatId = typeof value.chatId === "string" ? value.chatId : undefined;
  return { activeChatId, chatId };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

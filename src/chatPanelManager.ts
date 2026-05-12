import * as vscode from "vscode";
import { Logger } from "./logger";
import { getCodexPanelIconPath } from "./panelIcon";
import { StateStore } from "./stateStore";
import { ChatAccessMode, ChatEffort, ChatHeaderMode, ChatPanelState, ChatRunMode, ChatSpeed, DocsContextDetails, ProjectContextDetails, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";

export interface ChatPanelHandlers {
  sendPrompt(chatId: string, prompt: string, mode?: ChatRunMode, transcriptText?: string): Promise<void>;
  cancelTurn(chatId: string): Promise<void>;
  markReadToBottom(chatId: string): void;
  setAccessMode(chatId: string, accessMode: ChatAccessMode): void;
  setModel(chatId: string, modelId: string | null, modelLabel: string): void;
  setEffort(chatId: string, effort: ChatEffort): void;
  setSpeed(chatId: string, speed: ChatSpeed): void;
  setChatHeaderMode(mode: ChatHeaderMode): Promise<void> | void;
  loadModels(): Promise<void>;
  getProjectContextDetails(): Promise<ProjectContextDetails>;
  getDocsContextDetails(): Promise<DocsContextDetails>;
  toggleRules(chatId: string): Promise<void>;
  openRules(): Promise<void>;
  restoreChat(chatId: string): Promise<void>;
  implementPlan(chatId: string, planText: string): Promise<void>;
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

  closeIfActiveChat(chatId: string): void {
    if (this.state.getActiveChatId() !== chatId) {
      return;
    }
    this.panel?.dispose();
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

    if (message.command === "chat.rules.open") {
      await this.handlers.openRules();
      return;
    }

    if (message.command === "chat.restore") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      await this.handlers.restoreChat(chatId);
      return;
    }

    if (message.command === "chat.header.toggle") {
      await this.handlers.setChatHeaderMode(this.state.getChatHeaderMode() === "collapsed" ? "expanded" : "collapsed");
      return;
    }

    if (message.command === "chat.access.set") {
      const chatId = this.state.getActiveChatId();
      const accessMode = isObject(message.payload) ? parseAccessMode(message.payload.accessMode) : undefined;
      if (!chatId || !accessMode) {
        return;
      }
      this.handlers.setAccessMode(chatId, accessMode);
      return;
    }

    if (message.command === "chat.model.set") {
      const chatId = this.state.getActiveChatId();
      const model = isObject(message.payload) ? parseModelSelection(message.payload) : undefined;
      if (!chatId || !model) {
        return;
      }
      this.handlers.setModel(chatId, model.modelId, model.modelLabel);
      return;
    }

    if (message.command === "chat.effort.set") {
      const chatId = this.state.getActiveChatId();
      const effort = isObject(message.payload) ? parseEffort(message.payload.effort) : undefined;
      if (!chatId || !effort) {
        return;
      }
      this.handlers.setEffort(chatId, effort);
      return;
    }

    if (message.command === "chat.speed.set") {
      const chatId = this.state.getActiveChatId();
      const speed = isObject(message.payload) ? parseSpeed(message.payload.speed) : undefined;
      if (!chatId || !speed) {
        return;
      }
      this.handlers.setSpeed(chatId, speed);
      return;
    }

    if (message.command === "chat.models.load") {
      await this.handlers.loadModels();
      return;
    }

    if (message.command === "chat.context.projectDetails") {
      panel.webview.postMessage({
        type: "event",
        event: "chat.context.details",
        payload: await this.handlers.getProjectContextDetails()
      });
      return;
    }

    if (message.command === "chat.context.docsDetails") {
      panel.webview.postMessage({
        type: "event",
        event: "chat.context.details",
        payload: await this.handlers.getDocsContextDetails()
      });
      return;
    }

    if (message.command === "chat.plan.revise") {
      panel.webview.postMessage({
        type: "event",
        event: "chat.plan.reviseDraft",
        payload: isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : ""
      });
      return;
    }

    if (message.command === "chat.plan.implement") {
      const chatId = this.state.getActiveChatId();
      const planText = isObject(message.payload) && typeof message.payload.planText === "string" ? message.payload.planText : "";
      if (!chatId || !planText.trim()) {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: "План не найден."
        });
        return;
      }
      await this.handlers.implementPlan(chatId, planText);
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
    if (message.command === "chat.cancel") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      await this.handlers.cancelTurn(chatId);
      return;
    }

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
      const chat = this.state.getChat(chatId);
      if (chat?.archivedAt) {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: "Диалог в архиве. Восстановите его, чтобы продолжить."
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

      const mode = parseRunMode(message.payload.mode);
      await this.handlers.sendPrompt(chatId, message.payload.prompt, mode);
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

function parseAccessMode(value: unknown): ChatAccessMode | undefined {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return undefined;
}

function parseEffort(value: unknown): ChatEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function parseSpeed(value: unknown): ChatSpeed | undefined {
  if (value === "standard" || value === "fast") {
    return value;
  }
  return undefined;
}

function parseRunMode(value: unknown): ChatRunMode {
  return value === "planning" || value === "implementPlan" ? value : "normal";
}

function parseModelSelection(payload: Record<string, unknown>): { modelId: string | null; modelLabel: string } | undefined {
  const rawModelId = payload.modelId;
  const modelId = typeof rawModelId === "string" && rawModelId.trim() ? rawModelId.trim() : null;
  const modelLabel = typeof payload.modelLabel === "string" && payload.modelLabel.trim() ? payload.modelLabel.trim() : "";
  if (!modelLabel) {
    return undefined;
  }
  return { modelId, modelLabel };
}

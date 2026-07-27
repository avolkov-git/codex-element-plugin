import * as vscode from "vscode";
import { Logger } from "./logger";
import { parseMarkdownFileTarget, workspaceRelativePathCandidates } from "./markdownFileLink";
import { getCodexPanelIconPath } from "./panelIcon";
import { StateStore } from "./stateStore";
import { ChatAccessMode, ChatAttachment, ChatEffort, ChatHeaderMode, ChatPanelState, ChatRunMode, ChatSpeed, DocsContextDetails, ProjectContextDetails, SkillOption, SkillSelection, WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";

export interface ChatPanelHandlers {
  sendPrompt(chatId: string, prompt: string, mode?: ChatRunMode, transcriptText?: string, skills?: readonly SkillSelection[], attachments?: readonly ChatAttachment[]): Promise<void>;
  queuePrompt(chatId: string, prompt: string, mode?: ChatRunMode, skills?: readonly SkillSelection[], attachments?: readonly ChatAttachment[]): Promise<boolean>;
  steerTurn(chatId: string, prompt: string, attachments?: readonly ChatAttachment[]): Promise<void>;
  pickAttachments(existing: unknown): Promise<ChatAttachment[]>;
  resolveAttachments(value: unknown): Promise<ChatAttachment[]>;
  openAttachment(value: unknown): Promise<void>;
  startAttachmentUpload(chatId: string, value: unknown): Promise<{ uploadId: string }>;
  appendAttachmentUpload(value: unknown): Promise<{ uploadId: string; chatId: string; chunkIndex: number; receivedBytes: number }>;
  completeAttachmentUpload(value: unknown): Promise<{ chatId: string; attachment: ChatAttachment }>;
  cancelAttachmentUpload(value: unknown): Promise<void>;
  discardAttachment(value: unknown): Promise<void>;
  removeQueuedPrompt(chatId: string, messageId: string): boolean;
  moveQueuedPrompt(chatId: string, messageId: string, direction: "up" | "down"): boolean;
  cancelTurn(chatId: string): Promise<void>;
  markReadToBottom(chatId: string): void;
  setAccessMode(chatId: string, accessMode: ChatAccessMode): void;
  setModel(chatId: string, modelId: string | null, modelLabel: string): void;
  setEffort(chatId: string, effort: ChatEffort): void;
  setSpeed(chatId: string, speed: ChatSpeed): void;
  setChatHeaderMode(mode: ChatHeaderMode): Promise<void> | void;
  loadModels(): Promise<void>;
  loadSkills(forceReload?: boolean): Promise<SkillOption[]>;
  getProjectContextDetails(): Promise<ProjectContextDetails>;
  getDocsContextDetails(): Promise<DocsContextDetails>;
  toggleRules(chatId: string): Promise<void>;
  openRules(): Promise<void>;
  restoreChat(chatId: string): Promise<void>;
  implementPlan(chatId: string, planText: string): Promise<void>;
  openDiffInEditor(chatId: string, diffId: string, fileIndex: number): Promise<void>;
  resolveApproval(chatId: string, approvalId: string, approved: boolean): Promise<void> | void;
}

export class ChatPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private skillOptions: SkillOption[] = [];

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
      preloadScriptPaths: ["media/xbsl-highlighter.js"],
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

    if (message.command === "chat.attachments.pick") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      try {
        const attachments = await this.handlers.pickAttachments(isObject(message.payload) ? message.payload.attachments : []);
        await panel.webview.postMessage({ type: "event", event: "chat.attachments.selected", payload: { chatId, attachments } });
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "chat.attachments.error",
          payload: { chatId, message: error instanceof Error ? error.message : "Не удалось прикрепить файл." }
        });
      }
      return;
    }

    if (message.command === "chat.attachment.upload.start") {
      const payload = isObject(message.payload) ? message.payload : {};
      const chatId = typeof payload.chatId === "string" ? payload.chatId : this.state.getActiveChatId();
      if (!chatId || !this.state.getChat(chatId)) {
        return;
      }
      try {
        const result = await this.handlers.startAttachmentUpload(chatId, payload);
        await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.ready", payload: { chatId, ...result } });
      } catch (error) {
        await this.postAttachmentUploadError(panel, chatId, payload, error);
      }
      return;
    }

    if (message.command === "chat.attachment.upload.chunk") {
      try {
        const result = await this.handlers.appendAttachmentUpload(message.payload);
        await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.chunkAccepted", payload: result });
      } catch (error) {
        await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
        await this.postAttachmentUploadError(panel, "", message.payload, error);
      }
      return;
    }

    if (message.command === "chat.attachment.upload.complete") {
      try {
        const result = await this.handlers.completeAttachmentUpload(message.payload);
        await panel.webview.postMessage({ type: "event", event: "chat.attachment.upload.completed", payload: result });
      } catch (error) {
        await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
        await this.postAttachmentUploadError(panel, "", message.payload, error);
      }
      return;
    }

    if (message.command === "chat.attachment.upload.cancel") {
      await this.handlers.cancelAttachmentUpload(message.payload).catch(() => undefined);
      return;
    }

    if (message.command === "chat.attachment.discard") {
      await this.handlers.discardAttachment(isObject(message.payload) ? message.payload.attachment : undefined).catch((error) => {
        this.logger.warn(`Managed attachment cleanup failed: ${error instanceof Error ? error.message : "unknown error"}.`);
      });
      return;
    }

    if (message.command === "chat.attachment.open") {
      try {
        await this.handlers.openAttachment(isObject(message.payload) ? message.payload.attachment : undefined);
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "chat.attachments.error",
          payload: error instanceof Error ? error.message : "Вложение недоступно."
        });
      }
      return;
    }

    if (message.command === "chat.transcript.loadBefore") {
      const chatId = this.state.getActiveChatId();
      const beforeItemId = isObject(message.payload) && typeof message.payload.beforeItemId === "string" ? message.payload.beforeItemId : "";
      const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
      const beforeOffset = isObject(message.payload) && typeof message.payload.beforeOffset === "number" ? message.payload.beforeOffset : undefined;
      if (!chatId || !beforeItemId) {
        return;
      }
      panel.webview.postMessage({
        type: "event",
        event: "chat.transcript.window",
        payload: {
          mode: "before",
          chatId,
          requestId,
          window: this.state.getTranscriptBefore(chatId, beforeItemId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined, beforeOffset)
        }
      });
      return;
    }

    if (message.command === "chat.transcript.loadAfter") {
      const chatId = this.state.getActiveChatId();
      const afterItemId = isObject(message.payload) && typeof message.payload.afterItemId === "string" ? message.payload.afterItemId : "";
      const requestId = isObject(message.payload) && typeof message.payload.requestId === "string" ? message.payload.requestId : "";
      const afterOffset = isObject(message.payload) && typeof message.payload.afterOffset === "number" ? message.payload.afterOffset : undefined;
      if (!chatId || !afterItemId) {
        return;
      }
      panel.webview.postMessage({
        type: "event",
        event: "chat.transcript.window",
        payload: {
          mode: "after",
          chatId,
          requestId,
          window: this.state.getTranscriptAfter(chatId, afterItemId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined, afterOffset)
        }
      });
      return;
    }

    if (message.command === "chat.transcript.tail") {
      const chatId = this.state.getActiveChatId();
      if (!chatId) {
        return;
      }
      panel.webview.postMessage({
        type: "event",
        event: "chat.transcript.window",
        payload: {
          mode: "tail",
          window: this.state.getTranscriptTail(chatId, isObject(message.payload) ? parseTranscriptCount(message.payload.count) : undefined)
        }
      });
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

    if (message.command === "chat.skills.load") {
      try {
        this.skillOptions = await this.handlers.loadSkills(isObject(message.payload) && message.payload.forceReload === true);
        await panel.webview.postMessage({
          type: "event",
          event: "chat.skills.options",
          payload: this.skillOptions
        });
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "chat.skills.error",
          payload: error instanceof Error ? error.message : "Не удалось загрузить навыки."
        });
      }
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

    if (message.command === "diff.openNative") {
      const chatId = this.state.getActiveChatId();
      const diffId = isObject(message.payload) && typeof message.payload.diffId === "string" ? message.payload.diffId : "";
      const fileIndex = isObject(message.payload) ? parseFileIndex(message.payload.fileIndex) : undefined;
      if (!chatId || !diffId || fileIndex === undefined) {
        return;
      }
      await this.handlers.openDiffInEditor(chatId, diffId, fileIndex);
      return;
    }

    if (message.command === "markdown.openLink") {
      const target = isObject(message.payload) && typeof message.payload.target === "string" ? message.payload.target : "";
      await openMarkdownTarget(target);
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

    if (message.command === "chat.queue.remove") {
      const chatId = this.state.getActiveChatId();
      const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
      if (chatId && messageId) {
        this.handlers.removeQueuedPrompt(chatId, messageId);
      }
      return;
    }

    if (message.command === "chat.queue.move") {
      const chatId = this.state.getActiveChatId();
      const messageId = isObject(message.payload) && typeof message.payload.messageId === "string" ? message.payload.messageId : "";
      const direction = isObject(message.payload) && message.payload.direction === "up" ? "up" : "down";
      if (chatId && messageId) {
        this.handlers.moveQueuedPrompt(chatId, messageId, direction);
      }
      return;
    }

    if (message.command === "chat.queue.add" || message.command === "chat.steer") {
      const chatId = this.state.getActiveChatId();
      const prompt = isObject(message.payload) && typeof message.payload.prompt === "string" ? message.payload.prompt.trim() : "";
      const attachments = await this.handlers.resolveAttachments(isObject(message.payload) ? message.payload.attachments : []);
      if (!chatId || (!prompt && !attachments.length)) {
        return;
      }
      try {
        if (message.command === "chat.steer") {
          await this.handlers.steerTurn(chatId, prompt, attachments);
        } else if (!await this.handlers.queuePrompt(
          chatId,
          prompt,
          isObject(message.payload) ? parseRunMode(message.payload.mode) : "normal",
          this.parseSelectedSkills(message.payload),
          attachments
        )) {
          throw new Error("Сообщение можно поставить в очередь только во время активного запроса.");
        }
      } catch (error) {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: {
            message: error instanceof Error ? error.message : "Не удалось отправить сообщение.",
            restorePrompt: prompt,
            restoreAttachments: attachments
          }
        });
      }
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
      const attachments = await this.handlers.resolveAttachments(message.payload.attachments);
      if (!message.payload.prompt.trim() && !attachments.length) {
        panel.webview.postMessage({ type: "event", event: "chat.error", payload: "Введите сообщение или прикрепите файл." });
        return;
      }
      try {
        await this.handlers.sendPrompt(chatId, message.payload.prompt, mode, undefined, this.parseSelectedSkills(message.payload), attachments);
      } catch (error) {
        panel.webview.postMessage({
          type: "event",
          event: "chat.error",
          payload: {
            message: error instanceof Error ? error.message : "Не удалось отправить сообщение.",
            restorePrompt: message.payload.prompt,
            restoreAttachments: attachments
          }
        });
      }
      return;
    }

    panel.webview.postMessage({
      type: "event",
      event: "chat.error",
      payload: `Команда ${message.command} пока не подключена.`
    });
  }

  private async postAttachmentUploadError(
    panel: vscode.WebviewPanel,
    chatId: string,
    value: unknown,
    error: unknown
  ): Promise<void> {
    const payload = isObject(value) ? value : {};
    await panel.webview.postMessage({
      type: "event",
      event: "chat.attachment.upload.error",
      payload: {
        chatId,
        uploadId: typeof payload.uploadId === "string" ? payload.uploadId : "",
        message: error instanceof Error ? error.message : "Не удалось загрузить файл."
      }
    });
  }

  private parseSelectedSkills(payload: unknown): SkillSelection[] {
    if (!isObject(payload) || !Array.isArray(payload.skills) || !this.skillOptions.length) {
      return [];
    }
    const allowed = new Map(
      this.skillOptions
        .filter((skill) => skill.enabled)
        .map((skill) => [`${skill.name}\0${skill.path}`, skill] as const)
    );
    const selected = new Map<string, SkillSelection>();
    for (const candidate of payload.skills.slice(0, 8)) {
      if (!isObject(candidate) || typeof candidate.name !== "string" || typeof candidate.path !== "string") {
        continue;
      }
      const skill = allowed.get(`${candidate.name}\0${candidate.path}`);
      if (skill) {
        selected.set(skill.path, { name: skill.name, path: skill.path });
      }
    }
    return [...selected.values()];
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
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra") {
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

function parseFileIndex(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function openMarkdownTarget(rawTarget: string): Promise<void> {
  const target = decodeMarkdownTarget(rawTarget.trim());
  if (!target) {
    return;
  }

  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }

  const parsedTarget = parseMarkdownFileTarget(target);
  const fileUri = await resolveMarkdownFileUri(parsedTarget.path);
  if (!fileUri) {
    vscode.window.showWarningMessage("Не удалось открыть ссылку из ответа Codex.");
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const line = Math.min(Math.max(0, (parsedTarget.line ?? 1) - 1), Math.max(0, document.lineCount - 1));
    const column = Math.min(
      Math.max(0, (parsedTarget.column ?? 1) - 1),
      document.lineAt(line).range.end.character
    );
    const position = new vscode.Position(line, column);
    await vscode.window.showTextDocument(document, {
      preview: true,
      selection: new vscode.Range(position, position)
    });
  } catch {
    vscode.window.showWarningMessage(`Не удалось открыть файл: ${fileUri.fsPath || parsedTarget.path}`);
  }
}

async function resolveMarkdownFileUri(target: string): Promise<vscode.Uri | undefined> {
  const directUri = markdownTargetToFileUri(target);
  if (directUri && await isFile(directUri)) {
    return directUri;
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const relativePath of workspaceRelativePathCandidates(target, folder.name)) {
      const candidate = vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return directUri;
}

function markdownTargetToFileUri(target: string): vscode.Uri | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(target) || /^[a-zA-Z]:\//.test(target)) {
    return vscode.Uri.file(target);
  }
  if (target.startsWith("/") || target.startsWith("\\\\")) {
    return vscode.Uri.file(target);
  }
  if (/^file:\/\//i.test(target)) {
    const uri = vscode.Uri.parse(target);
    return uri.scheme === "file" ? uri : undefined;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    return undefined;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  return workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, ...target.replace(/\\/g, "/").split("/").filter(Boolean)) : undefined;
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

function decodeMarkdownTarget(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function parseRunMode(value: unknown): ChatRunMode {
  return value === "planning" || value === "implementPlan" ? value : "normal";
}

function parseTranscriptCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(40, Math.floor(value)));
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

import * as vscode from "vscode";
import { ApprovalAttentionService } from "./approvalAttentionService";
import { BaseContextService } from "./baseContextService";
import { ChatPanelManager } from "./chatPanelManager";
import { ChatHistoryService } from "./chatHistoryService";
import { ContextRouterService } from "./contextRouterService";
import { ContextTurnOrchestrator } from "./contextTurnOrchestrator";
import { CodexRuntimeController } from "./codexRuntimeController";
import { DiagnosticsContextService } from "./diagnosticsContextService";
import { DiagnosticsToolsService } from "./diagnosticsToolsService";
import { DiffArtifactService } from "./diffArtifactService";
import { DocsContextService } from "./docsContextService";
import { DocsRetrievalLoopService } from "./docsRetrievalLoopService";
import { DocsNormalizerService } from "./docsNormalizerService";
import { DocsToolsService } from "./docsToolsService";
import { EditorContextKind, EditorContextService } from "./editorContextService";
import { Logger } from "./logger";
import { ManagedContextToolLoopService } from "./managedContextToolLoopService";
import { NativeContextToolLoopService } from "./nativeContextToolLoopService";
import { PerfMarks } from "./performance";
import { ProjectContextService } from "./projectContextService";
import { ProjectToolsService } from "./projectToolsService";
import { RipgrepInstallerService } from "./ripgrepInstallerService";
import { RulesContextService } from "./rulesContextService";
import { SettingsPanelManager } from "./settingsPanelManager";
import { SettingsService } from "./settingsService";
import { SidebarProvider } from "./sidebarProvider";
import { StateMutationMode, StateStore } from "./stateStore";
import { ChatAccessMode, ChatEffort, ChatHeaderMode, ChatKind, ChatRunMode, ChatSpeed } from "./types";
import { UserProfileService } from "./userProfileService";

const CHAT_HEADER_MODE_KEY = "codexElement.chatHeaderMode";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const perf = new PerfMarks();
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info("Codex Element V1 activating.");
  perf.mark("logger");

  const settings = new SettingsService(context);
  try {
    const discoveredRipgrep = await settings.discoverRipgrepPath();
    if (discoveredRipgrep?.ripgrepPath) {
      logger.info(
        `ripgrep discovered: version=${discoveredRipgrep.ripgrepVersion || "-"}; path=${discoveredRipgrep.ripgrepPath}.`
      );
    }
  } catch (error) {
    logger.warn(`ripgrep discovery skipped: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const contextRouter = new ContextRouterService();
  const baseContext = new BaseContextService(context, logger);
  const diagnosticsContext = new DiagnosticsContextService(logger);
  const diffArtifacts = new DiffArtifactService(logger);
  const docsCorpusContext = new DocsContextService(settings, logger);
  const nativeContextTools = new NativeContextToolLoopService(logger);
  const editorContext = new EditorContextService();
  const projectContext = new ProjectContextService(context, settings.getConfigRoot(), logger);
  const profiles = new UserProfileService(context);
  const docsTools = new DocsToolsService(docsCorpusContext, logger);
  const projectTools = new ProjectToolsService(projectContext, logger, () => profiles.getCurrentProfileId());
  const diagnosticsTools = new DiagnosticsToolsService(diagnosticsContext, logger);
  const managedContextTools = new ManagedContextToolLoopService({
    docsTools,
    projectTools,
    diagnosticsTools,
    logger
  });
  const rulesContext = new RulesContextService(logger);
  const docsNormalizer = new DocsNormalizerService(context, settings, logger);
  const ripgrepInstaller = new RipgrepInstallerService(settings, logger);
  const history = new ChatHistoryService(context, settings.getConfigRoot(), logger);
  context.subscriptions.push(history, projectContext, diffArtifacts);
  let historyProfileId: string | undefined;
  let sidebar: SidebarProvider | undefined;
  let runtime: CodexRuntimeController;
  let chatPanels: ChatPanelManager;
  let approvalAttention: ApprovalAttentionService | undefined;
  const docsContext = new DocsRetrievalLoopService(
    docsCorpusContext,
    logger,
    (request) => runtime.planDocsRetrieval(request)
  );
  const state = new StateStore((mode: StateMutationMode) => {
    if (!historyProfileId) {
      return;
    }
    const snapshot = state.exportChatHistory();
    if (mode === "immediate") {
      void history.saveNow(historyProfileId, snapshot);
      return;
    }
    history.scheduleSave(historyProfileId, snapshot);
  });
  state.setChatHeaderMode(readChatHeaderMode(context));
  state.setProxy(await settings.getSidebarProxyStatus());
  state.setDocs(settings.getSidebarDocsStatus());
  chatPanels = new ChatPanelManager(context, state, logger, {
    sendPrompt: async (chatId: string, prompt: string, mode?: ChatRunMode, transcriptText?: string) => runtime.sendPrompt(chatId, prompt, mode, transcriptText),
    cancelTurn: async (chatId: string) => runtime.cancelTurn(chatId),
    markReadToBottom: (chatId: string) => {
      if (state.markChatRead(chatId)) {
        sidebar?.postSnapshot();
      }
    },
    setAccessMode: (chatId: string, accessMode: ChatAccessMode) => {
      const updated = state.setChatAccessMode(chatId, accessMode);
      if (!updated) {
        return;
      }
      logger.info(`Chat access mode changed: chat=${chatId}; mode=${accessMode}.`);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot(chatId);
    },
    setModel: (chatId: string, modelId: string | null, modelLabel: string) => {
      const updated = state.setChatModel(chatId, modelId, modelLabel);
      if (!updated) {
        return;
      }
      logger.info(`Chat model changed: chat=${chatId}; model=${modelId || "<default>"}; label=${modelLabel}.`);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot(chatId);
    },
    setEffort: (chatId: string, effort: ChatEffort) => {
      const updated = state.setChatEffort(chatId, effort);
      if (!updated) {
        return;
      }
      logger.info(`Chat effort changed: chat=${chatId}; effort=${effort}.`);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot(chatId);
    },
    setSpeed: (chatId: string, speed: ChatSpeed) => {
      const updated = state.setChatSpeed(chatId, speed);
      if (!updated) {
        return;
      }
      logger.info(`Chat speed changed: chat=${chatId}; speed=${speed}.`);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot(chatId);
    },
    setChatHeaderMode: async (mode: ChatHeaderMode) => {
      state.setChatHeaderMode(mode);
      await context.globalState.update(CHAT_HEADER_MODE_KEY, mode);
      logger.info(`Chat header mode changed: ${mode}.`);
      chatPanels.postSnapshot();
    },
    loadModels: async () => {
      state.setModelOptionsStatus("loading");
      chatPanels.postSnapshot();
      const result = await runtime.loadModelOptions();
      state.setModelOptions(result.options, result.status);
      chatPanels.postSnapshot();
    },
    getProjectContextDetails: async () => projectContext.getDetails(profiles.getCurrentProfileId()),
    getDocsContextDetails: async () => docsContext.decorateDetails(await settings.getDocsContextDetails()),
    toggleRules: async (chatId: string) => {
      const updated = state.toggleChatRules(chatId);
      if (!updated) {
        vscode.window.showWarningMessage("Правила доступны только для проектных чатов.");
        return;
      }
      state.setRulesContext(rulesContext.getStatus(updated.kind, updated.rulesEnabled));
      sidebar?.postSnapshot();
      chatPanels.postSnapshot(chatId);
    },
    openRules: async () => {
      await rulesContext.openRulesFile();
      refreshRulesContext(state, rulesContext);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
    },
    restoreChat: async (chatId: string) => restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    implementPlan: async (chatId: string, planText: string) => {
      const prompt = [
        "Реализуй утвержденный план ниже.",
        "Следуй текущему режиму доступа и запрашивай подтверждения через IDE, если они потребуются.",
        "",
        planText.trim()
      ].join("\n");
      await runtime.sendPrompt(chatId, prompt, "implementPlan", "Реализовать утвержденный план.");
    },
    openDiffInEditor: async (chatId: string, diffId: string, fileIndex: number) => {
      const entry = state.getDiffFile(chatId, diffId, fileIndex);
      if (!entry) {
        vscode.window.showWarningMessage("Diff не найден.");
        return;
      }
      await diffArtifacts.openDiff(entry.item, entry.file);
    },
    resolveApproval: (chatId: string, approvalId: string, approved: boolean) => runtime.resolveApproval(chatId, approvalId, approved)
  });
  const ensureHistoryLoaded = async (profileId?: string): Promise<void> => {
    const resolvedProfileId = profileId ?? await profiles.getKnownProfileId(settings.listExistingProfileIds());
    if (!resolvedProfileId || historyProfileId === resolvedProfileId) {
      return;
    }

    if (state.hasChats()) {
      historyProfileId = resolvedProfileId;
      await history.saveNow(historyProfileId, state.exportChatHistory());
      return;
    }

    const persistedHistory = await history.load(resolvedProfileId);
    state.replaceChatHistory(persistedHistory);
    refreshRulesContext(state, rulesContext);
    historyProfileId = resolvedProfileId;
    logger.info(`Chat history profile active: ${resolvedProfileId}.`);
    sidebar?.postSnapshot();
    chatPanels.postAllSnapshots();
  };
  await ensureHistoryLoaded();
  const contextOrchestrator = new ContextTurnOrchestrator({
    contextRouter,
    baseContext,
    projectContext,
    docsContext,
    diagnosticsContext,
    managedContextTools,
    nativeContextTools,
    rulesContext,
    profiles,
    state,
    logger,
    onDidChange: () => {
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
      approvalAttention?.sync();
    },
    onDidChangeChat: (chatId: string) => chatPanels.postSnapshot(chatId)
  });
  runtime = new CodexRuntimeController({
    context,
    settings,
    contextOrchestrator,
    docsContext,
    diagnosticsContext,
    nativeContextTools,
    profiles,
    state,
    logger,
    onDidChange: () => {
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
      approvalAttention?.sync();
    },
    onDidChangeChat: (chatId: string) => chatPanels.postSnapshot(chatId),
    onDidResolveProfile: ensureHistoryLoaded
  });
  context.subscriptions.push(runtime);
  const settingsPanels = new SettingsPanelManager(context, settings, docsNormalizer, ripgrepInstaller, baseContext, logger, async (options) => {
    if (options?.docsChanged) {
      docsContext.invalidate();
    }
    state.setProxy(await settings.getSidebarProxyStatus());
    state.setDocs(settings.getSidebarDocsStatus());
    if (options?.restartRuntime) {
      await runtime.stop();
    }
    sidebar?.postSnapshot();
    chatPanels.postSnapshot();
  });
  sidebar = new SidebarProvider(context, state, logger, {
    createChat: async (kind: ChatKind): Promise<void> => createChat(kind, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    openChat: async (chatId: string): Promise<void> => openChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    renameChat: async (chatId: string): Promise<void> => renameChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
    archiveChat: async (chatId: string): Promise<void> => archiveChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    restoreChat: async (chatId: string): Promise<void> => restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    deleteChat: async (chatId: string): Promise<void> => deleteChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
    openSettings: async () => settingsPanels.open(),
    openLogs: () => logger.show(),
    restoreAuth: async () => runtime.restoreAccountIfAvailable(),
    startDeviceCodeLogin: async () => runtime.startDeviceCodeLogin(),
    loginWithApiKey: async (apiKey: string) => runtime.loginWithApiKey(apiKey),
    openDeviceCodeUrl: async () => runtime.openDeviceCodeUrl(),
    copyDeviceCode: async () => runtime.copyDeviceCode(),
    copyDeviceCodeUrl: async () => runtime.copyDeviceCodeUrl(),
    copyDeviceCodeBundle: async () => runtime.copyDeviceCodeBundle()
  });
  approvalAttention = new ApprovalAttentionService(state, logger, async () => {
    const pendingChat = state.getSidebarSnapshot().chats.find((chat) => chat.pendingApproval);
    if (!pendingChat) {
      return;
    }
    await openChat(pendingChat.id, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
  });
  approvalAttention.sync();
  perf.mark("services");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexElement.sidebar", sidebar, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  perf.mark("sidebarProvider");

  context.subscriptions.push(chatPanels.registerSerializer(), settingsPanels.registerSerializer());
  perf.mark("panelSerializer");

  context.subscriptions.push(
    vscode.commands.registerCommand("codexElement.open", async () => {
      const existingChatId = state.getSidebarSnapshot().activeChatId;
      if (existingChatId) {
        await openChat(existingChatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
        return;
      }
      await createChat("project", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }),
    vscode.commands.registerCommand("codexElement.newProjectChat", async () => {
      await createChat("project", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }),
    vscode.commands.registerCommand("codexElement.newGeneralChat", async () => {
      await createChat("general", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }),
    vscode.commands.registerCommand("codexElement.openSettings", async () => {
      settingsPanels.open();
    }),
    vscode.commands.registerCommand("codexElement.openLogs", () => {
      logger.show();
    }),
    vscode.commands.registerCommand("codexElement.probeCapabilities", async () => {
      await runtime.probeCapabilities();
      logger.show();
      vscode.window.showInformationMessage("Проверка возможностей codex app-server завершена. Результат записан в Output: Codex.");
    }),
    vscode.commands.registerCommand("codexElement.openProjectRules", async () => {
      await rulesContext.openRulesFile();
      refreshRulesContext(state, rulesContext);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
    }),
    vscode.commands.registerCommand("codexElement.explainFile", async () => {
      await explainEditorContext("file", editorContext, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded, runtime);
    }),
    vscode.commands.registerCommand("codexElement.explainSelection", async () => {
      await explainEditorContext("selection", editorContext, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded, runtime);
    })
  );
  perf.mark("commands");

  perf.flush(logger, "Codex activation");
}

export function deactivate(): void {
  // All disposables are owned by the extension context.
}

function readChatHeaderMode(context: vscode.ExtensionContext): ChatHeaderMode {
  const stored = context.globalState.get<ChatHeaderMode>(CHAT_HEADER_MODE_KEY);
  return stored === "expanded" || stored === "collapsed" ? stored : "collapsed";
}

async function createChat(
  kind: ChatKind,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  rulesContext: RulesContextService,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  const chat = state.createChat(kind);
  refreshRulesContext(state, rulesContext, chat.id);
  logger.info(`Created ${kind} chat: ${chat.title}.`);
  sidebar?.postSnapshot();
  chatPanels.openChat(chat.id);
}

async function openChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  rulesContext: RulesContextService,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  state.setActiveChat(chatId);
  refreshRulesContext(state, rulesContext, chatId);
  logger.info(`Opening chat: ${chatId}.`);
  sidebar?.postSnapshot();
  chatPanels.openChat(chatId);
}

async function explainEditorContext(
  kind: EditorContextKind,
  editorContext: EditorContextService,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  rulesContext: RulesContextService,
  ensureHistoryLoaded: () => Promise<void>,
  runtime: CodexRuntimeController
): Promise<void> {
  await ensureHistoryLoaded();
  const request = await editorContext.buildRequest(kind);
  if (!request) {
    return;
  }

  const chat = getOrCreateIdleProjectChat(state, rulesContext);
  if (!chat) {
    vscode.window.showWarningMessage("Сначала остановите или завершите текущий запрос в проектном чате.");
    return;
  }

  refreshRulesContext(state, rulesContext, chat.id);
  sidebar?.postSnapshot();
  chatPanels.openChat(chat.id);
  logger.info(
    `Editor context requested: kind=${kind}; chat=${chat.id}; file=${request.relativePath}; bytes=${request.byteLength}.`
  );
  await runtime.sendPrompt(
    chat.id,
    request.userPrompt,
    "normal",
    request.visiblePrompt,
    [request.contextBlock]
  );
}

function getOrCreateIdleProjectChat(state: StateStore, rulesContext: RulesContextService) {
  const activeChatId = state.getActiveChatId();
  const activeChat = activeChatId ? state.getChat(activeChatId) : undefined;
  if (activeChat?.kind === "project" && !activeChat.archivedAt) {
    return activeChat.status === "running" || activeChat.status === "waitingApproval" || activeChat.status === "cancelling"
      ? undefined
      : activeChat;
  }

  const chat = state.createChat("project");
  refreshRulesContext(state, rulesContext, chat.id);
  return chat;
}

async function renameChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  const chat = state.getChat(chatId);
  if (!chat) {
    vscode.window.showWarningMessage("Чат не найден.");
    return;
  }

  const title = await vscode.window.showInputBox({
    title: "Введите название чата",
    value: chat.title,
    prompt: "Нажмите Enter, чтобы сохранить новое название, или Escape для отмены.",
    ignoreFocusOut: true
  });
  if (title === undefined) {
    return;
  }

  const updated = state.renameChat(chatId, title);
  if (!updated) {
    vscode.window.showWarningMessage("Название чата не может быть пустым.");
    return;
  }

  logger.info(`Renamed chat: ${chatId}.`);
  sidebar?.postSnapshot();
  chatPanels.postSnapshot(chatId);
}

async function archiveChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  rulesContext: RulesContextService,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  const chat = state.getChat(chatId);
  if (!chat) {
    vscode.window.showWarningMessage("Чат не найден.");
    return;
  }
  if (chat.archivedAt) {
    return;
  }
  if (chat.status !== "idle") {
    vscode.window.showWarningMessage("Сначала остановите или завершите запрос.");
    return;
  }

  const wasActive = state.getActiveChatId() === chatId;
  if (wasActive) {
    chatPanels.closeIfActiveChat(chatId);
  }
  const archived = state.archiveChat(chatId);
  if (!archived) {
    return;
  }

  logger.info(`Archived chat: ${chatId}.`);
  refreshRulesContext(state, rulesContext);
  sidebar?.postSnapshot();
  chatPanels.postSnapshot(chatId);
  const action = await vscode.window.showInformationMessage("Диалог перемещен в архив.", "Вернуть");
  if (action === "Вернуть") {
    await restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
  }
}

async function restoreChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  rulesContext: RulesContextService,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  const restored = state.restoreChat(chatId);
  if (!restored) {
    vscode.window.showWarningMessage("Чат не найден.");
    return;
  }

  refreshRulesContext(state, rulesContext, chatId);
  logger.info(`Restored chat: ${chatId}.`);
  sidebar?.postSnapshot();
  chatPanels.openChat(chatId);
}

async function deleteChat(
  chatId: string,
  state: StateStore,
  sidebar: SidebarProvider | undefined,
  chatPanels: ChatPanelManager,
  logger: Logger,
  ensureHistoryLoaded: () => Promise<void>
): Promise<void> {
  await ensureHistoryLoaded();
  const chat = state.getChat(chatId);
  if (!chat) {
    vscode.window.showWarningMessage("Чат не найден.");
    return;
  }
  if (!chat.archivedAt) {
    vscode.window.showWarningMessage("Удаление доступно только для архивных чатов.");
    return;
  }

  const action = await vscode.window.showWarningMessage(
    `Удалить диалог «${chat.title}» без возможности восстановления?`,
    { modal: true },
    "Удалить"
  );
  if (action !== "Удалить") {
    return;
  }

  const wasActive = state.getActiveChatId() === chatId;
  if (wasActive) {
    chatPanels.closeIfActiveChat(chatId);
  }
  if (!state.deleteChat(chatId)) {
    vscode.window.showWarningMessage("Чат не найден или уже удален.");
    return;
  }

  logger.info(`Deleted archived chat from local history: ${chatId}.`);
  sidebar?.postSnapshot();
  chatPanels.postSnapshot(chatId);
}

function refreshRulesContext(
  state: StateStore,
  rulesContext: RulesContextService,
  chatId = state.getActiveChatId()
): void {
  const chat = chatId ? state.getChat(chatId) : undefined;
  if (!chat) {
    return;
  }
  state.setRulesContext(rulesContext.getStatus(chat.kind, chat.rulesEnabled));
}

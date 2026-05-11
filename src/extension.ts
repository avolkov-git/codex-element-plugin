import * as vscode from "vscode";
import { ChatPanelManager } from "./chatPanelManager";
import { ChatHistoryService } from "./chatHistoryService";
import { ContextRouterService } from "./contextRouterService";
import { CodexRuntimeController } from "./codexRuntimeController";
import { DocsContextService } from "./docsContextService";
import { DocsNormalizerService } from "./docsNormalizerService";
import { Logger } from "./logger";
import { PerfMarks } from "./performance";
import { ProjectContextService } from "./projectContextService";
import { RulesContextService } from "./rulesContextService";
import { SettingsPanelManager } from "./settingsPanelManager";
import { SettingsService } from "./settingsService";
import { SidebarProvider } from "./sidebarProvider";
import { StateMutationMode, StateStore } from "./stateStore";
import { ChatKind } from "./types";
import { UserProfileService } from "./userProfileService";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const perf = new PerfMarks();
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info("Codex Element V1 activating.");
  perf.mark("logger");

  const settings = new SettingsService(context);
  const contextRouter = new ContextRouterService();
  const docsContext = new DocsContextService(settings, logger);
  const projectContext = new ProjectContextService(context, settings.getConfigRoot(), logger);
  const rulesContext = new RulesContextService(logger);
  const docsNormalizer = new DocsNormalizerService(context, settings, logger);
  const profiles = new UserProfileService(context);
  const history = new ChatHistoryService(context, settings.getConfigRoot(), logger);
  context.subscriptions.push(history, projectContext);
  let historyProfileId: string | undefined;
  let sidebar: SidebarProvider | undefined;
  let runtime: CodexRuntimeController;
  let chatPanels: ChatPanelManager;
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
  state.setProxy(await settings.getSidebarProxyStatus());
  state.setDocs(settings.getSidebarDocsStatus());
  chatPanels = new ChatPanelManager(context, state, logger, {
    sendPrompt: async (chatId: string, prompt: string) => runtime.sendPrompt(chatId, prompt),
    markReadToBottom: (chatId: string) => {
      if (state.markChatRead(chatId)) {
        sidebar?.postSnapshot();
      }
    },
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
  runtime = new CodexRuntimeController({
    context,
    settings,
    contextRouter,
    projectContext,
    docsContext,
    rulesContext,
    profiles,
    state,
    logger,
    onDidChange: () => {
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
    },
    onDidChangeChat: (chatId: string) => chatPanels.postSnapshot(chatId),
    onDidResolveProfile: ensureHistoryLoaded
  });
  context.subscriptions.push(runtime);
  const settingsPanels = new SettingsPanelManager(context, settings, docsNormalizer, logger, async (options) => {
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
    openSettings: async () => settingsPanels.open(),
    openLogs: () => logger.show(),
    restoreAuth: async () => runtime.restoreAccountIfAvailable(),
    startDeviceCodeLogin: async () => runtime.startDeviceCodeLogin(),
    loginWithApiKey: async (apiKey: string) => runtime.loginWithApiKey(apiKey),
    openDeviceCodeUrl: async () => runtime.openDeviceCodeUrl(),
    copyDeviceCode: async () => runtime.copyDeviceCode()
  });
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
    vscode.commands.registerCommand("codexElement.openProjectRules", async () => {
      await rulesContext.openRulesFile();
      refreshRulesContext(state, rulesContext);
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
    })
  );
  perf.mark("commands");

  perf.flush(logger, "Codex activation");
}

export function deactivate(): void {
  // All disposables are owned by the extension context.
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

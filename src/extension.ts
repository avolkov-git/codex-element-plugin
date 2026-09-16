import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ApprovalAttentionService } from "./approvalAttentionService";
import { BaseContextService } from "./baseContextService";
import { BrowserRuntimeService } from "./browserRuntimeService";
import { ChatPanelManager } from "./chatPanelManager";
import { ChatAttachmentService } from "./chatAttachmentService";
import { ChatHistoryService } from "./chatHistoryService";
import { ContextRouterService } from "./contextRouterService";
import { ContextTurnOrchestrator } from "./contextTurnOrchestrator";
import { CodexIntegrationsService } from "./codexIntegrationsService";
import { CodexRuntimeController } from "./codexRuntimeController";
import { DiagnosticsContextService } from "./diagnosticsContextService";
import { DiagnosticsToolsService } from "./diagnosticsToolsService";
import { DiffArtifactService } from "./diffArtifactService";
import { DiffPatchStore } from "./diffPatchStore";
import { DocsContextService } from "./docsContextService";
import { DocsRetrievalLoopService } from "./docsRetrievalLoopService";
import { DocsNormalizerService } from "./docsNormalizerService";
import { DocsToolsService } from "./docsToolsService";
import { EditorContextKind, EditorContextService } from "./editorContextService";
import { ElementMcpIdeBridgeService } from "./elementMcpIdeBridgeService";
import { ElementIdentityService, identityScopeRoot } from "./elementIdentityService";
import { ElementApplicationService } from "./elementApplicationService";
import { searchHistory } from "./historySearch";
import { Logger } from "./logger";
import { ManagedContextToolLoopService } from "./managedContextToolLoopService";
import { NativeContextToolLoopService } from "./nativeContextToolLoopService";
import { PerfMarks } from "./performance";
import { PressureMonitor } from "./pressureMonitor";
import { ProjectContextService } from "./projectContextService";
import { ProjectToolsService } from "./projectToolsService";
import { PluginFeatureService } from "./pluginFeatureService";
import { RipgrepInstallerService } from "./ripgrepInstallerService";
import { RulesContextService } from "./rulesContextService";
import { SettingsPanelManager } from "./settingsPanelManager";
import { SettingsService } from "./settingsService";
import { SidebarProvider } from "./sidebarProvider";
import { StateMutationMode, StateStore } from "./stateStore";
import { ChatAccessMode, ChatAttachment, ChatEffort, ChatHeaderMode, ChatKind, ChatRunMode, ChatSpeed, SkillSelection } from "./types";
import { UserProfileService } from "./userProfileService";

const CHAT_HEADER_MODE_KEY = "codexElement.chatHeaderMode";
let shutdown: () => Promise<void> = () => Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const perf = new PerfMarks();
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info("Codex Element V1 activating.");
  perf.mark("logger");

  const settings = new SettingsService(context);
  logger.enableFileLogging(path.join(settings.getConfigRoot(), "logs"));
  logger.info("ripgrep discovery deferred until settings/runtime usage.");
  const elementMcpIdeBridge = new ElementMcpIdeBridgeService(logger);
  const identity = new ElementIdentityService(undefined, undefined, logger);
  const getScopeRoot = (): string | undefined => {
    const current = identity.getCurrent();
    return current ? identityScopeRoot(settings.getConfigRoot(), current) : undefined;
  };
  context.subscriptions.push(elementMcpIdeBridge, identity);
  const contextRouter = new ContextRouterService();
  const baseContext = new BaseContextService(context, logger);
  const diagnosticsContext = new DiagnosticsContextService(logger);
  const attachments = new ChatAttachmentService(logger, () => {
    const root = getScopeRoot();
    return root ? path.join(root, "attachments") : undefined;
  });
  const diffPatches = new DiffPatchStore(getScopeRoot, logger);
  const diffArtifacts = new DiffArtifactService(logger, undefined, (file) => diffPatches.read(file));
  const docsCorpusContext = new DocsContextService(settings, logger, { getDocsSettingsSnapshot: () => settings.getDocsPathsSnapshot() });
  const nativeContextTools = new NativeContextToolLoopService(logger);
  const editorContext = new EditorContextService();
  const projectContext = new ProjectContextService(context, settings.getConfigRoot(), logger);
  const profiles = new UserProfileService(context, identity);
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
  let lastHistoryError = "";
  const reportHistoryError = (message: string): void => {
    if (message === lastHistoryError) { return; }
    lastHistoryError = message;
    logger.error(message);
    void vscode.window.showErrorMessage(message);
  };
  const history = new ChatHistoryService(context, settings.getConfigRoot(), logger, () => identity.getCurrent(), reportHistoryError);
  context.subscriptions.push(history, projectContext, diffArtifacts, diffPatches, docsCorpusContext, attachments);
  let historyProfileId: string | undefined;
  let historyScopeKey: string | undefined;
  let historyLoadPromise: Promise<void> | undefined;
  let identityTransition = Promise.resolve();
  let identityEpoch = 0;
  let sidebar: SidebarProvider | undefined;
  let runtime: CodexRuntimeController;
  let integrations: CodexIntegrationsService;
  let chatPanels: ChatPanelManager;
  let features: PluginFeatureService;
  let approvalAttention: ApprovalAttentionService | undefined;
  let pressureMonitor: PressureMonitor | undefined;
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
      void history.saveNow(historyProfileId, snapshot).catch((error) => reportHistoryError(error instanceof Error ? error.message : "Не удалось сохранить историю."));
      return;
    }
    history.scheduleSave(historyProfileId, snapshot);
  });
  state.setChatHeaderMode(readChatHeaderMode(context));
  state.setProxy(await settings.getSidebarProxyStatus());
  state.setDocs(settings.getSidebarDocsStatus());
  chatPanels = new ChatPanelManager(context, state, logger, {
    ensureHistoryLoaded: () => ensureHistoryLoaded(),
    sendPrompt: async (
      chatId: string,
      prompt: string,
      mode?: ChatRunMode,
      transcriptText?: string,
      skills?: readonly SkillSelection[],
      selectedAttachments?: readonly ChatAttachment[]
    ) => { await ensureHistoryLoaded(); await runtime.sendPrompt(chatId, prompt, mode, transcriptText, [], skills, selectedAttachments); },
    queuePrompt: async (chatId: string, prompt: string, mode?: ChatRunMode, skills?: readonly SkillSelection[], selectedAttachments?: readonly ChatAttachment[]) => { await ensureHistoryLoaded(); return runtime.queuePrompt(chatId, prompt, mode, skills, selectedAttachments); },
    steerTurn: async (chatId: string, prompt: string, selectedAttachments?: readonly ChatAttachment[]) => { await ensureHistoryLoaded(); await runtime.steerTurn(chatId, prompt, selectedAttachments); },
    resolveUserInput: (chatId, id, response) => runtime.resolveUserInput(chatId, id, response),
    respondToQuestion: async (chatId, messageId, questionId, answer) => {
      await ensureHistoryLoaded();
      return runtime.respondToQuestion(chatId, messageId, questionId, answer);
    },
    retryQueuedPrompt: (chatId, messageId) => runtime.retryQueuedPrompt(chatId, messageId),
    featureRequest: async (command, value, chatId) => {
      await ensureHistoryLoaded();
      const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
      if (command === "history.search") { return { ok: true, command, status: "ready", ...await searchHistory(state.exportChatHistory(), payload.query, payload.offset) }; }
      if (command === "history.jump") {
        const targetChat = typeof payload.chatId === "string" ? payload.chatId : chatId;
        const transcript = state.exportChatHistory().transcripts[targetChat] ?? [];
        const index = transcript.findIndex((item) => item.id === payload.itemId);
        if (index < 0) { throw new Error("Сообщение больше не существует в истории текущего проекта."); }
        state.setActiveChat(targetChat);
        chatPanels.openChat(targetChat);
        sidebar?.postSnapshot();
        return { ok: true, command, status: "ready", chatId: targetChat, itemId: payload.itemId, index, window: state.getTranscriptBefore(targetChat, "", 120, Math.min(transcript.length, index + 61)) };
      }
      if (command === "history.migration.help") {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(context.extensionPath, "docs", "1.0.0-rc-testing.md"))));
        return { ok: true, command, status: "ready" };
      }
      if (command === "history.migration.list") {
        const items = await history.listLegacy();
        return { ok: true, command, status: "ready", items: items.map((item) => ({ ...item, title: identity.getCurrent()?.projectName })), message: items.length ? undefined : "Подготовленных архивов для этого пользователя и проекта нет.", projectName: identity.getCurrent()?.projectName, userLabel: profiles.getCurrentProfileLabel() };
      }
      if (command === "history.migration.import") {
        if (state.getSidebarSnapshot().chats.some((chat) => ["running", "waitingApproval", "cancelling"].includes(chat.status))) { throw new Error("Завершите текущие запросы перед переносом истории."); }
        const epoch = identityEpoch;
        const scopeKey = historyScopeKey;
        const current = identity.getCurrent();
        const assertImportScope = (): void => {
          const active = identity.getCurrent();
          if (!current || epoch !== identityEpoch || scopeKey !== historyScopeKey || current.userKey !== active?.userKey || current.projectKey !== active.projectKey) { throw new Error("Пользователь или проект IDE изменился. Перенос не применен к открытому чату."); }
        };
        const confirmed = await vscode.window.showWarningMessage(`Перенести выбранную историю в проект «${current?.projectName}»?`, { modal: true, detail: `Подтвердите, что эти диалоги принадлежат вам (${profiles.getCurrentProfileLabel()}) и этому проекту. Старая история останется на месте. Учетные данные и активные запросы не переносятся.` }, "Перенести");
        if (confirmed !== "Перенести") { return { ok: false, command, status: "cancelled" }; }
        assertImportScope();
        const snapshot = state.exportChatHistory();
        const originalIds = new Set(snapshot.chats.map((chat) => chat.id));
        const migrated = await history.importLegacy(String(payload.id ?? ""), snapshot);
        assertImportScope();
        const imported = migrated.chats.filter((chat) => !originalIds.has(chat.id));
        state.addImportedChatHistory({ version: 1, chats: imported, transcripts: Object.fromEntries(imported.map((chat) => [chat.id, migrated.transcripts[chat.id] ?? []])) });
        await history.saveNow(current!.userKey, state.exportChatHistory());
        assertImportScope();
        sidebar?.postSnapshot(); chatPanels.postAllSnapshots();
        return { ok: true, command, status: "ready", chatCount: migrated.chats.length };
      }
      if (command === "chat.fork") {
        const fork = await runtime.forkChat(chatId, typeof payload.title === "string" ? payload.title : undefined);
        sidebar?.postSnapshot(); chatPanels.openChat(fork.id);
        return { ok: true, command, status: "ready", chatId: fork.id };
      }
      return features.handle(command, payload, chatId);
    },
    pickAttachments: (existing: unknown) => attachments.pick(existing),
    resolveAttachments: (value: unknown) => attachments.resolve(value),
    openAttachment: (value: unknown) => attachments.open(value),
    startAttachmentUpload: (chatId: string, value: unknown) => attachments.beginUpload(chatId, value),
    appendAttachmentUpload: (value: unknown) => attachments.appendUploadChunk(value),
    completeAttachmentUpload: (value: unknown) => attachments.completeUpload(value),
    cancelAttachmentUpload: (value: unknown) => attachments.cancelUpload(value),
    discardAttachment: (value: unknown) => attachments.discard(value),
    removeQueuedPrompt: (chatId: string, messageId: string) => runtime.removeQueuedPrompt(chatId, messageId),
    moveQueuedPrompt: (chatId: string, messageId: string, direction: "up" | "down") => runtime.moveQueuedPrompt(chatId, messageId, direction),
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
    loadModels: (forceReload?: boolean) => runtime.loadModelOptions(forceReload),
    loadSkills: async (forceReload?: boolean) => integrations.listEnabledSkills(forceReload),
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const epoch = identityEpoch;
      const transition = identityTransition;
      await transition;
      let verified;
      try { verified = await identity.resolve(); }
      catch (error) { if (epoch !== identityEpoch) { continue; } throw error; }
      // resolve/getCurrent can themselves detect changed credentials and enqueue cleanup.
      await identityTransition;
      if (epoch !== identityEpoch || transition !== identityTransition) { continue; }
      if (profileId && profileId !== verified.userKey) { throw new Error("Пользователь IDE изменился во время подключения Codex."); }
      const scopeKey = `${verified.userKey}/${verified.projectKey}/${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""}`;
      if (historyProfileId === verified.userKey && historyScopeKey === scopeKey) { return; }
      if (historyLoadPromise) { await historyLoadPromise.catch(() => undefined); continue; }
      const assertCurrentEpoch = (): void => {
        if (epoch !== identityEpoch) { throw new Error("Область истории изменилась во время загрузки."); }
      };
      const loading = (async () => {
        const previousProfile = historyProfileId;
        if (previousProfile) {
          await runtime?.stopForIdentityChange();
          assertCurrentEpoch();
          await history.saveNow(previousProfile, state.exportChatHistory());
          assertCurrentEpoch();
        }
        await history.flush();
        assertCurrentEpoch();
        for (const chat of state.getSidebarSnapshot().chats) { chatPanels.closeIfActiveChat(chat.id); }
        historyProfileId = undefined;
        historyScopeKey = undefined;
        state.replaceChatHistory(undefined);
        const persisted = await history.load(verified.userKey);
        assertCurrentEpoch();
        const current = identity.getCurrent();
        assertCurrentEpoch();
        if (current?.userKey !== verified.userKey || current.projectKey !== verified.projectKey) { throw new Error("Пользователь IDE изменился при загрузке истории."); }
        state.replaceChatHistory(persisted);
        refreshRulesContext(state, rulesContext);
        historyProfileId = verified.userKey;
        historyScopeKey = scopeKey;
        lastHistoryError = "";
        state.setAuth({ profileLabel: verified.userLabel, message: "История проекта загружена. Проверяем учетную запись Codex." });
        logger.info(`IDE project history active: user=${verified.userKey}; project=${verified.projectKey}.`);
        sidebar?.postSnapshot(); chatPanels.postAllSnapshots();
      })();
      historyLoadPromise = loading;
      try { await loading; }
      catch (error) { if (epoch === identityEpoch) { throw error; } }
      finally { if (historyLoadPromise === loading) { historyLoadPromise = undefined; } }
      if (epoch === identityEpoch) { return; }
    }
    throw new Error("Пользователь или проект IDE меняется во время подключения. Дождитесь завершения переключения и повторите действие.");
  };
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
    attachments,
    nativeContextTools,
    profiles,
    state,
    logger,
    diffPatches,
    onDidChange: () => {
      sidebar?.postSnapshot();
      chatPanels.postSnapshot();
      approvalAttention?.sync();
    },
    onDidChangeChat: (chatId: string) => chatPanels.postSnapshot(chatId),
    onDidResolveProfile: ensureHistoryLoaded,
    getManagedBrowserLaunch: async () => {
      if (browserRuntime.getSettingsView().enabled) await browserRuntime.refreshApplication(true);
      return browserRuntime.prepareRuntimeLaunch();
    },
    beforeQueuedDispatch: async () => {
      await ensureHistoryLoaded();
      if (!historyProfileId) { throw new Error("История проекта не открыта."); }
      await history.saveNow(historyProfileId, state.exportChatHistory());
    }
  });
  context.subscriptions.push(runtime);
  shutdown = async () => {
    pressureMonitor?.dispose();
    docsCorpusContext.dispose();
    try { await runtime.stop(); await diffPatches.flush(); await history.flush(); }
    finally { await logger.flush(); }
  };
  integrations = new CodexIntegrationsService(context, settings, profiles, runtime, logger);
  context.subscriptions.push(integrations);
  const browserSessionId = crypto.randomUUID();
  const elementApplication = new ElementApplicationService(logger);
  context.subscriptions.push(elementApplication);
  const browserRuntime = new BrowserRuntimeService(context, settings, logger, () => {
    const root = getScopeRoot();
    return root ? path.join(root, "sessions", browserSessionId) : undefined;
  }, getScopeRoot, elementApplication);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("1C.applicationId") || event.affectsConfiguration("1C.serverExternalUri")) {
      void runtime.stop().catch(() => logger.warn("Runtime stop failed after the IDE application changed."));
    }
  }));
  features = new PluginFeatureService({
    getWorkspaceRoot: (chatId) => state.getChat(chatId) ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
    getScopeRoot,
    getBrowserArtifactsRoot: () => browserRuntime.getBrowserArtifactsRoot(),
    diffArtifacts,
    onReviewComment: async (chatId, text) => {
      await ensureHistoryLoaded();
      if (state.getChat(chatId)?.status === "running") { await runtime.queuePrompt(chatId, text, "normal"); }
      else { await runtime.sendPrompt(chatId, text); }
    }
  });
  context.subscriptions.push(features);
  integrations.setManagedBrowserProvider(() => browserRuntime.getManagedServer());
  const settingsPanels = new SettingsPanelManager(context, settings, docsNormalizer, ripgrepInstaller, baseContext, integrations, browserRuntime, logger, async (options) => {
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
  }, runtime);
  sidebar = new SidebarProvider(context, state, logger, {
    createChat: async (kind: ChatKind): Promise<void> => createChat(kind, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    openChat: async (chatId: string): Promise<void> => openChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    renameChat: async (chatId: string): Promise<void> => renameChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
    archiveChat: async (chatId: string): Promise<void> => archiveChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    restoreChat: async (chatId: string): Promise<void> => restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
    deleteChat: async (chatId: string): Promise<void> => deleteChat(chatId, state, sidebar, chatPanels, attachments, logger, ensureHistoryLoaded),
    openSettings: async () => settingsPanels.open(),
    openLogs: () => logger.show(),
    restoreAuth: async () => {
      try { await ensureHistoryLoaded(); await runtime.restoreAccountIfAvailable(); }
      catch (error) { state.setAuth({ status: "error", message: error instanceof Error ? error.message : "Не удалось подтвердить пользователя IDE." }); sidebar?.postSnapshot(); }
    },
    startDeviceCodeLogin: async () => { await ensureHistoryLoaded(); await runtime.startDeviceCodeLogin(); },
    loginWithApiKey: async (apiKey: string) => { await ensureHistoryLoaded(); await runtime.loginWithApiKey(apiKey); },
    logoutAccount: async () => {
      const blockingChat = state.getSidebarSnapshot().chats.find((chat) =>
        chat.status === "running" || chat.status === "waitingApproval" || chat.status === "cancelling"
      );
      if (blockingChat) {
        await vscode.window.showWarningMessage(`Сначала остановите или завершите запрос в чате «${blockingChat.title}».`);
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        "Выйти из учетной записи Codex?",
        {
          modal: true,
          detail: "Локальные чаты, вложения и настройки сохранятся. Связи с удаленными диалогами Codex будут сброшены, чтобы можно было безопасно войти под другим пользователем."
        },
        "Выйти"
      );
      if (confirmation !== "Выйти") {
        return;
      }
      try {
        await runtime.logoutAccount();
        await vscode.window.showInformationMessage("Вы вышли из учетной записи Codex.");
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : "Не удалось выйти из учетной записи Codex.");
      }
    },
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
  pressureMonitor = new PressureMonitor(logger, {
    runtime: () => runtime.getMetrics(),
    ownedCodexPid: () => runtime.getMetrics().pid,
    chat: () => ({ ...chatPanels.getMetrics(), sidebar: sidebar?.getMetrics() }),
    logger: () => logger.getMetrics(),
    history: () => {
      const m = history.getMetrics();
      return { queueCurrent: m.queueCurrent, queueMax: m.queueMax, coalescedSaves: m.coalescedSaves, saveFailures: m.saveFailures,
        snapshotMaxMs: m.snapshotMaxMs, savesCompleted: m.savesCompleted, serializedBytes: m.serializedBytes, serializationMs: m.serializationMs,
        saveMaxMs: m.saveMaxMs, store: { persistedBytes: m.store.persistedBytes, writtenBytes: m.store.writtenBytes, historyWrites: m.store.historyWrites,
          skippedWrites: m.store.skippedWrites, serializationMaxMs: m.store.serializationMaxMs } };
    },
    docs: () => docsCorpusContext.getMetrics(),
    diff: () => diffPatches.getMetrics()
  });
  context.subscriptions.push(pressureMonitor);
  const invalidateIdentity = (): void => {
    const epoch = ++identityEpoch;
    const previous = historyProfileId;
    const snapshot = state.exportChatHistory();
    historyProfileId = undefined;
    historyScopeKey = undefined;
    for (const chat of snapshot.chats) { chatPanels.closeIfActiveChat(chat.id); }
    identityTransition = identityTransition.then(async () => {
      await runtime.stopForIdentityChange();
      if (previous) { await history.saveNow(previous, snapshot); }
      await history.flush();
    }).catch((error) => reportHistoryError(error instanceof Error ? error.message : "Ошибка при смене пользователя IDE.")).finally(() => {
      if (epoch !== identityEpoch) { return; }
      historyProfileId = undefined;
      historyScopeKey = undefined;
      state.replaceChatHistory(undefined);
      state.setAuth({ status: "notAuthenticated", profileLabel: "-", message: "Пользователь или проект IDE изменился. Откройте Codex повторно." });
      sidebar?.postSnapshot(); chatPanels.postAllSnapshots();
    });
  };
  context.subscriptions.push(identity.onDidInvalidate(invalidateIdentity), vscode.workspace.onDidChangeWorkspaceFolders(() => { identity.invalidate(); }));
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
    vscode.commands.registerCommand("codexElement.openLogFolder", async () => {
      await logger.openLogFolder();
    }),
    vscode.commands.registerCommand("codexElement.exportLogsToWorkspace", async () => {
      const targetDirectory = await logger.exportLogsToWorkspace();
      if (!targetDirectory) {
        vscode.window.showWarningMessage("Не удалось экспортировать логи: workspace или файловые логи недоступны.");
        return;
      }
      vscode.window.showInformationMessage(`Логи Codex экспортированы: ${targetDirectory}.`);
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

export async function deactivate(): Promise<void> {
  await shutdown();
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
  attachments: ChatAttachmentService,
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

  try {
    await attachments.deleteChat(chatId);
  } catch (error) {
    logger.warn(`Deleted chat attachment cleanup failed: ${error instanceof Error ? error.message : "unknown error"}.`);
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

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const approvalAttentionService_1 = require("./approvalAttentionService");
const baseContextService_1 = require("./baseContextService");
const chatPanelManager_1 = require("./chatPanelManager");
const chatAttachmentService_1 = require("./chatAttachmentService");
const chatHistoryService_1 = require("./chatHistoryService");
const contextRouterService_1 = require("./contextRouterService");
const contextTurnOrchestrator_1 = require("./contextTurnOrchestrator");
const codexIntegrationsService_1 = require("./codexIntegrationsService");
const codexRuntimeController_1 = require("./codexRuntimeController");
const diagnosticsContextService_1 = require("./diagnosticsContextService");
const diagnosticsToolsService_1 = require("./diagnosticsToolsService");
const diffArtifactService_1 = require("./diffArtifactService");
const docsContextService_1 = require("./docsContextService");
const docsRetrievalLoopService_1 = require("./docsRetrievalLoopService");
const docsNormalizerService_1 = require("./docsNormalizerService");
const docsToolsService_1 = require("./docsToolsService");
const editorContextService_1 = require("./editorContextService");
const elementMcpIdeBridgeService_1 = require("./elementMcpIdeBridgeService");
const logger_1 = require("./logger");
const managedContextToolLoopService_1 = require("./managedContextToolLoopService");
const nativeContextToolLoopService_1 = require("./nativeContextToolLoopService");
const performance_1 = require("./performance");
const projectContextService_1 = require("./projectContextService");
const projectToolsService_1 = require("./projectToolsService");
const ripgrepInstallerService_1 = require("./ripgrepInstallerService");
const rulesContextService_1 = require("./rulesContextService");
const settingsPanelManager_1 = require("./settingsPanelManager");
const settingsService_1 = require("./settingsService");
const sidebarProvider_1 = require("./sidebarProvider");
const stateStore_1 = require("./stateStore");
const userProfileService_1 = require("./userProfileService");
const CHAT_HEADER_MODE_KEY = "codexElement.chatHeaderMode";
async function activate(context) {
    const perf = new performance_1.PerfMarks();
    const logger = new logger_1.Logger();
    context.subscriptions.push(logger);
    logger.info("Codex Element V1 activating.");
    perf.mark("logger");
    const settings = new settingsService_1.SettingsService(context);
    logger.enableFileLogging(path.join(settings.getConfigRoot(), "logs"));
    logger.info("ripgrep discovery deferred until settings/runtime usage.");
    const elementMcpIdeBridge = new elementMcpIdeBridgeService_1.ElementMcpIdeBridgeService(logger);
    context.subscriptions.push(elementMcpIdeBridge);
    const contextRouter = new contextRouterService_1.ContextRouterService();
    const baseContext = new baseContextService_1.BaseContextService(context, logger);
    const diagnosticsContext = new diagnosticsContextService_1.DiagnosticsContextService(logger);
    const attachments = new chatAttachmentService_1.ChatAttachmentService(logger);
    const diffArtifacts = new diffArtifactService_1.DiffArtifactService(logger);
    const docsCorpusContext = new docsContextService_1.DocsContextService(settings, logger);
    const nativeContextTools = new nativeContextToolLoopService_1.NativeContextToolLoopService(logger);
    const editorContext = new editorContextService_1.EditorContextService();
    const projectContext = new projectContextService_1.ProjectContextService(context, settings.getConfigRoot(), logger);
    const profiles = new userProfileService_1.UserProfileService(context);
    const docsTools = new docsToolsService_1.DocsToolsService(docsCorpusContext, logger);
    const projectTools = new projectToolsService_1.ProjectToolsService(projectContext, logger, () => profiles.getCurrentProfileId());
    const diagnosticsTools = new diagnosticsToolsService_1.DiagnosticsToolsService(diagnosticsContext, logger);
    const managedContextTools = new managedContextToolLoopService_1.ManagedContextToolLoopService({
        docsTools,
        projectTools,
        diagnosticsTools,
        logger
    });
    const rulesContext = new rulesContextService_1.RulesContextService(logger);
    const docsNormalizer = new docsNormalizerService_1.DocsNormalizerService(context, settings, logger);
    const ripgrepInstaller = new ripgrepInstallerService_1.RipgrepInstallerService(settings, logger);
    const history = new chatHistoryService_1.ChatHistoryService(context, settings.getConfigRoot(), logger);
    context.subscriptions.push(history, projectContext, diffArtifacts);
    let historyProfileId;
    let sidebar;
    let runtime;
    let integrations;
    let chatPanels;
    let approvalAttention;
    const docsContext = new docsRetrievalLoopService_1.DocsRetrievalLoopService(docsCorpusContext, logger, (request) => runtime.planDocsRetrieval(request));
    const state = new stateStore_1.StateStore((mode) => {
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
    chatPanels = new chatPanelManager_1.ChatPanelManager(context, state, logger, {
        sendPrompt: async (chatId, prompt, mode, transcriptText, skills, selectedAttachments) => runtime.sendPrompt(chatId, prompt, mode, transcriptText, [], skills, selectedAttachments),
        queuePrompt: (chatId, prompt, mode, skills, selectedAttachments) => runtime.queuePrompt(chatId, prompt, mode, skills, selectedAttachments),
        steerTurn: async (chatId, prompt, selectedAttachments) => runtime.steerTurn(chatId, prompt, selectedAttachments),
        pickAttachments: (existing) => attachments.pick(existing),
        resolveAttachments: (value) => attachments.resolve(value),
        openAttachment: (value) => attachments.open(value),
        removeQueuedPrompt: (chatId, messageId) => runtime.removeQueuedPrompt(chatId, messageId),
        moveQueuedPrompt: (chatId, messageId, direction) => runtime.moveQueuedPrompt(chatId, messageId, direction),
        cancelTurn: async (chatId) => runtime.cancelTurn(chatId),
        markReadToBottom: (chatId) => {
            if (state.markChatRead(chatId)) {
                sidebar?.postSnapshot();
            }
        },
        setAccessMode: (chatId, accessMode) => {
            const updated = state.setChatAccessMode(chatId, accessMode);
            if (!updated) {
                return;
            }
            logger.info(`Chat access mode changed: chat=${chatId}; mode=${accessMode}.`);
            sidebar?.postSnapshot();
            chatPanels.postSnapshot(chatId);
        },
        setModel: (chatId, modelId, modelLabel) => {
            const updated = state.setChatModel(chatId, modelId, modelLabel);
            if (!updated) {
                return;
            }
            logger.info(`Chat model changed: chat=${chatId}; model=${modelId || "<default>"}; label=${modelLabel}.`);
            sidebar?.postSnapshot();
            chatPanels.postSnapshot(chatId);
        },
        setEffort: (chatId, effort) => {
            const updated = state.setChatEffort(chatId, effort);
            if (!updated) {
                return;
            }
            logger.info(`Chat effort changed: chat=${chatId}; effort=${effort}.`);
            sidebar?.postSnapshot();
            chatPanels.postSnapshot(chatId);
        },
        setSpeed: (chatId, speed) => {
            const updated = state.setChatSpeed(chatId, speed);
            if (!updated) {
                return;
            }
            logger.info(`Chat speed changed: chat=${chatId}; speed=${speed}.`);
            sidebar?.postSnapshot();
            chatPanels.postSnapshot(chatId);
        },
        setChatHeaderMode: async (mode) => {
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
        loadSkills: async (forceReload) => integrations.listEnabledSkills(forceReload),
        getProjectContextDetails: async () => projectContext.getDetails(profiles.getCurrentProfileId()),
        getDocsContextDetails: async () => docsContext.decorateDetails(await settings.getDocsContextDetails()),
        toggleRules: async (chatId) => {
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
        restoreChat: async (chatId) => restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
        implementPlan: async (chatId, planText) => {
            const prompt = [
                "Реализуй утвержденный план ниже.",
                "Следуй текущему режиму доступа и запрашивай подтверждения через IDE, если они потребуются.",
                "",
                planText.trim()
            ].join("\n");
            await runtime.sendPrompt(chatId, prompt, "implementPlan", "Реализовать утвержденный план.");
        },
        openDiffInEditor: async (chatId, diffId, fileIndex) => {
            const entry = state.getDiffFile(chatId, diffId, fileIndex);
            if (!entry) {
                vscode.window.showWarningMessage("Diff не найден.");
                return;
            }
            await diffArtifacts.openDiff(entry.item, entry.file);
        },
        resolveApproval: (chatId, approvalId, approved) => runtime.resolveApproval(chatId, approvalId, approved)
    });
    const ensureHistoryLoaded = async (profileId) => {
        const resolvedProfileId = profileId ?? await profiles.getKnownProfileId(settings.listExistingProfileIds());
        if (!resolvedProfileId || historyProfileId === resolvedProfileId) {
            return;
        }
        if (state.getSidebarSnapshot().auth.profileLabel !== resolvedProfileId) {
            state.setAuth({
                profileLabel: resolvedProfileId,
                message: "Сохраненная авторизация будет проверена при отправке или входе."
            });
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
    const contextOrchestrator = new contextTurnOrchestrator_1.ContextTurnOrchestrator({
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
        onDidChangeChat: (chatId) => chatPanels.postSnapshot(chatId)
    });
    runtime = new codexRuntimeController_1.CodexRuntimeController({
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
        onDidChange: () => {
            sidebar?.postSnapshot();
            chatPanels.postSnapshot();
            approvalAttention?.sync();
        },
        onDidChangeChat: (chatId) => chatPanels.postSnapshot(chatId),
        onDidResolveProfile: ensureHistoryLoaded
    });
    context.subscriptions.push(runtime);
    integrations = new codexIntegrationsService_1.CodexIntegrationsService(context, settings, profiles, runtime, logger);
    context.subscriptions.push(integrations);
    const settingsPanels = new settingsPanelManager_1.SettingsPanelManager(context, settings, docsNormalizer, ripgrepInstaller, baseContext, integrations, logger, async (options) => {
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
    sidebar = new sidebarProvider_1.SidebarProvider(context, state, logger, {
        createChat: async (kind) => createChat(kind, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
        openChat: async (chatId) => openChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
        renameChat: async (chatId) => renameChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
        archiveChat: async (chatId) => archiveChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
        restoreChat: async (chatId) => restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded),
        deleteChat: async (chatId) => deleteChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
        openSettings: async () => settingsPanels.open(),
        openLogs: () => logger.show(),
        restoreAuth: async () => runtime.restoreAccountIfAvailable(),
        startDeviceCodeLogin: async () => runtime.startDeviceCodeLogin(),
        loginWithApiKey: async (apiKey) => runtime.loginWithApiKey(apiKey),
        openDeviceCodeUrl: async () => runtime.openDeviceCodeUrl(),
        copyDeviceCode: async () => runtime.copyDeviceCode(),
        copyDeviceCodeUrl: async () => runtime.copyDeviceCodeUrl(),
        copyDeviceCodeBundle: async () => runtime.copyDeviceCodeBundle()
    });
    approvalAttention = new approvalAttentionService_1.ApprovalAttentionService(state, logger, async () => {
        const pendingChat = state.getSidebarSnapshot().chats.find((chat) => chat.pendingApproval);
        if (!pendingChat) {
            return;
        }
        await openChat(pendingChat.id, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    });
    approvalAttention.sync();
    perf.mark("services");
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("codexElement.sidebar", sidebar, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
    perf.mark("sidebarProvider");
    context.subscriptions.push(chatPanels.registerSerializer(), settingsPanels.registerSerializer());
    perf.mark("panelSerializer");
    context.subscriptions.push(vscode.commands.registerCommand("codexElement.open", async () => {
        const existingChatId = state.getSidebarSnapshot().activeChatId;
        if (existingChatId) {
            await openChat(existingChatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
            return;
        }
        await createChat("project", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.newProjectChat", async () => {
        await createChat("project", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.newGeneralChat", async () => {
        await createChat("general", state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.openSettings", async () => {
        settingsPanels.open();
    }), vscode.commands.registerCommand("codexElement.openLogs", () => {
        logger.show();
    }), vscode.commands.registerCommand("codexElement.openLogFolder", async () => {
        await logger.openLogFolder();
    }), vscode.commands.registerCommand("codexElement.exportLogsToWorkspace", async () => {
        const targetDirectory = await logger.exportLogsToWorkspace();
        if (!targetDirectory) {
            vscode.window.showWarningMessage("Не удалось экспортировать логи: workspace или файловые логи недоступны.");
            return;
        }
        vscode.window.showInformationMessage(`Логи Codex экспортированы: ${targetDirectory}.`);
    }), vscode.commands.registerCommand("codexElement.probeCapabilities", async () => {
        await runtime.probeCapabilities();
        logger.show();
        vscode.window.showInformationMessage("Проверка возможностей codex app-server завершена. Результат записан в Output: Codex.");
    }), vscode.commands.registerCommand("codexElement.openProjectRules", async () => {
        await rulesContext.openRulesFile();
        refreshRulesContext(state, rulesContext);
        sidebar?.postSnapshot();
        chatPanels.postSnapshot();
    }), vscode.commands.registerCommand("codexElement.explainFile", async () => {
        await explainEditorContext("file", editorContext, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded, runtime);
    }), vscode.commands.registerCommand("codexElement.explainSelection", async () => {
        await explainEditorContext("selection", editorContext, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded, runtime);
    }));
    perf.mark("commands");
    perf.flush(logger, "Codex activation");
}
function deactivate() {
    // All disposables are owned by the extension context.
}
function readChatHeaderMode(context) {
    const stored = context.globalState.get(CHAT_HEADER_MODE_KEY);
    return stored === "expanded" || stored === "collapsed" ? stored : "collapsed";
}
async function createChat(kind, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded) {
    await ensureHistoryLoaded();
    const chat = state.createChat(kind);
    refreshRulesContext(state, rulesContext, chat.id);
    logger.info(`Created ${kind} chat: ${chat.title}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chat.id);
}
async function openChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded) {
    await ensureHistoryLoaded();
    state.setActiveChat(chatId);
    refreshRulesContext(state, rulesContext, chatId);
    logger.info(`Opening chat: ${chatId}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chatId);
}
async function explainEditorContext(kind, editorContext, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded, runtime) {
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
    logger.info(`Editor context requested: kind=${kind}; chat=${chat.id}; file=${request.relativePath}; bytes=${request.byteLength}.`);
    await runtime.sendPrompt(chat.id, request.userPrompt, "normal", request.visiblePrompt, [request.contextBlock]);
}
function getOrCreateIdleProjectChat(state, rulesContext) {
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
async function renameChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded) {
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
async function archiveChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded) {
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
async function restoreChat(chatId, state, sidebar, chatPanels, logger, rulesContext, ensureHistoryLoaded) {
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
async function deleteChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded) {
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
    const action = await vscode.window.showWarningMessage(`Удалить диалог «${chat.title}» без возможности восстановления?`, { modal: true }, "Удалить");
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
function refreshRulesContext(state, rulesContext, chatId = state.getActiveChatId()) {
    const chat = chatId ? state.getChat(chatId) : undefined;
    if (!chat) {
        return;
    }
    state.setRulesContext(rulesContext.getStatus(chat.kind, chat.rulesEnabled));
}
//# sourceMappingURL=extension.js.map
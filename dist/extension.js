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
const vscode = __importStar(require("vscode"));
const chatPanelManager_1 = require("./chatPanelManager");
const chatHistoryService_1 = require("./chatHistoryService");
const codexRuntimeController_1 = require("./codexRuntimeController");
const logger_1 = require("./logger");
const performance_1 = require("./performance");
const settingsPanelManager_1 = require("./settingsPanelManager");
const settingsService_1 = require("./settingsService");
const sidebarProvider_1 = require("./sidebarProvider");
const stateStore_1 = require("./stateStore");
const userProfileService_1 = require("./userProfileService");
async function activate(context) {
    const perf = new performance_1.PerfMarks();
    const logger = new logger_1.Logger();
    context.subscriptions.push(logger);
    logger.info("Codex Element V1 activating.");
    perf.mark("logger");
    const settings = new settingsService_1.SettingsService(context);
    const profiles = new userProfileService_1.UserProfileService(context);
    const history = new chatHistoryService_1.ChatHistoryService(context, settings.getConfigRoot(), logger);
    context.subscriptions.push(history);
    let historyProfileId;
    let sidebar;
    let runtime;
    let chatPanels;
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
    state.setProxy(await settings.getSidebarProxyStatus());
    chatPanels = new chatPanelManager_1.ChatPanelManager(context, state, logger, {
        sendPrompt: async (chatId, prompt) => runtime.sendPrompt(chatId, prompt),
        markReadToBottom: (chatId) => {
            if (state.markChatRead(chatId)) {
                sidebar?.postSnapshot();
            }
        }
    });
    const ensureHistoryLoaded = async (profileId) => {
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
        historyProfileId = resolvedProfileId;
        logger.info(`Chat history profile active: ${resolvedProfileId}.`);
        sidebar?.postSnapshot();
        chatPanels.postAllSnapshots();
    };
    await ensureHistoryLoaded();
    runtime = new codexRuntimeController_1.CodexRuntimeController({
        context,
        settings,
        profiles,
        state,
        logger,
        onDidChange: () => {
            sidebar?.postSnapshot();
            chatPanels.postSnapshot();
        },
        onDidChangeChat: (chatId) => chatPanels.postSnapshot(chatId),
        onDidResolveProfile: ensureHistoryLoaded
    });
    context.subscriptions.push(runtime);
    const settingsPanels = new settingsPanelManager_1.SettingsPanelManager(context, settings, logger, async () => {
        state.setProxy(await settings.getSidebarProxyStatus());
        await runtime.stop();
        sidebar?.postSnapshot();
    });
    sidebar = new sidebarProvider_1.SidebarProvider(context, state, logger, {
        createChat: async (kind) => createChat(kind, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
        openChat: async (chatId) => openChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
        renameChat: async (chatId) => renameChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded),
        openSettings: async () => settingsPanels.open(),
        openLogs: () => logger.show(),
        restoreAuth: async () => runtime.restoreAccountIfAvailable(),
        startDeviceCodeLogin: async () => runtime.startDeviceCodeLogin(),
        loginWithApiKey: async (apiKey) => runtime.loginWithApiKey(apiKey),
        openDeviceCodeUrl: async () => runtime.openDeviceCodeUrl(),
        copyDeviceCode: async () => runtime.copyDeviceCode()
    });
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
            await openChat(existingChatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded);
            return;
        }
        await createChat("project", state, sidebar, chatPanels, logger, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.newProjectChat", async () => {
        await createChat("project", state, sidebar, chatPanels, logger, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.newGeneralChat", async () => {
        await createChat("general", state, sidebar, chatPanels, logger, ensureHistoryLoaded);
    }), vscode.commands.registerCommand("codexElement.openSettings", async () => {
        settingsPanels.open();
    }), vscode.commands.registerCommand("codexElement.openLogs", () => {
        logger.show();
    }));
    perf.mark("commands");
    perf.flush(logger, "Codex activation");
}
function deactivate() {
    // All disposables are owned by the extension context.
}
async function createChat(kind, state, sidebar, chatPanels, logger, ensureHistoryLoaded) {
    await ensureHistoryLoaded();
    const chat = state.createChat(kind);
    logger.info(`Created ${kind} chat: ${chat.title}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chat.id);
}
async function openChat(chatId, state, sidebar, chatPanels, logger, ensureHistoryLoaded) {
    await ensureHistoryLoaded();
    state.setActiveChat(chatId);
    logger.info(`Opening chat: ${chatId}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chatId);
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
//# sourceMappingURL=extension.js.map
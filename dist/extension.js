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
const logger_1 = require("./logger");
const performance_1 = require("./performance");
const runtimeAuthController_1 = require("./runtimeAuthController");
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
    const state = new stateStore_1.StateStore();
    state.setProxy(await settings.getSidebarProxyStatus());
    const profiles = new userProfileService_1.UserProfileService();
    let sidebar;
    const runtime = new runtimeAuthController_1.RuntimeAuthController({
        context,
        settings,
        profiles,
        state,
        logger,
        onDidChange: () => sidebar?.postSnapshot()
    });
    context.subscriptions.push(runtime);
    const chatPanels = new chatPanelManager_1.ChatPanelManager(context, state, logger);
    const settingsPanels = new settingsPanelManager_1.SettingsPanelManager(context, settings, logger, async () => {
        state.setProxy(await settings.getSidebarProxyStatus());
        await runtime.stop();
        sidebar?.postSnapshot();
    });
    sidebar = new sidebarProvider_1.SidebarProvider(context, state, logger, {
        createChat: async (kind) => createChat(kind, state, sidebar, chatPanels, logger),
        openChat: async (chatId) => openChat(chatId, state, sidebar, chatPanels, logger),
        openSettings: async () => settingsPanels.open(),
        openLogs: () => logger.show(),
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
            await openChat(existingChatId, state, sidebar, chatPanels, logger);
            return;
        }
        await createChat("project", state, sidebar, chatPanels, logger);
    }), vscode.commands.registerCommand("codexElement.newProjectChat", async () => {
        await createChat("project", state, sidebar, chatPanels, logger);
    }), vscode.commands.registerCommand("codexElement.newGeneralChat", async () => {
        await createChat("general", state, sidebar, chatPanels, logger);
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
async function createChat(kind, state, sidebar, chatPanels, logger) {
    const chat = state.createChat(kind);
    logger.info(`Created ${kind} chat: ${chat.title}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chat.id);
}
async function openChat(chatId, state, sidebar, chatPanels, logger) {
    state.setActiveChat(chatId);
    logger.info(`Opening chat: ${chatId}.`);
    sidebar?.postSnapshot();
    chatPanels.openChat(chatId);
}
//# sourceMappingURL=extension.js.map
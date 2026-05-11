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
exports.ChatPanelManager = exports.CHAT_PANEL_VIEW_TYPE = void 0;
const vscode = __importStar(require("vscode"));
const webviewHtml_1 = require("./webviewHtml");
exports.CHAT_PANEL_VIEW_TYPE = "codexElement.chatPanel";
class ChatPanelManager {
    constructor(context, state, logger, handlers) {
        this.context = context;
        this.state = state;
        this.logger = logger;
        this.handlers = handlers;
    }
    registerSerializer() {
        return vscode.window.registerWebviewPanelSerializer(exports.CHAT_PANEL_VIEW_TYPE, {
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
    openChat(chatId) {
        const chat = this.state.getChat(chatId);
        if (!chat) {
            vscode.window.showWarningMessage("Чат не найден.");
            return;
        }
        this.state.setActiveChat(chatId);
        if (this.panel) {
            this.panel.reveal();
            this.postActiveSnapshot();
            return;
        }
        const panel = vscode.window.createWebviewPanel(exports.CHAT_PANEL_VIEW_TYPE, "Codex", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            enableFindWidget: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
                vscode.Uri.joinPath(this.context.extensionUri, "resources")
            ]
        });
        this.setupPanel(panel);
    }
    postSnapshot(chatId) {
        if (chatId && chatId !== this.state.getActiveChatId()) {
            return;
        }
        this.postActiveSnapshot();
    }
    postAllSnapshots() {
        this.postActiveSnapshot();
    }
    postActiveSnapshot() {
        this.panel?.webview.postMessage({
            type: "chat.snapshot",
            snapshot: this.state.getActiveChatSnapshot() ?? null
        });
    }
    setupPanel(panel) {
        panel.title = "Codex";
        panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icons", "codex.svg");
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
                vscode.Uri.joinPath(this.context.extensionUri, "resources")
            ]
        };
        panel.webview.html = (0, webviewHtml_1.renderWebviewHtml)({
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
        panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(panel, message);
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
            }
            this.logger.info("Singleton chat panel disposed.");
        });
    }
    async handleMessage(panel, message) {
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
exports.ChatPanelManager = ChatPanelManager;
function parsePanelState(rawState) {
    if (!rawState || typeof rawState !== "object") {
        return {};
    }
    const value = rawState;
    const activeChatId = typeof value.activeChatId === "string" ? value.activeChatId : undefined;
    const chatId = typeof value.chatId === "string" ? value.chatId : undefined;
    return { activeChatId, chatId };
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=chatPanelManager.js.map
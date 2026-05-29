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
exports.SidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
const webviewHtml_1 = require("./webviewHtml");
class SidebarProvider {
    constructor(context, state, logger, handlers) {
        this.context = context;
        this.state = state;
        this.logger = logger;
        this.handlers = handlers;
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        this.logger.info("Sidebar webview resolved.");
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media")
            ]
        };
        webviewView.webview.html = (0, webviewHtml_1.renderWebviewHtml)({
            extensionUri: this.context.extensionUri,
            webview: webviewView.webview,
            scriptPath: "media/sidebar.js",
            stylePath: "media/sidebar.css",
            title: "Codex"
        });
        webviewView.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message);
        });
    }
    postSnapshot() {
        this.view?.webview.postMessage({
            type: "sidebar.snapshot",
            snapshot: this.state.getSidebarSnapshot()
        });
    }
    postEvent(event, payload) {
        this.view?.webview.postMessage({ type: "event", event, payload });
    }
    async handleMessage(message) {
        if (!message || typeof message !== "object") {
            return;
        }
        if (message.type === "ready") {
            this.logger.info("Sidebar webview ready.");
            this.logger.info(`Sidebar webview assets: ${message.assetMode ?? "unknown"}.`);
            this.postSnapshot();
            this.logger.info("Auth restore deferred: runtime will start on explicit auth or send.");
            return;
        }
        if (message.type !== "command") {
            return;
        }
        this.logger.info(`Sidebar command: ${message.command}`);
        switch (message.command) {
            case "auth.deviceCode.start":
                await this.handlers.startDeviceCodeLogin();
                return;
            case "auth.deviceCode.openUrl":
                await this.handlers.openDeviceCodeUrl();
                return;
            case "auth.deviceCode.copyCode":
                await this.handlers.copyDeviceCode();
                return;
            case "auth.deviceCode.copyUrl":
                await this.handlers.copyDeviceCodeUrl();
                return;
            case "auth.deviceCode.copyBundle":
                await this.handlers.copyDeviceCodeBundle();
                return;
            case "auth.apiKey.login":
                if (isObject(message.payload) && typeof message.payload.apiKey === "string") {
                    await this.handlers.loginWithApiKey(message.payload.apiKey);
                }
                return;
            case "settings.proxy.open":
            case "settings.open":
                await this.handlers.openSettings();
                return;
            case "logs.open":
                this.handlers.openLogs();
                return;
            case "chat.createProject":
                await this.handlers.createChat("project");
                return;
            case "chat.createGeneral":
                await this.handlers.createChat("general");
                return;
            case "chat.open":
                if (isObject(message.payload) && typeof message.payload.chatId === "string") {
                    await this.handlers.openChat(message.payload.chatId);
                }
                return;
            case "chat.rename":
                if (isObject(message.payload) && typeof message.payload.chatId === "string") {
                    await this.handlers.renameChat(message.payload.chatId);
                }
                return;
            case "chat.archive":
                if (isObject(message.payload) && typeof message.payload.chatId === "string") {
                    await this.handlers.archiveChat(message.payload.chatId);
                }
                return;
            case "chat.restore":
                if (isObject(message.payload) && typeof message.payload.chatId === "string") {
                    await this.handlers.restoreChat(message.payload.chatId);
                }
                return;
            case "chat.delete":
                if (isObject(message.payload) && typeof message.payload.chatId === "string") {
                    await this.handlers.deleteChat(message.payload.chatId);
                }
                return;
            default:
                this.postEvent("shell.notice", `Команда ${message.command} пока не подключена.`);
        }
    }
}
exports.SidebarProvider = SidebarProvider;
function isObject(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=sidebarProvider.js.map
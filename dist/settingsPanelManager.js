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
exports.SettingsPanelManager = exports.SETTINGS_PANEL_VIEW_TYPE = void 0;
const vscode = __importStar(require("vscode"));
const panelIcon_1 = require("./panelIcon");
const webviewHtml_1 = require("./webviewHtml");
exports.SETTINGS_PANEL_VIEW_TYPE = "codexElement.settingsPanel";
class SettingsPanelManager {
    constructor(context, settings, normalizer, baseContext, logger, onSettingsChanged) {
        this.context = context;
        this.settings = settings;
        this.normalizer = normalizer;
        this.baseContext = baseContext;
        this.logger = logger;
        this.onSettingsChanged = onSettingsChanged;
        this.normalizerProgress = {
            status: "idle",
            percent: 0,
            stage: "idle",
            message: ""
        };
    }
    registerSerializer() {
        return vscode.window.registerWebviewPanelSerializer(exports.SETTINGS_PANEL_VIEW_TYPE, {
            deserializeWebviewPanel: async (panel) => {
                this.logger.info("Restoring settings panel.");
                this.setupPanel(panel);
            }
        });
    }
    open() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(exports.SETTINGS_PANEL_VIEW_TYPE, "Codex: Настройки", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            enableFindWidget: false,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, "media"),
                vscode.Uri.joinPath(this.context.extensionUri, "resources")
            ]
        });
        this.setupPanel(panel);
    }
    setupPanel(panel) {
        this.panel = panel;
        panel.title = "Codex: Настройки";
        panel.iconPath = (0, panelIcon_1.getCodexPanelIconPath)(this.context);
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
            scriptPath: "media/settings.js",
            stylePath: "media/settings.css",
            title: "Codex: Настройки"
        });
        panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(panel, message);
        });
        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
            }
            this.logger.info("Settings panel disposed.");
        });
    }
    async handleMessage(panel, message) {
        if (!message || typeof message !== "object") {
            return;
        }
        if (message.type === "ready") {
            this.logger.info("Settings panel webview ready.");
            this.logger.info(`Settings panel webview assets: ${message.assetMode ?? "unknown"}.`);
            await this.postSnapshot(panel);
            return;
        }
        if (message.type !== "command") {
            return;
        }
        this.logger.info(`Settings panel command: ${message.command}`);
        if (message.command === "settings.docs.openBaseContext") {
            await this.baseContext.openBaseContextFile();
            return;
        }
        if (message.command === "settings.docs.normalize") {
            await this.normalizeDocs(panel, message.payload);
            return;
        }
        if (message.command === "settings.docs.save") {
            const normalizedPath = parseDocsPath(message.payload);
            if (normalizedPath === undefined) {
                await panel.webview.postMessage({
                    type: "event",
                    event: "settings.error",
                    payload: "Некорректный путь к документации."
                });
                return;
            }
            this.settings.saveDocsNormalizedPath(normalizedPath);
            await this.onSettingsChanged({ restartRuntime: false });
            await panel.webview.postMessage({
                type: "event",
                event: "settings.saved",
                payload: normalizedPath.trim() ? "Путь к документации сохранен." : "Путь к документации очищен."
            });
            await this.postSnapshot(panel);
            this.logger.info(normalizedPath.trim() ? "Docs settings saved." : "Docs settings cleared.");
            return;
        }
        if (message.command !== "settings.proxy.save") {
            await panel.webview.postMessage({
                type: "event",
                event: "settings.error",
                payload: "Команда настроек пока не подключена."
            });
            return;
        }
        const input = parseProxySaveInput(message.payload);
        if (!input) {
            await panel.webview.postMessage({
                type: "event",
                event: "settings.error",
                payload: "Некорректные данные proxy."
            });
            return;
        }
        try {
            await this.settings.saveProxy(input);
            await this.onSettingsChanged({ restartRuntime: true });
            await panel.webview.postMessage({
                type: "event",
                event: "settings.saved",
                payload: input.url.trim() ? "Proxy сохранен." : "Proxy очищен."
            });
            await this.postSnapshot(panel);
            this.logger.info(input.url.trim() ? "Proxy settings saved." : "Proxy settings cleared.");
        }
        catch (error) {
            await panel.webview.postMessage({
                type: "event",
                event: "settings.error",
                payload: error instanceof Error ? error.message : "Не удалось сохранить proxy."
            });
        }
    }
    async postSnapshot(panel) {
        await panel.webview.postMessage({
            type: "settings.snapshot",
            snapshot: {
                proxy: await this.settings.getProxySettingsView(),
                docs: this.settings.getDocsSettingsView(),
                normalizer: this.normalizerProgress
            }
        });
    }
    async normalizeDocs(panel, payload) {
        const requestedOutput = parseDocsPath(payload)?.trim();
        let sourcePath = this.normalizer.findBundledSourcePath();
        if (!sourcePath) {
            const manualSource = await vscode.window.showInputBox({
                title: "Путь к документации Element",
                prompt: "Укажите каталог docs/help/ru из bundle Element.",
                value: this.settings.getDocsSettingsView().sourcePath,
                ignoreFocusOut: true
            });
            if (!manualSource) {
                await panel.webview.postMessage({
                    type: "event",
                    event: "settings.saved",
                    payload: "Нормализация отменена."
                });
                return;
            }
            sourcePath = manualSource.trim();
        }
        const sourceValidation = this.normalizer.validateSourcePath(sourcePath);
        if (sourceValidation) {
            await panel.webview.postMessage({
                type: "event",
                event: "settings.error",
                payload: sourceValidation
            });
            return;
        }
        const outputPath = requestedOutput || this.normalizer.getDefaultOutputPath();
        this.settings.saveDocsSourcePath(sourcePath);
        try {
            const result = await this.normalizer.normalize({
                sourcePath,
                outputPath,
                onProgress: (progress) => {
                    this.normalizerProgress = progress;
                    void panel.webview.postMessage({
                        type: "event",
                        event: "settings.docs.normalize.progress",
                        payload: progress
                    });
                }
            });
            this.settings.saveDocsPaths(result.sourcePath, result.outputPath);
            await this.onSettingsChanged({ restartRuntime: false });
            await panel.webview.postMessage({
                type: "event",
                event: "settings.saved",
                payload: `Документация нормализована. Страниц: ${result.pageCount}.`
            });
            await this.postSnapshot(panel);
            this.logger.info(`Docs normalized: ${result.pageCount} pages from ${result.sourcePath} to ${result.outputPath}.`);
        }
        catch (error) {
            await panel.webview.postMessage({
                type: "event",
                event: "settings.error",
                payload: error instanceof Error ? error.message : "Не удалось нормализовать документацию."
            });
        }
    }
}
exports.SettingsPanelManager = SettingsPanelManager;
function parseProxySaveInput(payload) {
    if (!payload || typeof payload !== "object") {
        return undefined;
    }
    const value = payload;
    if (typeof value.url !== "string" || typeof value.username !== "string" || typeof value.password !== "string") {
        return undefined;
    }
    return {
        url: value.url,
        username: value.username,
        password: value.password
    };
}
function parseDocsPath(payload) {
    if (!payload || typeof payload !== "object") {
        return undefined;
    }
    const value = payload;
    return typeof value.normalizedPath === "string" ? value.normalizedPath : undefined;
}
//# sourceMappingURL=settingsPanelManager.js.map
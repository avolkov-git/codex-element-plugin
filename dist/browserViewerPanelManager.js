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
exports.BrowserViewerPanelManager = exports.BROWSER_VIEWER_TYPE = void 0;
const vscode = __importStar(require("vscode"));
const panelIcon_1 = require("./panelIcon");
const webviewHtml_1 = require("./webviewHtml");
exports.BROWSER_VIEWER_TYPE = "codexElement.browserViewer";
class BrowserViewerPanelManager {
    constructor(context, viewer) {
        this.context = context;
        this.viewer = viewer;
        this.ready = false;
        this.documentVisible = true;
        this.panelSubscriptions = [];
        this.subscriptions = [
            viewer.onState(state => { if (this.ready)
                this.post(state); }),
            viewer.onFrame(frame => { if (this.ready && this.panel?.visible && this.documentVisible)
                this.post(frame); })
        ];
    }
    open() {
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn);
            return;
        }
        this.setup(vscode.window.createWebviewPanel(exports.BROWSER_VIEWER_TYPE, "Codex: Браузер", vscode.ViewColumn.Beside, {
            enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
        }));
    }
    registerSerializer() {
        return vscode.window.registerWebviewPanelSerializer(exports.BROWSER_VIEWER_TYPE, {
            deserializeWebviewPanel: async (panel) => { if (this.panel)
                panel.dispose();
            else
                this.setup(panel); }
        });
    }
    post(message) {
        const panel = this.panel;
        if (!panel)
            return;
        const failed = () => {
            if (this.panel === panel) {
                this.ready = false;
                this.viewer.setVisible(false);
            }
        };
        try {
            void Promise.resolve(panel.webview.postMessage(message)).then(delivered => { if (!delivered)
                failed(); }, failed);
        }
        catch {
            failed();
        }
    }
    syncVisibility() {
        this.viewer.setVisible(this.ready && !!this.panel?.visible && this.documentVisible);
    }
    setup(panel) {
        this.panel = panel;
        this.ready = false;
        this.documentVisible = true;
        panel.title = "Codex: Браузер";
        panel.iconPath = (0, panelIcon_1.getCodexPanelIconPath)(this.context);
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
        this.panelSubscriptions = [
            panel.webview.onDidReceiveMessage(message => {
                if (this.panel !== panel || !message || typeof message !== "object")
                    return;
                if (message.type === "viewer.ready") {
                    this.ready = true;
                    this.documentVisible = message.visible !== false;
                    this.syncVisibility();
                }
                else if (!this.ready)
                    return;
                else if (message.type === "viewer.visibility" && typeof message.visible === "boolean") {
                    this.documentVisible = message.visible;
                    this.syncVisibility();
                }
                else if (message.sessionId !== this.viewer.getState().sessionId)
                    return;
                else if (message.type === "viewer.pause" && typeof message.paused === "boolean") {
                    this.viewer.setPaused(message.paused);
                    this.syncVisibility();
                }
                else if (message.type === "viewer.select" && typeof message.pageId === "string") {
                    this.viewer.selectPage(message.sessionId, message.pageId);
                }
                else if (message.type === "viewer.ack" && typeof message.pageId === "string" && Number.isSafeInteger(message.sequence)) {
                    this.viewer.acknowledge(message.sessionId, message.pageId, message.sequence);
                }
            }),
            panel.onDidChangeViewState(() => {
                if (panel.visible && !this.ready)
                    this.post({ type: "browser.viewer.readyRequest" });
                this.syncVisibility();
            }),
            panel.onDidDispose(() => {
                if (this.panel !== panel)
                    return;
                this.panel = undefined;
                this.ready = false;
                this.viewer.setVisible(false);
                for (const subscription of this.panelSubscriptions.splice(0))
                    subscription.dispose();
            })
        ];
        panel.webview.html = (0, webviewHtml_1.renderWebviewHtml)({
            extensionUri: this.context.extensionUri, webview: panel.webview,
            scriptPath: "media/browser-viewer.js", stylePath: "media/browser-viewer.css", title: "Codex: Браузер"
        });
    }
    dispose() {
        this.panel?.dispose();
        this.viewer.setVisible(false);
        for (const subscription of [...this.panelSubscriptions, ...this.subscriptions])
            subscription.dispose();
        this.panelSubscriptions = [];
    }
}
exports.BrowserViewerPanelManager = BrowserViewerPanelManager;
//# sourceMappingURL=browserViewerPanelManager.js.map
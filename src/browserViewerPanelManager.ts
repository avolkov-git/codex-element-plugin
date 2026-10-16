import * as vscode from "vscode";
import { BrowserViewerService } from "./browserViewerService";
import { getCodexPanelIconPath } from "./panelIcon";
import { renderWebviewHtml } from "./webviewHtml";

export const BROWSER_VIEWER_TYPE = "codexElement.browserViewer";

export class BrowserViewerPanelManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private documentVisible = true;
  private readonly subscriptions: vscode.Disposable[];
  private panelSubscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly viewer: BrowserViewerService) {
    this.subscriptions = [
      viewer.onState(state => { if (this.ready) this.post(state); }),
      viewer.onFrame(frame => { if (this.ready && this.panel?.visible && this.documentVisible) this.post(frame); }),
      viewer.onPointer(pointer => { if (this.ready && this.panel?.visible && this.documentVisible) this.post(pointer); }),
      viewer.onInputResult(result => { if (this.ready) this.post(result); })
    ];
  }

  open(): void {
    if (this.panel) { this.panel.reveal(this.panel.viewColumn); return; }
    this.setup(vscode.window.createWebviewPanel(BROWSER_VIEWER_TYPE, "Codex: Браузер", vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    }));
  }

  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(BROWSER_VIEWER_TYPE, {
      deserializeWebviewPanel: async panel => { if (this.panel) panel.dispose(); else this.setup(panel); }
    });
  }

  private post(message: object): void {
    const panel = this.panel;
    if (!panel) return;
    const failed = (): void => {
      if (this.panel === panel) { this.ready = false; this.viewer.setVisible(false); }
    };
    try {
      void Promise.resolve(panel.webview.postMessage(message)).then(delivered => { if (!delivered) failed(); }, failed);
    } catch { failed(); }
  }

  private syncVisibility(): void {
    this.viewer.setVisible(this.ready && !!this.panel?.visible && this.documentVisible);
  }

  private setup(panel: vscode.WebviewPanel): void {
    this.panel = panel; this.ready = false; this.documentVisible = true;
    panel.title = "Codex: Браузер";
    panel.iconPath = getCodexPanelIconPath(this.context);
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage(message => {
        if (this.panel !== panel || !message || typeof message !== "object") return;
        if (message.type === "viewer.ready") {
          this.ready = true; this.documentVisible = message.visible !== false; this.syncVisibility();
        } else if (!this.ready) return;
        else if (message.type === "viewer.visibility" && typeof message.visible === "boolean") {
          this.documentVisible = message.visible; this.syncVisibility();
        } else if (message.sessionId !== this.viewer.getState().sessionId) return;
        else if (message.type === "viewer.pause" && typeof message.paused === "boolean") {
          this.viewer.setPaused(message.paused); this.syncVisibility();
        } else if (message.type === "viewer.select" && typeof message.pageId === "string") {
          this.viewer.selectPage(message.sessionId, message.pageId);
        } else if (message.type === "viewer.control" && typeof message.pageId === "string" && typeof message.enabled === "boolean" && this.panel?.visible && this.documentVisible) {
          this.viewer.setControl(message.sessionId, message.pageId, message.enabled);
        } else if (message.type === "viewer.input" && typeof message.pageId === "string" && typeof message.controlId === "string" && this.panel?.visible && this.documentVisible) {
          this.viewer.sendInput(message.sessionId, message.pageId, message.controlId, message.inputId, message.input);
        } else if (message.type === "viewer.ack" && typeof message.pageId === "string" && Number.isSafeInteger(message.sequence)) {
          this.viewer.acknowledge(message.sessionId, message.pageId, message.sequence);
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible && !this.ready) this.post({ type: "browser.viewer.readyRequest" });
        this.syncVisibility();
      }),
      panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined; this.ready = false; this.viewer.setVisible(false);
        for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
      })
    ];
    panel.webview.html = renderWebviewHtml({
      extensionUri: this.context.extensionUri, webview: panel.webview,
      scriptPath: "media/browser-viewer.js", stylePath: "media/browser-viewer.css", title: "Codex: Браузер"
    });
  }

  dispose(): void {
    this.panel?.dispose(); this.viewer.setVisible(false);
    for (const subscription of [...this.panelSubscriptions, ...this.subscriptions]) subscription.dispose();
    this.panelSubscriptions = [];
  }
}

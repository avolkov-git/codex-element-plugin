import * as vscode from "vscode";
import { Logger } from "./logger";
import { ProxySaveInput, SettingsService } from "./settingsService";
import { WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const SETTINGS_PANEL_VIEW_TYPE = "codexElement.settingsPanel";

export class SettingsPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly onProxyChanged: () => Promise<void>
  ) {}

  registerSerializer(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(SETTINGS_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        this.logger.info("Restoring settings panel.");
        this.setupPanel(panel);
      }
    });
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SETTINGS_PANEL_VIEW_TYPE,
      "Codex: Настройки",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: false,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
          vscode.Uri.joinPath(this.context.extensionUri, "resources")
        ]
      }
    );

    this.setupPanel(panel);
  }

  private setupPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = "Codex: Настройки";
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icons", "codex.svg");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources")
      ]
    };
    panel.webview.html = renderWebviewHtml({
      extensionUri: this.context.extensionUri,
      webview: panel.webview,
      scriptPath: "media/settings.js",
      stylePath: "media/settings.css",
      title: "Codex: Настройки"
    });

    panel.webview.onDidReceiveMessage((message: WebviewCommand) => {
      void this.handleMessage(panel, message);
    });

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
      this.logger.info("Settings panel disposed.");
    });
  }

  private async handleMessage(panel: vscode.WebviewPanel, message: WebviewCommand): Promise<void> {
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
      await this.onProxyChanged();
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        payload: input.url.trim() ? "Proxy сохранен." : "Proxy очищен."
      });
      await this.postSnapshot(panel);
      this.logger.info(input.url.trim() ? "Proxy settings saved." : "Proxy settings cleared.");
    } catch (error) {
      await panel.webview.postMessage({
        type: "event",
        event: "settings.error",
        payload: error instanceof Error ? error.message : "Не удалось сохранить proxy."
      });
    }
  }

  private async postSnapshot(panel: vscode.WebviewPanel): Promise<void> {
    await panel.webview.postMessage({
      type: "settings.snapshot",
      snapshot: {
        proxy: await this.settings.getProxySettingsView()
      }
    });
  }
}

function parseProxySaveInput(payload: unknown): ProxySaveInput | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = payload as Record<string, unknown>;
  if (typeof value.url !== "string" || typeof value.username !== "string" || typeof value.password !== "string") {
    return undefined;
  }

  return {
    url: value.url,
    username: value.username,
    password: value.password
  };
}

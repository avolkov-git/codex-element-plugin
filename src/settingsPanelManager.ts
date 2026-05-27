import * as vscode from "vscode";
import { BaseContextService } from "./baseContextService";
import { DocsNormalizerProgress, DocsNormalizerService } from "./docsNormalizerService";
import { Logger } from "./logger";
import { getCodexPanelIconPath } from "./panelIcon";
import { RipgrepInstallProgress, RipgrepInstallerService } from "./ripgrepInstallerService";
import { ProxySaveInput, SettingsService } from "./settingsService";
import { WebviewCommand } from "./types";
import { renderWebviewHtml } from "./webviewHtml";

export const SETTINGS_PANEL_VIEW_TYPE = "codexElement.settingsPanel";

export class SettingsPanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private normalizerProgress: DocsNormalizerProgress = {
    status: "idle",
    percent: 0,
    stage: "idle",
    message: ""
  };
  private ripgrepProgress: RipgrepInstallProgress = {
    status: "idle",
    percent: 0,
    stage: "idle",
    message: ""
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly normalizer: DocsNormalizerService,
    private readonly ripgrepInstaller: RipgrepInstallerService,
    private readonly baseContext: BaseContextService,
    private readonly logger: Logger,
    private readonly onSettingsChanged: (options?: { restartRuntime?: boolean; docsChanged?: boolean }) => Promise<void>
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
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SETTINGS_PANEL_VIEW_TYPE,
      "Codex: Настройки",
      vscode.ViewColumn.One,
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
    panel.iconPath = getCodexPanelIconPath(this.context);
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
      await this.onSettingsChanged({ restartRuntime: false, docsChanged: true });
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        payload: normalizedPath.trim() ? "Путь к документации сохранен." : "Путь к документации очищен."
      });
      await this.postSnapshot(panel);
      this.logger.info(normalizedPath.trim() ? "Docs settings saved." : "Docs settings cleared.");
      return;
    }

    if (message.command === "settings.tools.ripgrep.save") {
      const ripgrepPath = parseRipgrepPath(message.payload);
      if (ripgrepPath === undefined) {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.error",
          payload: "Некорректный путь до rg."
        });
        return;
      }

      try {
        await this.settings.saveRipgrepPath(ripgrepPath);
        await this.onSettingsChanged({ restartRuntime: true });
        await panel.webview.postMessage({
          type: "event",
          event: "settings.saved",
          payload: ripgrepPath.trim() ? "Путь до rg сохранен." : "Путь до rg очищен."
        });
        await this.postSnapshot(panel);
        this.logger.info(ripgrepPath.trim() ? "ripgrep settings saved." : "ripgrep settings cleared.");
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.error",
          payload: error instanceof Error ? error.message : "Не удалось сохранить путь до rg."
        });
      }
      return;
    }

    if (message.command === "settings.tools.ripgrep.install") {
      await this.installRipgrep(panel);
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
        proxy: await this.settings.getProxySettingsView(),
        docs: this.settings.getDocsSettingsView(),
        tools: await this.settings.getToolsSettingsView(),
        normalizer: this.normalizerProgress,
        ripgrepInstaller: this.ripgrepProgress
      }
    });
  }

  private async installRipgrep(panel: vscode.WebviewPanel): Promise<void> {
    try {
      const result = await this.ripgrepInstaller.install({
        onProgress: (progress) => {
          this.ripgrepProgress = progress;
          void panel.webview.postMessage({
            type: "event",
            event: "settings.tools.ripgrep.install.progress",
            payload: progress
          });
        }
      });
      await this.onSettingsChanged({ restartRuntime: true });
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        payload: `ripgrep установлен, версия ${result.version}.`
      });
      await this.postSnapshot(panel);
      this.logger.info(`ripgrep install completed: version=${result.version}; path=${result.path}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось установить ripgrep.";
      if (this.ripgrepProgress?.status !== "error") {
        this.ripgrepProgress = {
          status: "error",
          percent: 0,
          stage: "error",
          message
        };
        await panel.webview.postMessage({
          type: "event",
          event: "settings.tools.ripgrep.install.progress",
          payload: this.ripgrepProgress
        });
      }
      this.logger.warn(`ripgrep install failed: ${message}`);
    }
  }

  private async normalizeDocs(panel: vscode.WebviewPanel, payload: unknown): Promise<void> {
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
      await this.onSettingsChanged({ restartRuntime: false, docsChanged: true });
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        payload: `Документация нормализована. Страниц: ${result.pageCount}.`
      });
      await this.postSnapshot(panel);
      this.logger.info(`Docs normalized: ${result.pageCount} pages from ${result.sourcePath} to ${result.outputPath}.`);
    } catch (error) {
      await panel.webview.postMessage({
        type: "event",
        event: "settings.error",
        payload: error instanceof Error ? error.message : "Не удалось нормализовать документацию."
      });
    }
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

function parseDocsPath(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = payload as Record<string, unknown>;
  return typeof value.normalizedPath === "string" ? value.normalizedPath : undefined;
}

function parseRipgrepPath(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  return typeof value.ripgrepPath === "string" ? value.ripgrepPath : undefined;
}

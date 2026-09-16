import * as vscode from "vscode";
import * as fs from "fs";
import { BaseContextService } from "./baseContextService";
import { BrowserPreferencesInput, BrowserRuntimeService, BrowserRuntimeTestResult } from "./browserRuntimeService";
import { CodexIntegrationsService, McpServerSaveInput } from "./codexIntegrationsService";
import { DocsNormalizerProgress, DocsNormalizerService } from "./docsNormalizerService";
import { Logger } from "./logger";
import { emptyExperimentalContext, ExperimentalContextControls } from "./experimentalContext";
import { getCodexPanelIconPath } from "./panelIcon";
import { hostPlatformId } from "./platform";
import { RipgrepInstallProgress, RipgrepInstallerService } from "./ripgrepInstallerService";
import { ProxySaveInput, SettingsService } from "./settingsService";
import { SkillSelection, WebviewCommand } from "./types";
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
  private ripgrepDiscoveryAttempted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly normalizer: DocsNormalizerService,
    private readonly ripgrepInstaller: RipgrepInstallerService,
    private readonly baseContext: BaseContextService,
    private readonly integrations: CodexIntegrationsService,
    private readonly browserRuntime: BrowserRuntimeService,
    private readonly logger: Logger,
    private readonly onSettingsChanged: (options?: { restartRuntime?: boolean; docsChanged?: boolean }) => Promise<void>,
    private readonly experimentalContext?: ExperimentalContextControls
  ) {
    if (this.experimentalContext) this.context.subscriptions.push(this.experimentalContext.onDidChangeExperimentalContext(() => {
      if (this.panel) void this.postSnapshot(this.panel).catch(() => this.logger.warn("Settings context snapshot failed."));
    }));
    this.context.subscriptions.push(this.integrations.onDidChange(() => {
      if (this.panel) {
        void this.postSnapshot(this.panel);
      }
    }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.panel && (event.affectsConfiguration("1C.applicationId") || event.affectsConfiguration("1C.serverExternalUri"))) {
        void this.refreshBrowserApplication(this.panel, true).catch(() => this.logger.warn("Settings application refresh failed."));
      }
    }));
  }

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
      preloadScriptPaths: ["media/settings-icons.js"],
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
      await this.discoverRipgrepIfNeeded();
      await this.refreshBrowserApplication(panel);
      return;
    }

    if (message.type !== "command") {
      return;
    }

    this.logger.info(`Settings panel command: ${message.command}`);
    try {
      await this.handleCommand(panel, message);
    } catch (error) {
      if (message.command === "settings.docs.baseContext.read" || message.command === "settings.docs.baseContext.save") {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.docs.baseContext.error",
          payload: error instanceof Error ? error.message : "Не удалось обновить базовый контекст."
        });
        return;
      }
      await this.postError(panel, error instanceof Error ? error.message : "Не удалось выполнить действие в настройках.", settingsScope(message.command));
    }
  }

  private async handleCommand(panel: vscode.WebviewPanel, message: Extract<WebviewCommand, { type: "command" }>): Promise<void> {

    if (message.command === "settings.experimentalContext.refresh" || message.command === "settings.experimentalContext.save") {
      if (!this.experimentalContext) throw new Error("Управление контекстом недоступно. Обновите плагин.");
      if (message.command.endsWith(".save")) {
        const input = message.payload;
        if (!isRecord(input) || typeof input.enabled !== "boolean" || typeof input.scopeId !== "string" || typeof input.revision !== "string") {
          throw new Error("Некорректная настройка контекста. Повторите проверку.");
        }
        await this.experimentalContext.saveExperimentalContext(input.enabled, input.scopeId, input.revision);
      } else {
        const result = await this.experimentalContext.refreshExperimentalContext();
        if (result.status === "error") throw new Error(result.message);
      }
      await this.postSnapshot(panel);
      await this.postSaved(panel, message.command.endsWith(".save") ? "Режим контекста сохранён и применён к app-server." : "Проверка завершена.", "experimentalContext");
      return;
    }

    if (message.command === "settings.docs.baseContext.read") {
      const result = await this.baseContext.readBaseContext();
      await panel.webview.postMessage({ type: "event", event: "settings.docs.baseContext.loaded", payload: result });
      return;
    }

    if (message.command === "settings.docs.baseContext.save") {
      if (!isRecord(message.payload) || typeof message.payload.text !== "string" || typeof message.payload.revision !== "string") {
        throw new Error("Некорректные данные базового контекста. Загрузите его заново перед сохранением.");
      }
      const revision = await this.baseContext.saveBaseContext(message.payload.text, message.payload.revision);
      await panel.webview.postMessage({
        type: "event",
        event: "settings.docs.baseContext.saved",
        payload: { revision, message: "Базовый контекст сохранен." }
      });
      return;
    }

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
          scope: "docs",
          payload: "Некорректный путь к документации."
        });
        return;
      }

      this.settings.saveDocsNormalizedPath(normalizedPath);
      await this.onSettingsChanged({ restartRuntime: false, docsChanged: true });
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        scope: "docs",
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
          scope: "tools",
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
          scope: "tools",
          payload: ripgrepPath.trim() ? "Путь до rg сохранен." : "Путь до rg очищен."
        });
        await this.postSnapshot(panel);
        this.logger.info(ripgrepPath.trim() ? "ripgrep settings saved." : "ripgrep settings cleared.");
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.error",
          scope: "tools",
          payload: error instanceof Error ? error.message : "Не удалось сохранить путь до rg."
        });
      }
      return;
    }

    if (message.command === "settings.tools.ripgrep.install") {
      await this.installRipgrep(panel);
      return;
    }

    if (message.command === "settings.integrations.refresh") {
      const scope = isRecord(message.payload) && message.payload.scope === "skills" ? "skills" : "mcp";
      await this.runIntegrationAction(panel, () => this.integrations.refresh(true), scope,
        scope === "skills" ? "Навыки обновлены." : "MCP-серверы обновлены.");
      return;
    }

    if (message.command === "settings.browser.save") {
      const input = parseBrowserSettingsInput(message.payload);
      if (!input) {
        await this.postError(panel, "Некорректные настройки браузера.", "browser");
        return;
      }
      try {
        const scope = this.browserRuntime.getBrowserArtifactsRoot();
        if (input.enabled) await this.browserRuntime.refreshApplication(true);
        if (scope !== this.browserRuntime.getBrowserArtifactsRoot()) throw new Error("Пользователь или проект IDE изменился. Повторите сохранение.");
        this.browserRuntime.saveSettings(input);
        await this.onSettingsChanged({ restartRuntime: true });
        await this.integrations.refresh(true);
        await this.postSaved(panel, input.enabled
          ? "Браузерное тестирование включено для текущего пользователя и проекта."
          : "Браузерное тестирование выключено.", "browser");
        await this.postSnapshot(panel);
      } catch (error) {
        await this.postError(panel, error instanceof Error ? error.message : "Не удалось сохранить браузерное тестирование.", "browser");
        await this.postSnapshot(panel);
      }
      return;
    }

    if (message.command === "settings.browser.application.refresh") {
      await this.refreshBrowserApplication(panel, true);
      return;
    }

    if (message.command === "settings.browser.test") {
      const result: BrowserRuntimeTestResult = await this.browserRuntime.test();
      await panel.webview.postMessage({ type: "event", event: "settings.browser.test.result", payload: result });
      return;
    }

    if (message.command === "settings.mcp.save") {
      const input = parseMcpServerInput(message.payload);
      if (!input) {
        await this.postMcpError(panel, "Проверьте параметры MCP-сервера.");
        return;
      }
      try {
        const savedName = await this.integrations.saveMcpServer(input);
        await panel.webview.postMessage({
          type: "event",
          event: "settings.mcp.saved",
          payload: `MCP-сервер ${savedName} сохранен.`
        });
        await this.postSnapshot(panel);
      } catch (error) {
        await this.postMcpError(panel, error instanceof Error ? error.message : "Не удалось сохранить MCP-сервер.");
      }
      return;
    }

    if (message.command === "settings.mcp.delete") {
      const name = parseStringField(message.payload, "name");
      if (!name) {
        await this.postError(panel, "MCP-сервер не выбран.");
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Удалить MCP-сервер ${name}?`,
        { modal: true },
        "Удалить"
      );
      if (confirmation === "Удалить") {
        await this.runIntegrationAction(panel, async () => {
          await this.integrations.removeMcpServer(name);
          await panel.webview.postMessage({ type: "event", event: "settings.mcp.deleted", payload: { name } });
          await this.postSaved(panel, `MCP-сервер ${name} удален.`);
        });
      }
      return;
    }

    if (message.command === "settings.mcp.test") {
      const name = parseStringField(message.payload, "name");
      if (!name) {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.mcp.test.result",
          payload: { name: "", status: "failed", message: "MCP-сервер не выбран." }
        });
        return;
      }
      try {
        const result = await this.integrations.testMcpServer(name);
        await panel.webview.postMessage({
          type: "event",
          event: "settings.mcp.test.result",
          payload: result
        });
        await this.postSnapshot(panel);
      } catch (error) {
        await panel.webview.postMessage({
          type: "event",
          event: "settings.mcp.test.result",
          payload: {
            name,
            status: "failed",
            message: "Не удалось проверить MCP-сервер.",
            details: error instanceof Error ? error.message : "Неизвестная ошибка проверки."
          }
        });
      }
      return;
    }

    if (message.command === "settings.mcp.toggle") {
      const name = parseStringField(message.payload, "name");
      const enabled = isRecord(message.payload) && typeof message.payload.enabled === "boolean" ? message.payload.enabled : undefined;
      if (!name || enabled === undefined) {
        await this.postError(panel, "Некорректное состояние MCP-сервера.");
        return;
      }
      await this.runIntegrationAction(panel, () => this.integrations.setMcpEnabled(name, enabled));
      return;
    }

    if (message.command === "settings.mcp.oauth") {
      const name = parseStringField(message.payload, "name");
      if (!name) {
        await this.postError(panel, "MCP-сервер не выбран.");
        return;
      }
      await this.runIntegrationAction(panel, () => this.integrations.startMcpOAuth(name));
      return;
    }

    if (message.command === "settings.skill.toggle") {
      const skill = parseSkillSelection(message.payload);
      const enabled = isRecord(message.payload) && typeof message.payload.enabled === "boolean" ? message.payload.enabled : undefined;
      if (!skill || enabled === undefined) {
        await this.postError(panel, "Некорректное состояние навыка.", "skills");
        return;
      }
      await this.runIntegrationAction(panel, () => this.integrations.setSkillEnabled(skill, enabled), "skills");
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
        scope: "proxy",
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
        scope: "proxy",
        payload: input.url.trim() ? "Proxy сохранен." : "Proxy очищен."
      });
      await this.postSnapshot(panel);
      this.logger.info(input.url.trim() ? "Proxy settings saved." : "Proxy settings cleared.");
    } catch (error) {
      await panel.webview.postMessage({
        type: "event",
        event: "settings.error",
        scope: "proxy",
        payload: error instanceof Error ? error.message : "Не удалось сохранить proxy."
      });
    }
  }

  private async refreshBrowserApplication(panel: vscode.WebviewPanel, force = false): Promise<void> {
    const refresh = this.browserRuntime.refreshApplication(force);
    await this.postSnapshot(panel);
    await refresh;
    await this.postSnapshot(panel);
  }

  private async postSnapshot(panel: vscode.WebviewPanel): Promise<void> {
    await panel.webview.postMessage({
      type: "settings.snapshot",
      snapshot: {
        extensionVersion: String(this.context.extension.packageJSON.version ?? ""),
        system: await this.getSystemView(),
        experimentalContext: this.experimentalContext?.getExperimentalContextView() ?? emptyExperimentalContext(),
        proxy: await this.settings.getProxySettingsView(),
        docs: this.settings.getDocsSettingsView(),
        tools: await this.settings.getToolsSettingsView(),
        browser: this.browserRuntime.getView(),
        integrations: this.integrations.getSnapshot(),
        normalizer: this.normalizerProgress,
        ripgrepInstaller: this.ripgrepProgress
      }
    });
  }

  private async getSystemView(): Promise<{ platformId: string; codexVersion: string }> {
    const system = { platformId: hostPlatformId(), codexVersion: "" };
    try {
      const manifestPath = vscode.Uri.joinPath(this.context.extensionUri, "bin", "runtime-manifest.json").fsPath;
      const stats = await fs.promises.stat(manifestPath);
      if (!stats.isFile() || stats.size > 64 * 1024) return system;
      const manifest: unknown = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      // This is the bundled release version, not a probe of the running runtime.
      if (isRecord(manifest) && typeof manifest.version === "string") system.codexVersion = manifest.version;
    } catch {
      // Older or incomplete installations may not include release metadata.
    }
    return system;
  }

  private async runIntegrationAction(panel: vscode.WebviewPanel, action: () => Promise<unknown>, scope = "mcp", successMessage?: string): Promise<void> {
    try {
      await action();
      await this.postSnapshot(panel);
      if (successMessage) await this.postSaved(panel, successMessage, scope);
    } catch (error) {
      await this.postError(panel, error instanceof Error ? error.message : "Не удалось обновить интеграции Codex.", scope);
    }
  }

  private async postSaved(panel: vscode.WebviewPanel, message: string, scope = "mcp"): Promise<void> {
    await panel.webview.postMessage({ type: "event", event: "settings.saved", payload: message, scope });
  }

  private async postError(panel: vscode.WebviewPanel, message: string, scope = "mcp"): Promise<void> {
    await panel.webview.postMessage({ type: "event", event: "settings.error", payload: message, scope });
  }

  private async postMcpError(panel: vscode.WebviewPanel, message: string): Promise<void> {
    await panel.webview.postMessage({ type: "event", event: "settings.mcp.error", payload: message });
  }

  private async discoverRipgrepIfNeeded(): Promise<void> {
    if (this.ripgrepDiscoveryAttempted) {
      return;
    }
    this.ripgrepDiscoveryAttempted = true;
    try {
      const discovered = await this.settings.discoverRipgrepPath();
      if (discovered?.ripgrepPath) {
        this.logger.info(
          `ripgrep discovered from settings panel: version=${discovered.ripgrepVersion || "-"}; path=${discovered.ripgrepPath}.`
        );
      }
    } catch (error) {
      this.logger.warn(`ripgrep discovery from settings panel skipped: ${error instanceof Error ? error.message : "unknown error"}`);
    }
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
        scope: "tools",
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
    try {
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
          await this.postNormalizerProgress(panel, { status: "idle", percent: 0, stage: "cancelled", message: "Нормализация отменена." });
          await this.postSaved(panel, "Нормализация отменена.", "docs");
          return;
        }
        sourcePath = manualSource.trim();
      }

      const sourceValidation = this.normalizer.validateSourcePath(sourcePath);
      if (sourceValidation) throw new Error(sourceValidation);

      const outputPath = requestedOutput || this.normalizer.getDefaultOutputPath();
      this.settings.saveDocsSourcePath(sourcePath);

      const result = await this.normalizer.normalize({
        sourcePath,
        outputPath,
        onProgress: (progress) => {
          void this.postNormalizerProgress(panel, progress);
        }
      });
      this.settings.saveDocsPaths(result.sourcePath, result.outputPath);
      await this.onSettingsChanged({ restartRuntime: false, docsChanged: true });
      await panel.webview.postMessage({
        type: "event",
        event: "settings.saved",
        scope: "docs",
        payload: `Документация нормализована. Страниц: ${result.pageCount}.`
      });
      await this.postSnapshot(panel);
      this.logger.info(`Docs normalized: ${result.pageCount} pages from ${result.sourcePath} to ${result.outputPath}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось нормализовать документацию.";
      await this.postNormalizerProgress(panel, { status: "error", percent: 0, stage: "error", message });
      await this.postError(panel, message, "docs");
    }
  }

  private async postNormalizerProgress(panel: vscode.WebviewPanel, progress: DocsNormalizerProgress): Promise<void> {
    this.normalizerProgress = progress;
    await panel.webview.postMessage({ type: "event", event: "settings.docs.normalize.progress", payload: progress });
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

function parseBrowserSettingsInput(payload: unknown): BrowserPreferencesInput | undefined {
  if (!isRecord(payload) || typeof payload.enabled !== "boolean" || typeof payload.disableSandbox !== "boolean") {
    return undefined;
  }
  return {
    enabled: payload.enabled,
    disableSandbox: payload.disableSandbox === true
  };
}

function settingsScope(command?: string): string {
  if (command?.startsWith("settings.experimentalContext.")) return "experimentalContext";
  if (command?.startsWith("settings.browser.")) return "browser";
  if (command?.startsWith("settings.docs.")) return "docs";
  if (command?.startsWith("settings.tools.")) return "tools";
  if (command?.startsWith("settings.proxy.")) return "proxy";
  if (command?.startsWith("settings.skill.")) return "skills";
  return "mcp";
}

function parseMcpServerInput(payload: unknown): McpServerSaveInput | undefined {
  if (!isRecord(payload) || typeof payload.name !== "string") {
    return undefined;
  }
  const transport = payload.transport === "stdio" || payload.transport === "http" ? payload.transport : undefined;
  if (!transport) {
    return undefined;
  }
  return {
    originalName: typeof payload.originalName === "string" ? payload.originalName : undefined,
    name: payload.name,
    transport,
    command: typeof payload.command === "string" ? payload.command : undefined,
    args: Array.isArray(payload.args) ? payload.args.filter((arg): arg is string => typeof arg === "string") : undefined,
    url: typeof payload.url === "string" ? payload.url : undefined,
    bearerTokenEnvVar: typeof payload.bearerTokenEnvVar === "string" ? payload.bearerTokenEnvVar : undefined,
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : true
  };
}

function parseSkillSelection(payload: unknown): SkillSelection | undefined {
  if (!isRecord(payload) || typeof payload.name !== "string" || typeof payload.path !== "string") {
    return undefined;
  }
  return { name: payload.name, path: payload.path };
}

function parseStringField(payload: unknown, field: string): string {
  return isRecord(payload) && typeof payload[field] === "string" ? payload[field].trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

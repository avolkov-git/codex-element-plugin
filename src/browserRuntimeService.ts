import { randomBytes, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MANAGED_BROWSER_MCP_NAME } from "./codexIntegrationConstants";
import { McpServerSaveInput } from "./codexIntegrationsService";
import { Logger } from "./logger";
import { RuntimeProcessManager } from "./runtimeProcessManager";
import type { BrowserApplicationProvider, ElementApplicationView } from "./elementApplicationService";
import { BrowserSettingsInput, BrowserSettingsView, SettingsService } from "./settingsService";

export type BrowserPreferencesInput = Pick<BrowserSettingsInput, "enabled" | "disableSandbox">;

interface BrowserRuntimeManifest {
  schemaVersion: number;
  platformId: string;
  playwrightMcpVersion: string;
  nodeVersion: string;
  chromiumVersion?: string;
  nodePath: string;
  launcherPath: string;
  browserExecutablePath: string;
}

export interface BrowserRuntimeView extends BrowserSettingsView {
  application: ElementApplicationView;
  status: "notInstalled" | "ready" | "error";
  statusMessage: string;
  platformId: string;
  playwrightMcpVersion: string;
  nodeVersion: string;
  chromiumVersion: string;
  managedServerName: string;
}

export interface BrowserRuntimeTestResult {
  status: "ready" | "failed";
  message: string;
  details?: string;
}

export interface BrowserRuntimeLaunchOptions {
  args: string[];
  managedServerName?: string;
  scopeRoot?: string;
  artifactsRoot?: string;
  disabledReason?: string;
}

interface ResolvedBrowserRuntime {
  root: string;
  manifest: BrowserRuntimeManifest;
  nodePath: string;
  launcherPath: string;
  browserExecutablePath: string;
}

export class BrowserRuntimeService {
  private readonly fileChecks = new Map<string, string>();
  private manifestCache: { signature: string; manifest: BrowserRuntimeManifest } | undefined;
  private preferenceCache: { signature: string; view: BrowserSettingsView } | undefined;
  private managedServer: { scopeRoot: string; server: McpServerSaveInput } | undefined;
  private testPromise: Promise<BrowserRuntimeTestResult> | undefined;

  // Scope callbacks supply authenticated namespaces, never guessed profile paths.
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly getScopeRoot?: () => string | undefined,
    private readonly getPersistentScopeRoot?: () => string | undefined,
    private readonly application?: BrowserApplicationProvider
  ) {}

  getView(): BrowserRuntimeView {
    const settings = this.getSettingsView();
    try {
      const runtime = this.resolveRuntime();
      return {
        ...settings,
        application: this.getApplicationView(),
        status: "ready",
        statusMessage: "Node.js, Playwright MCP и Chromium найдены в поставке.",
        platformId: runtime.manifest.platformId,
        playwrightMcpVersion: runtime.manifest.playwrightMcpVersion,
        nodeVersion: runtime.manifest.nodeVersion,
        chromiumVersion: typeof runtime.manifest.chromiumVersion === "string" ? runtime.manifest.chromiumVersion : "",
        managedServerName: this.getManagedServer()?.name ?? MANAGED_BROWSER_MCP_NAME
      };
    } catch (error) {
      const message = errorMessage(error);
      return {
        ...settings,
        application: this.getApplicationView(),
        status: message.includes("не установлен") ? "notInstalled" : "error",
        statusMessage: message,
        platformId: currentPlatformId(),
        playwrightMcpVersion: "",
        nodeVersion: "",
        chromiumVersion: "",
        managedServerName: MANAGED_BROWSER_MCP_NAME
      };
    }
  }

  prepareMcpServer(): McpServerSaveInput {
    const scopeRoot = this.resolveScopeRoot();
    if (!scopeRoot) {
      throw new Error("Для браузерного тестирования требуется подтвержденная область пользователя, проекта и сеанса.");
    }
    return this.prepareForScope(scopeRoot);
  }

  // Every app-server launch must supply this override, including disabled and
  // unauthenticated launches. Never inherit a managed entry from user config.
  prepareRuntimeLaunch(): BrowserRuntimeLaunchOptions {
    this.managedServer = undefined;
    const scopeRoot = this.resolveScopeRoot();
    const disabled = managedBrowserOverride(MANAGED_BROWSER_MCP_NAME, "codex-element-browser-disabled", [], false);
    try {
      if (!scopeRoot) {
        throw new Error("Область browser runtime не подтверждена.");
      }
      const server = this.prepareForScope(scopeRoot);
      // Config overrides deep-merge TOML tables. A never-persisted, unpredictable
      // name prevents foreign env/cwd/transport fields surviving that merge.
      server.name = `${MANAGED_BROWSER_MCP_NAME}-${randomBytes(16).toString("hex")}`;
      delete server.originalName;
      this.managedServer = { scopeRoot, server };
      return {
        args: [...disabled, ...managedBrowserOverride(server.name, server.command!, server.args ?? [], true)],
        managedServerName: server.name,
        scopeRoot,
        artifactsRoot: path.join(scopeRoot, "browser", "artifacts")
      };
    } catch (error) {
      return {
        args: disabled,
        disabledReason: errorMessage(error)
      };
    }
  }

  private prepareForScope(scopeRoot: string): McpServerSaveInput {
    const settings = this.getSettingsView();
    if (settings.validationMessage) {
      throw new Error(settings.validationMessage);
    }
    if (!settings.enabled) {
      throw new Error("Браузерное тестирование выключено.");
    }
    const runtime = this.resolveRuntime();
    const runtimeStateRoot = path.join(scopeRoot, "browser");
    const outputDir = path.join(runtimeStateRoot, "artifacts");
    const configPath = path.join(runtimeStateRoot, "playwright-mcp.config.json");
    const initPagePath = path.join(runtimeStateRoot, "init-page.ts");
    ensurePrivateDirectory(runtimeStateRoot);
    ensurePrivateDirectory(outputDir);

    const baseUrl = new URL(settings.baseUrl).toString();
    const initPage = [
      "export default async ({ page }) => {",
      "  await page.setViewportSize({ width: 1440, height: 900 });",
      `  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });`,
      "};",
      ""
    ].join("\n");
    writePrivateFile(initPagePath, initPage);

    const launchArgs = settings.disableSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
    const config = {
      browser: {
        browserName: "chromium",
        isolated: true,
        initPage: [initPagePath],
        launchOptions: {
          headless: true,
          executablePath: runtime.browserExecutablePath,
          args: launchArgs
        },
        contextOptions: {
          viewport: { width: 1440, height: 900 }
        }
      },
      outputDir,
      outputMaxSize: 20 * 1024 * 1024,
      imageResponses: "allow",
      timeouts: {
        action: 10_000,
        navigation: 30_000
      }
    };
    writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    this.logger.info(
      `Browser MCP prepared: platform=${runtime.manifest.platformId}; network=unrestricted; sandbox=${settings.disableSandbox ? "disabled" : "enabled"}.`
    );
    return {
      originalName: MANAGED_BROWSER_MCP_NAME,
      name: MANAGED_BROWSER_MCP_NAME,
      transport: "stdio",
      command: runtime.nodePath,
      args: [runtime.launcherPath, "--config", configPath],
      enabled: true
    };
  }

  getBrowserArtifactsRoot(): string | undefined {
    const root = this.resolveScopeRoot();
    return root ? path.join(root, "browser", "artifacts") : undefined;
  }

  getManagedServer(): McpServerSaveInput | undefined {
    const managed = this.managedServer;
    if (!managed || managed.scopeRoot !== this.resolveScopeRoot()) {
      return undefined;
    }
    return { ...managed.server, args: [...managed.server.args ?? []] };
  }

  getSettingsView(): BrowserSettingsView {
    const preferences = this.readPreferences();
    const application = this.getApplicationView();
    return {
      ...preferences,
      baseUrl: application.status === "ready" ? application.url : "",
      validationMessage: preferences.validationMessage || (preferences.enabled && application.status !== "ready" ? application.message : "")
    };
  }

  async refreshApplication(force = false): Promise<void> {
    if (this.resolvePersistentScopeRoot()) await this.application?.resolve(force);
  }

  private getApplicationView(): ElementApplicationView {
    return this.application?.getView() ?? { status: "error", url: "", name: "", message: "Не удалось определить приложение текущей IDE." };
  }

  private readPreferences(): BrowserSettingsView {
    const empty = { enabled: false, baseUrl: "", allowedOrigins: [], disableSandbox: false, validationMessage: "" };
    const root = this.resolvePersistentScopeRoot();
    if (!root) {
      return { ...empty, validationMessage: "Область пользователя и проекта для настроек браузера не подтверждена." };
    }
    const filePath = path.join(root, "browser-settings.json");
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 32 * 1024) {
        throw new Error("Некорректный файл настроек браузера.");
      }
      const signature = fileSignature(filePath, stats);
      if (this.preferenceCache?.signature === signature) {
        return { ...this.preferenceCache.view, allowedOrigins: [...this.preferenceCache.view.allowedOrigins] };
      }
      const input = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (input?.schemaVersion !== 1 && input?.schemaVersion !== 2) throw new Error("Неизвестная версия настроек браузера.");
      const view = normalizeBrowserPreferences(input);
      this.preferenceCache = { signature, view };
      return { ...view, allowedOrigins: [...view.allowedOrigins] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      return { ...empty, validationMessage: errorMessage(error) };
    }
  }

  saveSettings(input: BrowserPreferencesInput): BrowserSettingsView {
    const root = this.resolvePersistentScopeRoot();
    if (!root) throw new Error("Область пользователя и проекта для настроек браузера не подтверждена.");
    const view = normalizeBrowserPreferences(input);
    if (view.enabled && this.getApplicationView().status !== "ready") throw new Error(this.getApplicationView().message);
    ensurePrivateDirectory(root);
    // Never persist an application address in preferences shared by project deployments.
    const { enabled, disableSandbox } = view;
    writePrivateFile(path.join(root, "browser-settings.json"), `${JSON.stringify({ schemaVersion: 2, enabled, disableSandbox }, null, 2)}\n`);
    this.preferenceCache = undefined;
    return this.getSettingsView();
  }

  private resolvePersistentScopeRoot(): string | undefined {
    // No migration from server-global preferences: they may belong to another user.
    if (!this.resolveScopeRoot()) return undefined;
    return this.validateScopeRoot(this.getPersistentScopeRoot?.());
  }

  private resolveScopeRoot(): string | undefined {
    return this.validateScopeRoot(this.getScopeRoot?.());
  }

  private validateScopeRoot(root: string | undefined): string | undefined {
    if (!root || !path.isAbsolute(root) || root.includes("\0")) {
      return undefined;
    }
    const resolved = path.resolve(root);
    const shared = path.resolve(this.settings.getConfigRoot());
    if (resolved === shared || resolved === path.join(shared, "browser")) {
      return undefined;
    }
    return resolved;
  }

  test(): Promise<BrowserRuntimeTestResult> {
    if (!this.testPromise) {
      this.testPromise = this.runTest().finally(() => { this.testPromise = undefined; });
    }
    return this.testPromise;
  }

  private async runTest(): Promise<BrowserRuntimeTestResult> {
    let stage = "компоненты браузера";
    const startedAt = Date.now();
    try {
      const runtime = this.resolveRuntime();
      const settings = this.getSettingsView();
      this.logger.info(`Browser check started: platform=${runtime.manifest.platformId}; mcp=${runtime.manifest.playwrightMcpVersion}.`);
      stage = "Node.js";
      const node = await runProcess(runtime.nodePath, ["--version"], 8_000, stage);
      stage = "Playwright MCP";
      await runProcess(runtime.nodePath, [runtime.launcherPath, "--help"], 12_000, stage);
      stage = "Chromium";
      // Windows chrome.exe is a GUI executable; --version is not a portable probe.
      const browser = await smokeTestBrowser(runtime, settings.disableSandbox);
      this.logger.info(`Browser check passed: chromium=${browser}; durationMs=${Date.now() - startedAt}.`);
      return {
        status: "ready",
        message: "Браузер проверен: страница открыта, нажатие кнопки выполнено.",
        details: `Node.js ${node.trim()} · Chromium ${browser} · Playwright MCP ${runtime.manifest.playwrightMcpVersion}`
      };
    } catch (error) {
      this.logger.warn(`Browser check failed: stage=${stage}; durationMs=${Date.now() - startedAt}; ${errorMessage(error)}`);
      return {
        status: "failed",
        message: `Не удалось проверить ${stage}. Подробности записаны в логи Codex.`,
        details: errorMessage(error)
      };
    }
  }

  private resolveRuntime(): ResolvedBrowserRuntime {
    const platformId = currentPlatformId();
    const root = path.join(this.context.extensionUri.fsPath, "browser", platformId);
    const manifestPath = path.join(root, "runtime.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Browser runtime для ${platformId} не установлен в поставке плагина.`);
    }
    let manifest: BrowserRuntimeManifest;
    try {
      const stats = fs.statSync(manifestPath);
      const signature = fileSignature(manifestPath, stats);
      if (!stats.isFile() || stats.size > 64 * 1024) {
        throw new Error("Invalid runtime manifest size");
      }
      if (this.manifestCache?.signature === signature) {
        manifest = this.manifestCache.manifest;
      } else {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BrowserRuntimeManifest;
        this.manifestCache = { signature, manifest };
      }
    } catch {
      throw new Error("Manifest встроенного browser runtime поврежден.");
    }
    if (!manifest || manifest.schemaVersion !== 1 || manifest.platformId !== platformId) {
      throw new Error(`Browser runtime не соответствует платформе ${platformId}.`);
    }
    const nodePath = resolveContainedFile(root, manifest.nodePath, "Node.js", this.fileChecks);
    const launcherPath = resolveContainedFile(root, manifest.launcherPath, "Playwright MCP launcher", this.fileChecks);
    const browserExecutablePath = resolveContainedFile(root, manifest.browserExecutablePath, "Chromium", this.fileChecks);
    return { root, manifest, nodePath, launcherPath, browserExecutablePath };
  }
}

async function smokeTestBrowser(runtime: ResolvedBrowserRuntime, disableSandbox: boolean): Promise<string> {
  const playwrightModule = path.join(runtime.root, "node_modules", "playwright");
  const script = [
    "const { chromium } = require(process.argv[1]);",
    "const executablePath = process.argv[2];",
    "const disableSandbox = process.argv[3] === '1';",
    "(async () => {",
    "  const args = disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];",
    "  const browser = await chromium.launch({ headless: true, executablePath, args, timeout: 20000 });",
    "  try {",
    "    const page = await browser.newPage();",
    "    page.setDefaultTimeout(5000);",
    "    const html = '<!doctype html><title>Codex browser check</title><button>Check</button><script>document.querySelector(\"button\").onclick = () => document.title = \"Codex browser check passed\";</script>';",
    "    await page.goto('data:text/html,' + encodeURIComponent(html));",
    "    await page.getByRole('button', { name: 'Check', exact: true }).click();",
    "    if (await page.title() !== 'Codex browser check passed') throw new Error('Нажатие кнопки не изменило тестовую страницу.');",
    "    console.log(JSON.stringify({ browserVersion: browser.version() }));",
    "  } finally {",
    "    await browser.close();",
    "  }",
    "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });"
  ].join("\n");
  const output = await runProcess(
    runtime.nodePath,
    ["-e", script, playwrightModule, runtime.browserExecutablePath, disableSandbox ? "1" : "0"],
    45_000,
    "Chromium"
  );
  const result = JSON.parse(output.trim()) as { browserVersion?: unknown };
  if (typeof result.browserVersion !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(result.browserVersion)) {
    throw new Error("Chromium запущен, но Playwright не вернул корректную версию браузера.");
  }
  return result.browserVersion;
}

function currentPlatformId(): string {
  return `${process.platform}-${process.arch}`;
}

function resolveContainedFile(root: string, relativePath: string, label: string, cache: Map<string, string>): string {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label}: manifest содержит небезопасный путь.`);
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label}: путь выходит за пределы browser runtime.`);
  }
  let stats: fs.Stats;
  try {
    const realRelative = path.relative(fs.realpathSync(resolvedRoot), fs.realpathSync(candidate));
    if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error("Runtime symlink escapes root");
    }
    stats = fs.statSync(candidate);
  } catch {
    throw new Error(`${label} отсутствует в поставке.`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} не является файлом.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0 && label !== "Playwright MCP launcher") {
    throw new Error(`${label} не имеет executable bit.`);
  }
  const signature = fileSignature(candidate, stats);
  if (cache.get(candidate) !== signature) {
    const fd = fs.openSync(candidate, "r");
    try {
      const buffer = Buffer.alloc(128);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (buffer.toString("utf8", 0, size).startsWith("version https://git-lfs.github.com/spec/v1")) {
        throw new Error(`${label} остался Git LFS pointer вместо бинарного файла.`);
      }
      if (fileSignature(candidate, fs.fstatSync(fd)) !== signature) {
        throw new Error(`${label} изменился во время проверки. Повторите проверку.`);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (cache.size >= 16) {
      cache.clear();
    }
    cache.set(candidate, signature);
  }
  return candidate;
}

function fileSignature(filePath: string, stats: fs.Stats): string {
  return `${filePath}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.mode}`;
}

function managedBrowserOverride(name: string, command: string, args: string[], enabled: boolean): string[] {
  const table = `{command=${JSON.stringify(command)},args=[${args.map((arg) => JSON.stringify(arg)).join(",")}],enabled=${enabled}}`;
  return ["-c", `mcp_servers.${name}=${table}`];
}

function normalizeBrowserPreferences(input: BrowserPreferencesInput): BrowserSettingsView {
  if (!input || typeof input.enabled !== "boolean"
    || typeof input.disableSandbox !== "boolean") {
    throw new Error("Некорректные настройки браузера.");
  }
  return { enabled: input.enabled, baseUrl: "", allowedOrigins: [], disableSandbox: input.disableSandbox, validationMessage: "" };
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Каталог browser runtime не должен быть символической ссылкой.");
  }
}

function writePrivateFile(filePath: string, content: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function runProcess(command: string, args: string[], timeoutMs: number, label: string): Promise<string> {
  const processManager = new RuntimeProcessManager();
  let stdout = "";
  let stderr = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: проверка не завершилась за ${timeoutMs / 1000} с. ${stderr.trim().slice(-2000)}`.trim())), timeoutMs);
      processManager.start({
        command, args, cwd: path.dirname(command), env: process.env,
        maxLineBytes: 64 * 1024,
        onStdout: (line) => { stdout = `${stdout}${line}\n`.slice(-64 * 1024); },
        onStderr: (line) => { stderr = `${stderr}${line}\n`.slice(-64 * 1024); },
        onError: reject,
        onExit: (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`${label}: процесс завершился с кодом ${code ?? signal ?? "?"}. ${(stderr || stdout).trim().slice(-2000)}`));
        }
      });
    });
  } finally {
    clearTimeout(timer);
    // The existing manager owns the PID/tree; never kill other Chrome sessions.
    await processManager.stop(2_000);
  }
  return stdout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

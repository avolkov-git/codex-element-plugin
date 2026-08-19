import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MANAGED_BROWSER_MCP_NAME, McpServerSaveInput } from "./codexIntegrationsService";
import { Logger } from "./logger";
import { BrowserSettingsView, SettingsService } from "./settingsService";

interface BrowserRuntimeManifest {
  schemaVersion: number;
  platformId: string;
  playwrightMcpVersion: string;
  nodeVersion: string;
  nodePath: string;
  launcherPath: string;
  browserExecutablePath: string;
}

export interface BrowserRuntimeView extends BrowserSettingsView {
  status: "notInstalled" | "ready" | "error";
  statusMessage: string;
  platformId: string;
  playwrightMcpVersion: string;
  nodeVersion: string;
  managedServerName: string;
}

export interface BrowserRuntimeTestResult {
  status: "ready" | "failed";
  message: string;
  details?: string;
}

interface ResolvedBrowserRuntime {
  root: string;
  manifest: BrowserRuntimeManifest;
  nodePath: string;
  launcherPath: string;
  browserExecutablePath: string;
}

export class BrowserRuntimeService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly logger: Logger
  ) {}

  getView(): BrowserRuntimeView {
    const settings = this.settings.getBrowserSettingsView();
    try {
      const runtime = this.resolveRuntime();
      return {
        ...settings,
        status: "ready",
        statusMessage: `Playwright MCP ${runtime.manifest.playwrightMcpVersion} готов к запуску.`,
        platformId: runtime.manifest.platformId,
        playwrightMcpVersion: runtime.manifest.playwrightMcpVersion,
        nodeVersion: runtime.manifest.nodeVersion,
        managedServerName: MANAGED_BROWSER_MCP_NAME
      };
    } catch (error) {
      const message = errorMessage(error);
      return {
        ...settings,
        status: message.includes("не установлен") ? "notInstalled" : "error",
        statusMessage: message,
        platformId: currentPlatformId(),
        playwrightMcpVersion: "",
        nodeVersion: "",
        managedServerName: MANAGED_BROWSER_MCP_NAME
      };
    }
  }

  prepareMcpServer(): McpServerSaveInput {
    const settings = this.settings.getBrowserSettingsView();
    if (!settings.enabled) {
      throw new Error("Браузерное тестирование выключено.");
    }
    if (settings.validationMessage) {
      throw new Error(settings.validationMessage);
    }
    const runtime = this.resolveRuntime();
    const runtimeStateRoot = path.join(this.settings.getConfigRoot(), "browser");
    const outputDir = path.join(runtimeStateRoot, "artifacts");
    const configPath = path.join(runtimeStateRoot, "playwright-mcp.config.json");
    const initPagePath = path.join(runtimeStateRoot, "init-page.ts");
    fs.mkdirSync(outputDir, { recursive: true });

    const baseUrl = new URL(settings.baseUrl).toString();
    const origins = new Set(settings.allowedOrigins);
    origins.add(new URL(baseUrl).origin);
    const initPage = [
      "export default async ({ page }) => {",
      "  await page.setViewportSize({ width: 1440, height: 900 });",
      `  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });`,
      "};",
      ""
    ].join("\n");
    fs.writeFileSync(initPagePath, initPage, "utf8");

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
      network: {
        allowedOrigins: [...origins]
      },
      outputDir,
      outputMaxSize: 20 * 1024 * 1024,
      imageResponses: "allow",
      timeouts: {
        action: 10_000,
        navigation: 30_000
      }
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    this.logger.info(
      `Browser MCP prepared: platform=${runtime.manifest.platformId}; origins=${origins.size}; sandbox=${settings.disableSandbox ? "disabled" : "enabled"}.`
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

  async test(): Promise<BrowserRuntimeTestResult> {
    try {
      const runtime = this.resolveRuntime();
      const settings = this.settings.getBrowserSettingsView();
      const [node, launcher, browser] = await Promise.all([
        runProcess(runtime.nodePath, ["--version"], 8_000),
        runProcess(runtime.nodePath, [runtime.launcherPath, "--help"], 12_000),
        runProcess(runtime.browserExecutablePath, ["--version"], 8_000)
      ]);
      await smokeTestBrowser(runtime, settings.disableSandbox);
      return {
        status: "ready",
        message: "Встроенный браузер и Playwright MCP готовы.",
        details: `${node.trim()} · ${browser.trim()} · MCP launcher ${launcher ? "ok" : "ok"} · запуск Chromium ok`
      };
    } catch (error) {
      return {
        status: "failed",
        message: "Не удалось проверить встроенный браузер.",
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
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BrowserRuntimeManifest;
    } catch {
      throw new Error("Manifest встроенного browser runtime поврежден.");
    }
    if (manifest.schemaVersion !== 1 || manifest.platformId !== platformId) {
      throw new Error(`Browser runtime не соответствует платформе ${platformId}.`);
    }
    const nodePath = resolveContainedFile(root, manifest.nodePath, "Node.js");
    const launcherPath = resolveContainedFile(root, manifest.launcherPath, "Playwright MCP launcher");
    const browserExecutablePath = resolveContainedFile(root, manifest.browserExecutablePath, "Chromium");
    return { root, manifest, nodePath, launcherPath, browserExecutablePath };
  }
}

async function smokeTestBrowser(runtime: ResolvedBrowserRuntime, disableSandbox: boolean): Promise<void> {
  const playwrightModule = path.join(runtime.root, "node_modules", "playwright");
  const script = [
    "const { chromium } = require(process.argv[1]);",
    "const executablePath = process.argv[2];",
    "const disableSandbox = process.argv[3] === '1';",
    "(async () => {",
    "  const args = disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];",
    "  const browser = await chromium.launch({ headless: true, executablePath, args });",
    "  try {",
    "    const page = await browser.newPage();",
    "    await page.goto('data:text/html,<title>Codex browser smoke test</title>');",
    "    if (await page.title() !== 'Codex browser smoke test') throw new Error('unexpected page title');",
    "  } finally {",
    "    await browser.close();",
    "  }",
    "})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });"
  ].join("\n");
  await runProcess(
    runtime.nodePath,
    ["-e", script, playwrightModule, runtime.browserExecutablePath, disableSandbox ? "1" : "0"],
    20_000
  );
}

function currentPlatformId(): string {
  return `${process.platform}-${process.arch}`;
}

function resolveContainedFile(root: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
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
    stats = fs.statSync(candidate);
  } catch {
    throw new Error(`${label} отсутствует в поставке.`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} не является файлом.`);
  }
  const head = fs.readFileSync(candidate).subarray(0, 128).toString("utf8");
  if (head.startsWith("version https://git-lfs.github.com/spec/v1")) {
    throw new Error(`${label} остался Git LFS pointer вместо бинарного файла.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0 && label !== "Playwright MCP launcher") {
    throw new Error(`${label} не имеет executable bit.`);
  }
  return candidate;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} не ответил за ${timeoutMs} мс.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout || stderr);
      } else {
        reject(new Error(`${path.basename(command)} завершился с кодом ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

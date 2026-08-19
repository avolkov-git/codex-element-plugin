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
exports.BrowserRuntimeService = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const codexIntegrationsService_1 = require("./codexIntegrationsService");
class BrowserRuntimeService {
    constructor(context, settings, logger) {
        this.context = context;
        this.settings = settings;
        this.logger = logger;
    }
    getView() {
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
                managedServerName: codexIntegrationsService_1.MANAGED_BROWSER_MCP_NAME
            };
        }
        catch (error) {
            const message = errorMessage(error);
            return {
                ...settings,
                status: message.includes("не установлен") ? "notInstalled" : "error",
                statusMessage: message,
                platformId: currentPlatformId(),
                playwrightMcpVersion: "",
                nodeVersion: "",
                managedServerName: codexIntegrationsService_1.MANAGED_BROWSER_MCP_NAME
            };
        }
    }
    prepareMcpServer() {
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
                action: 10000,
                navigation: 30000
            }
        };
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        this.logger.info(`Browser MCP prepared: platform=${runtime.manifest.platformId}; origins=${origins.size}; sandbox=${settings.disableSandbox ? "disabled" : "enabled"}.`);
        return {
            originalName: codexIntegrationsService_1.MANAGED_BROWSER_MCP_NAME,
            name: codexIntegrationsService_1.MANAGED_BROWSER_MCP_NAME,
            transport: "stdio",
            command: runtime.nodePath,
            args: [runtime.launcherPath, "--config", configPath],
            enabled: true
        };
    }
    async test() {
        try {
            const runtime = this.resolveRuntime();
            const settings = this.settings.getBrowserSettingsView();
            const [node, launcher, browser] = await Promise.all([
                runProcess(runtime.nodePath, ["--version"], 8000),
                runProcess(runtime.nodePath, [runtime.launcherPath, "--help"], 12000),
                runProcess(runtime.browserExecutablePath, ["--version"], 8000)
            ]);
            await smokeTestBrowser(runtime, settings.disableSandbox);
            return {
                status: "ready",
                message: "Встроенный браузер и Playwright MCP готовы.",
                details: `${node.trim()} · ${browser.trim()} · MCP launcher ${launcher ? "ok" : "ok"} · запуск Chromium ok`
            };
        }
        catch (error) {
            return {
                status: "failed",
                message: "Не удалось проверить встроенный браузер.",
                details: errorMessage(error)
            };
        }
    }
    resolveRuntime() {
        const platformId = currentPlatformId();
        const root = path.join(this.context.extensionUri.fsPath, "browser", platformId);
        const manifestPath = path.join(root, "runtime.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`Browser runtime для ${platformId} не установлен в поставке плагина.`);
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        }
        catch {
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
exports.BrowserRuntimeService = BrowserRuntimeService;
async function smokeTestBrowser(runtime, disableSandbox) {
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
    await runProcess(runtime.nodePath, ["-e", script, playwrightModule, runtime.browserExecutablePath, disableSandbox ? "1" : "0"], 20000);
}
function currentPlatformId() {
    return `${process.platform}-${process.arch}`;
}
function resolveContainedFile(root, relativePath, label) {
    if (!relativePath || path.isAbsolute(relativePath)) {
        throw new Error(`${label}: manifest содержит небезопасный путь.`);
    }
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(resolvedRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`${label}: путь выходит за пределы browser runtime.`);
    }
    let stats;
    try {
        stats = fs.statSync(candidate);
    }
    catch {
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
function runProcess(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { shell: false, windowsHide: true, env: process.env });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${path.basename(command)} не ответил за ${timeoutMs} мс.`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout || stderr);
            }
            else {
                reject(new Error(`${path.basename(command)} завершился с кодом ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
            }
        });
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=browserRuntimeService.js.map
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
exports.DocsNormalizerService = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class DocsNormalizerService {
    constructor(context, settings, logger) {
        this.context = context;
        this.settings = settings;
        this.logger = logger;
        this.running = false;
    }
    getDefaultOutputPath() {
        return this.settings.getDefaultDocsNormalizedPath();
    }
    getSavedSourcePath() {
        return this.settings.getDocsSettingsView().sourcePath;
    }
    findBundledSourcePath() {
        const saved = this.getSavedSourcePath();
        if (saved && !validateDocsSourcePath(saved)) {
            return path.resolve(saved);
        }
        const roots = new Set();
        addParentRoots(roots, this.context.extensionUri.fsPath);
        addParentRoots(roots, process.cwd());
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            addParentRoots(roots, folder.uri.fsPath);
        }
        for (const root of roots) {
            const candidates = [
                path.join(root, "docs", "help", "ru"),
                path.join(root, "server", "docs", "help", "ru"),
                path.join(root, "local-server", "docs", "help", "ru")
            ];
            for (const candidate of candidates) {
                if (!validateDocsSourcePath(candidate)) {
                    return path.resolve(candidate);
                }
            }
        }
        return undefined;
    }
    validateSourcePath(sourcePath) {
        return validateDocsSourcePath(sourcePath);
    }
    async normalize(options) {
        if (this.running) {
            throw new Error("Нормализация документации уже выполняется.");
        }
        const sourcePath = path.resolve(options.sourcePath);
        const outputPath = path.resolve(options.outputPath || this.getDefaultOutputPath());
        const sourceValidation = validateDocsSourcePath(sourcePath);
        if (sourceValidation) {
            throw new Error(sourceValidation);
        }
        this.running = true;
        const tempOutput = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
        const workerPath = path.join(__dirname, "docsNormalizerWorker.js");
        try {
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.rm(tempOutput, { recursive: true, force: true });
            options.onProgress({ status: "running", percent: 0, stage: "start", message: "Запуск нормализатора документации" });
            const result = await this.runWorker(workerPath, sourcePath, tempOutput, outputPath, options.onProgress);
            await replaceDirectory(outputPath, tempOutput);
            options.onProgress({ status: "completed", percent: 100, stage: "complete", message: `Нормализация завершена. Страниц: ${result.pageCount}.` });
            return {
                sourcePath,
                outputPath,
                pageCount: result.pageCount
            };
        }
        catch (error) {
            await fs.promises.rm(tempOutput, { recursive: true, force: true }).catch(() => undefined);
            options.onProgress({
                status: "error",
                percent: 0,
                stage: "error",
                message: error instanceof Error ? error.message : "Нормализация завершилась ошибкой."
            });
            throw error;
        }
        finally {
            this.running = false;
        }
    }
    runWorker(workerPath, sourcePath, tempOutput, outputPath, onProgress) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(process.execPath, [
                workerPath,
                "--source",
                sourcePath,
                "--temp-output",
                tempOutput,
                "--final-output",
                outputPath
            ], {
                cwd: path.dirname(workerPath),
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env
            });
            let stdoutBuffer = "";
            let completedPageCount = 0;
            let rejected = false;
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                stdoutBuffer += chunk;
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() ?? "";
                for (const line of lines) {
                    if (!line.trim()) {
                        continue;
                    }
                    const event = parseWorkerEvent(line);
                    if (!event) {
                        this.logger.warn(`Docs normalizer emitted non-json line: ${line}`);
                        continue;
                    }
                    if (event.type === "progress") {
                        onProgress({
                            status: "running",
                            percent: clampPercent(event.percent),
                            stage: typeof event.stage === "string" ? event.stage : "running",
                            message: typeof event.message === "string" ? event.message : "Нормализация выполняется"
                        });
                    }
                    else if (event.type === "complete") {
                        completedPageCount = typeof event.pageCount === "number" ? event.pageCount : 0;
                    }
                    else if (event.type === "error") {
                        rejected = true;
                        reject(new Error(typeof event.message === "string" ? event.message : "Нормализатор сообщил об ошибке."));
                    }
                }
            });
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => {
                for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
                    this.logger.warn(`Docs normalizer stderr: ${line}`);
                }
            });
            child.on("error", (error) => {
                rejected = true;
                reject(error);
            });
            child.on("exit", (code) => {
                if (rejected) {
                    return;
                }
                if (code !== 0) {
                    reject(new Error(`Нормализатор завершился с кодом ${code ?? "unknown"}.`));
                    return;
                }
                resolve({ pageCount: completedPageCount });
            });
        });
    }
}
exports.DocsNormalizerService = DocsNormalizerService;
function validateDocsSourcePath(sourcePath) {
    if (!sourcePath.trim()) {
        return "Укажите путь к исходной документации docs/help/ru.";
    }
    try {
        const stats = fs.statSync(sourcePath);
        if (!stats.isDirectory()) {
            return "Исходная документация должна быть каталогом.";
        }
        if (!fs.existsSync(path.join(sourcePath, "search-index.json"))) {
            return "В исходной документации не найден search-index.json.";
        }
        return "";
    }
    catch {
        return "Каталог исходной документации недоступен.";
    }
}
async function replaceDirectory(outputPath, tempOutput) {
    const backupPath = `${outputPath}.bak-${Date.now()}`;
    const hadOutput = fs.existsSync(outputPath);
    if (hadOutput) {
        await fs.promises.rm(backupPath, { recursive: true, force: true });
        await fs.promises.rename(outputPath, backupPath);
    }
    try {
        await fs.promises.rename(tempOutput, outputPath);
        if (hadOutput) {
            await fs.promises.rm(backupPath, { recursive: true, force: true });
        }
    }
    catch (error) {
        if (hadOutput && fs.existsSync(backupPath) && !fs.existsSync(outputPath)) {
            await fs.promises.rename(backupPath, outputPath).catch(() => undefined);
        }
        throw error;
    }
}
function addParentRoots(roots, startPath) {
    let current = path.resolve(startPath);
    for (let index = 0; index < 10; index += 1) {
        roots.add(current);
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
}
function parseWorkerEvent(line) {
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function clampPercent(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}
//# sourceMappingURL=docsNormalizerService.js.map
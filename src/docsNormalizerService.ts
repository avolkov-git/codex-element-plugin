import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { SettingsService } from "./settingsService";

export interface DocsNormalizerProgress {
  status: "idle" | "running" | "completed" | "error";
  percent: number;
  stage: string;
  message: string;
}

export interface DocsNormalizeOptions {
  sourcePath: string;
  outputPath: string;
  onProgress: (progress: DocsNormalizerProgress) => void;
}

export interface DocsNormalizeResult {
  sourcePath: string;
  outputPath: string;
  pageCount: number;
}

interface WorkerEvent {
  type?: string;
  percent?: number;
  stage?: string;
  message?: string;
  tempOutput?: string;
  pageCount?: number;
}

export class DocsNormalizerService {
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settings: SettingsService,
    private readonly logger: Logger
  ) {}

  getDefaultOutputPath(): string {
    return this.settings.getDefaultDocsNormalizedPath();
  }

  getSavedSourcePath(): string {
    return this.settings.getDocsSettingsView().sourcePath;
  }

  findBundledSourcePath(): string | undefined {
    const saved = this.getSavedSourcePath();
    if (saved && !validateDocsSourcePath(saved)) {
      return path.resolve(saved);
    }

    const roots = new Set<string>();
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

  validateSourcePath(sourcePath: string): string {
    return validateDocsSourcePath(sourcePath);
  }

  async normalize(options: DocsNormalizeOptions): Promise<DocsNormalizeResult> {
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
    } catch (error) {
      await fs.promises.rm(tempOutput, { recursive: true, force: true }).catch(() => undefined);
      options.onProgress({
        status: "error",
        percent: 0,
        stage: "error",
        message: error instanceof Error ? error.message : "Нормализация завершилась ошибкой."
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private runWorker(
    workerPath: string,
    sourcePath: string,
    tempOutput: string,
    outputPath: string,
    onProgress: (progress: DocsNormalizerProgress) => void
  ): Promise<{ pageCount: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
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
      child.stdout.on("data", (chunk: string) => {
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
          } else if (event.type === "complete") {
            completedPageCount = typeof event.pageCount === "number" ? event.pageCount : 0;
          } else if (event.type === "error") {
            rejected = true;
            reject(new Error(typeof event.message === "string" ? event.message : "Нормализатор сообщил об ошибке."));
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
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

function validateDocsSourcePath(sourcePath: string): string {
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
  } catch {
    return "Каталог исходной документации недоступен.";
  }
}

async function replaceDirectory(outputPath: string, tempOutput: string): Promise<void> {
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
  } catch (error) {
    if (hadOutput && fs.existsSync(backupPath) && !fs.existsSync(outputPath)) {
      await fs.promises.rename(backupPath, outputPath).catch(() => undefined);
    }
    throw error;
  }
}

function addParentRoots(roots: Set<string>, startPath: string): void {
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

function parseWorkerEvent(line: string): WorkerEvent | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" ? parsed as WorkerEvent : undefined;
  } catch {
    return undefined;
  }
}

function clampPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

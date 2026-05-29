import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 5;

export class Logger {
  private readonly output = vscode.window.createOutputChannel("Codex");
  private logDirectory: string | undefined;
  private pluginLogPath: string | undefined;
  private runtimeLogPath: string | undefined;
  private writeChain = Promise.resolve();

  enableFileLogging(logDirectory: string): void {
    this.logDirectory = logDirectory;
    this.pluginLogPath = path.join(logDirectory, "plugin.log");
    this.runtimeLogPath = path.join(logDirectory, "runtime.log");
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      this.info(`File logging enabled: ${logDirectory}.`);
    } catch (error) {
      this.warn(`File logging disabled: ${normalizeErrorMessage(error)}.`);
      this.logDirectory = undefined;
      this.pluginLogPath = undefined;
      this.runtimeLogPath = undefined;
    }
  }

  info(message: string): void {
    this.append("info", message);
  }

  warn(message: string): void {
    this.append("warn", message);
  }

  error(message: string): void {
    this.append("error", message);
  }

  runtime(level: "info" | "warn" | "error", message: string): void {
    const line = formatLine(level, message);
    this.output.appendLine(line);
    this.queueFileAppend(this.pluginLogPath, line);
    this.queueFileAppend(this.runtimeLogPath, line);
  }

  show(): void {
    this.output.show();
  }

  async openLogFolder(): Promise<void> {
    const logDirectory = this.logDirectory;
    if (!logDirectory) {
      vscode.window.showWarningMessage("Файловые логи Codex пока не настроены.");
      return;
    }
    await fs.promises.mkdir(logDirectory, { recursive: true });
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(logDirectory));
  }

  async exportLogsToWorkspace(): Promise<string | undefined> {
    const sourceDirectory = this.logDirectory;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!sourceDirectory || !workspaceRoot) {
      return undefined;
    }

    const targetDirectory = path.join(workspaceRoot, ".local-codex", "logs");
    await this.writeChain;
    await fs.promises.mkdir(targetDirectory, { recursive: true });
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    const logFiles = entries
      .filter((entry) => entry.isFile() && /^(plugin|runtime)\.log(\.\d+)?$/.test(entry.name))
      .map((entry) => entry.name);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const fileName of logFiles) {
      await fs.promises.copyFile(
        path.join(sourceDirectory, fileName),
        path.join(targetDirectory, `${stamp}-${fileName}`)
      );
    }
    return targetDirectory;
  }

  dispose(): void {
    this.output.dispose();
  }

  private append(level: "info" | "warn" | "error", message: string): void {
    const line = formatLine(level, message);
    this.output.appendLine(line);
    this.queueFileAppend(this.pluginLogPath, line);
  }

  private queueFileAppend(filePath: string | undefined, line: string): void {
    if (!filePath) {
      return;
    }
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await rotateIfNeeded(filePath);
        await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
      })
      .catch((error) => {
        this.output.appendLine(formatLine("warn", `File log write failed: ${normalizeErrorMessage(error)}.`));
      });
  }
}

export function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(password|token|secret|api[_-]?key)=([^\s&]+)/gi, "$1=***")
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1***:***@");
}

function formatLine(level: "info" | "warn" | "error", message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${redact(message)}`;
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return;
  }
  if (stat.size < MAX_LOG_BYTES) {
    return;
  }

  for (let index = MAX_ROTATED_LOGS - 1; index >= 1; index -= 1) {
    await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
  }
  await renameIfExists(filePath, `${filePath}.1`);
}

async function renameIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(source, target);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";

export interface BaseContextResult {
  text?: string;
  sourcePath: string;
  matchCount: number;
}

export interface BaseContextSettings {
  text: string;
  sourcePath: string;
  revision: string;
}

const BASE_CONTEXT_RELATIVE_PATH = path.join("resources", "context", "codex-element-language-rules.md");
const MAX_BASE_CONTEXT_BYTES = 96 * 1024;
const MAX_BASE_CONTEXT_CHARS = 18_000;

class BaseContextSettingsError extends Error {}

export class BaseContextService {
  private saving = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  async readBaseContext(): Promise<BaseContextSettings> {
    try {
      if (this.saving) throw new BaseContextSettingsError("Сохранение базового контекста еще выполняется. Дождитесь завершения.");
      const { text, sourcePath, revision } = await this.readSettingsState();
      return { text, sourcePath, revision };
    } catch (error) {
      throw baseContextSettingsError(error, "прочитать");
    }
  }

  async saveBaseContext(text: string, revision: string): Promise<string> {
    if (typeof text !== "string" || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new BaseContextSettingsError("Некорректные данные базового контекста. Загрузите его заново перед сохранением.");
    }
    validateBaseContextSize(Buffer.byteLength(text, "utf8"));
    if (this.saving) throw new BaseContextSettingsError("Сохранение базового контекста еще выполняется. Дождитесь завершения.");
    this.saving = true;
    try {
      const current = await this.readSettingsState();
      if (current.revision !== revision) throw baseContextConflict();
      const document = current.document;
      const bomBytes = current.diskText.startsWith("\uFEFF") ? 3 : 0;
      const encodedText = text.replace(/\r\n|\r|\n/g, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
      validateBaseContextSize(Buffer.byteLength(encodedText, "utf8") + bomBytes);
      if (text !== current.text) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(current.text.length)), text);
        if (!await vscode.workspace.applyEdit(edit)) {
          throw new BaseContextSettingsError("Не удалось изменить базовый контекст. Загрузите его заново перед сохранением.");
        }
      }
      const appliedText = document.getText();
      const appliedVersion = document.version;
      if (comparableBaseContext(appliedText) !== comparableBaseContext(text)) throw baseContextConflict();
      validateBaseContextSize(Buffer.byteLength(appliedText, "utf8") + bomBytes);

      // Check disk again after the editor round-trip; never save over a newer file or editor edit.
      const disk = await readBaseContextDisk(current.sourcePath);
      if (disk.revision !== current.diskRevision || document.version !== appliedVersion) throw baseContextConflict();
      if (!await document.save()) {
        throw new BaseContextSettingsError("Не удалось сохранить базовый контекст. Проверьте права доступа к файлу. Изменения остались в редакторе.");
      }
      const saved = await this.readSettingsState();
      if (document.isDirty || document.version !== appliedVersion || saved.text !== appliedText
        || comparableBaseContext(saved.diskText) !== comparableBaseContext(appliedText)) throw baseContextConflict();
      return saved.revision;
    } catch (error) {
      throw baseContextSettingsError(error, "сохранить");
    } finally {
      this.saving = false;
    }
  }

  private async readSettingsState(): Promise<BaseContextSettings & {
    document: vscode.TextDocument; diskRevision: string; diskText: string;
  }> {
    const sourcePath = this.resolveBaseContextPath();
    const before = await readBaseContextDisk(sourcePath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    const disk = await readBaseContextDisk(sourcePath);
    const text = document.getText();
    validateBaseContextSize(Buffer.byteLength(text, "utf8"));
    if (before.revision !== disk.revision
      || (!document.isDirty && comparableBaseContext(text) !== comparableBaseContext(disk.text))) throw baseContextConflict();
    return {
      text, sourcePath, document, diskRevision: disk.revision, diskText: disk.text,
      revision: createHash("sha256").update(JSON.stringify([disk.revision, document.version, text])).digest("hex")
    };
  }

  async buildContext(): Promise<BaseContextResult> {
    const sourcePath = this.resolveBaseContextPath();
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (stat.size > MAX_BASE_CONTEXT_BYTES) {
        this.logger.warn(`Base context skipped: file is too large: ${Math.round(stat.size / 1024)}KB.`);
        return { sourcePath, matchCount: 0 };
      }

      const raw = await fs.promises.readFile(sourcePath, "utf8");
      const rules = raw.trim();
      if (!rules) {
        this.logger.warn("Base context skipped: bundled rules file is empty.");
        return { sourcePath, matchCount: 0 };
      }

      this.logger.info("Base context added: bundled language rules.");
      return {
        sourcePath,
        text: formatBaseContext(sourcePath, rules),
        matchCount: 1
      };
    } catch {
      this.logger.warn("Base context skipped: rules file could not be read.");
      return { sourcePath, matchCount: 0 };
    }
  }

  async openBaseContextFile(): Promise<string | undefined> {
    const sourcePath = this.resolveBaseContextPath();
    try {
      await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
      if (!fs.existsSync(sourcePath)) {
        try {
          await fs.promises.writeFile(sourcePath, DEFAULT_BASE_CONTEXT_TEMPLATE, { encoding: "utf8", flag: "wx" });
          this.logger.warn("Base context file recreated from fallback template.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      return sourcePath;
    } catch (error) {
      const message = baseContextSettingsError(error, "открыть").message;
      this.logger.warn("Base context open failed.");
      vscode.window.showWarningMessage(message);
      return undefined;
    }
  }

  private resolveBaseContextPath(): string {
    return path.join(this.context.extensionUri.fsPath, BASE_CONTEXT_RELATIVE_PATH);
  }
}

function validateBaseContextSize(bytes: number): void {
  if (bytes > MAX_BASE_CONTEXT_BYTES) throw new BaseContextSettingsError("Базовый контекст не должен превышать 96 КБ в UTF-8.");
}

function baseContextConflict(): BaseContextSettingsError {
  return new BaseContextSettingsError("Базовый контекст изменился после загрузки в файле или редакторе. Загрузите его заново перед сохранением.");
}

function baseContextSettingsError(error: unknown, action: string): Error {
  if (error instanceof BaseContextSettingsError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "NoPermissions") {
    return new Error(`Недостаточно прав, чтобы ${action} базовый контекст. Проверьте права доступа к файлу.`);
  }
  if (code === "ENOENT" || code === "FileNotFound") {
    return new Error("Файл базового контекста не найден. Откройте базовый контекст в редакторе, чтобы восстановить файл.");
  }
  return new Error(`Не удалось ${action} базовый контекст. Проверьте доступность файла и повторите действие.`);
}

function comparableBaseContext(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
}

function baseContextFileStamp(stats: fs.Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

async function readBaseContextDisk(sourcePath: string): Promise<{ text: string; revision: string }> {
  const file = await fs.promises.open(sourcePath, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new BaseContextSettingsError("Базовый контекст должен быть обычным текстовым файлом.");
    validateBaseContextSize(before.size);
    const buffer = Buffer.alloc(MAX_BASE_CONTEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    validateBaseContextSize(length);
    const stamp = baseContextFileStamp(before);
    if (stamp !== baseContextFileStamp(await file.stat()) || stamp !== baseContextFileStamp(await fs.promises.stat(sourcePath))) {
      throw baseContextConflict();
    }
    const content = buffer.subarray(0, length);
    return { text: content.toString("utf8"), revision: createHash("sha256").update(stamp).update(content).digest("hex") };
  } finally {
    await file.close();
  }
}

function formatBaseContext(sourcePath: string, rules: string): string {
  return [
    "[Базовые правила Codex Element]",
    `Источник: ${sourcePath}`,
    "Это обязательные правила разработки для проектного чата Codex Element.",
    "Соблюдай их при генерации и правке кода 1C: Element, YAML и XBSL.",
    "Не сообщай пользователю, что базовые правила были добавлены в контекст, если он прямо не спрашивает.",
    "",
    trimText(rules, MAX_BASE_CONTEXT_CHARS)
  ].join("\n");
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

const DEFAULT_BASE_CONTEXT_TEMPLATE = [
  "# Базовый контекст Codex Element",
  "",
  "Опишите обязательные правила разработки для проектных чатов Codex Element.",
  ""
].join("\n");

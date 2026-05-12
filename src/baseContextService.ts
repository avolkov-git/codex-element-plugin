import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";

export interface BaseContextResult {
  text?: string;
  sourcePath: string;
  matchCount: number;
}

const BASE_CONTEXT_RELATIVE_PATH = path.join("resources", "context", "codex-element-language-rules.md");
const MAX_BASE_CONTEXT_BYTES = 96 * 1024;
const MAX_BASE_CONTEXT_CHARS = 18_000;

export class BaseContextService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Base context skipped: ${message}.`);
      return { sourcePath, matchCount: 0 };
    }
  }

  async openBaseContextFile(): Promise<string | undefined> {
    const sourcePath = this.resolveBaseContextPath();
    try {
      await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
      if (!fs.existsSync(sourcePath)) {
        await fs.promises.writeFile(sourcePath, DEFAULT_BASE_CONTEXT_TEMPLATE, "utf8");
        this.logger.warn(`Base context file recreated from fallback template: ${sourcePath}.`);
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      return sourcePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось открыть базовый контекст.";
      this.logger.warn(`Base context open failed: ${message}`);
      vscode.window.showWarningMessage(message);
      return undefined;
    }
  }

  private resolveBaseContextPath(): string {
    return path.join(this.context.extensionUri.fsPath, BASE_CONTEXT_RELATIVE_PATH);
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

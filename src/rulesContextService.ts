import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatKind, SidebarSnapshot } from "./types";

export interface RulesContextResult {
  text?: string;
  sourcePath?: string;
  matchCount: number;
  status: SidebarSnapshot["rulesContext"];
}

const RULES_RELATIVE_PATH = path.join(".local-codex", "rules.md");
const MAX_RULES_BYTES = 64 * 1024;
const MAX_RULES_CONTEXT_CHARS = 12_000;

const DEFAULT_RULES_TEMPLATE = [
  "# Правила проекта для Codex",
  "",
  "Опишите здесь постоянные правила проекта:",
  "",
  "- стиль кода;",
  "- архитектурные соглашения;",
  "- запреты и ограничения;",
  "- команды проверки.",
  ""
].join("\n");

export class RulesContextService {
  constructor(
    private readonly logger: Logger
  ) {}

  getStatus(chatKind: ChatKind, rulesEnabled: boolean): SidebarSnapshot["rulesContext"] {
    if (chatKind !== "project") {
      return { status: "disabled", label: "Обычный чат не использует правила проекта" };
    }
    if (!rulesEnabled) {
      return { status: "disabled", label: "Правила проекта выключены для этого чата" };
    }

    const rulesPath = this.resolveRulesPath();
    if (!rulesPath) {
      return { status: "missing", label: "Workspace не найден, правила проекта недоступны" };
    }
    if (!fs.existsSync(rulesPath)) {
      return { status: "missing", label: "Файл .local-codex/rules.md не найден" };
    }
    return { status: "active", label: "Правила проекта активны" };
  }

  async buildContext(chatKind: ChatKind, rulesEnabled: boolean): Promise<RulesContextResult> {
    const status = this.getStatus(chatKind, rulesEnabled);
    if (status.status !== "active") {
      this.logger.info(`Rules context skipped: ${status.label}.`);
      return { matchCount: 0, status };
    }

    const rulesPath = this.resolveRulesPath();
    if (!rulesPath) {
      return {
        matchCount: 0,
        status: { status: "missing", label: "Workspace не найден, правила проекта недоступны" }
      };
    }

    try {
      const stat = await fs.promises.stat(rulesPath);
      if (stat.size > MAX_RULES_BYTES) {
        const message = `Файл правил слишком большой: ${Math.round(stat.size / 1024)}KB.`;
        this.logger.warn(`Rules context skipped: ${message}`);
        return {
          sourcePath: rulesPath,
          matchCount: 0,
          status: { status: "error", label: "Правила проекта слишком большие" }
        };
      }

      const raw = await fs.promises.readFile(rulesPath, "utf8");
      const rules = raw.trim();
      if (!rules) {
        this.logger.info("Rules context skipped: rules file is empty.");
        return {
          sourcePath: rulesPath,
          matchCount: 0,
          status: { status: "missing", label: "Файл правил пуст" }
        };
      }

      const text = formatRulesContext(rulesPath, rules);
      this.logger.info(`Rules context added: ${rulesPath}.`);
      return {
        text,
        sourcePath: rulesPath,
        matchCount: 1,
        status: { status: "active", label: "Правила проекта активны" }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Rules context skipped: ${message}.`);
      return {
        sourcePath: rulesPath,
        matchCount: 0,
        status: { status: "error", label: "Правила проекта недоступны" }
      };
    }
  }

  async openRulesFile(): Promise<string | undefined> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showWarningMessage("Workspace не найден. Невозможно создать правила проекта.");
      return undefined;
    }

    const rulesPath = path.join(workspaceRoot, RULES_RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(rulesPath), { recursive: true });
    if (!fs.existsSync(rulesPath)) {
      await fs.promises.writeFile(rulesPath, DEFAULT_RULES_TEMPLATE, "utf8");
      this.logger.info(`Project rules file created: ${rulesPath}.`);
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rulesPath));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    return rulesPath;
  }

  private resolveRulesPath(): string | undefined {
    const workspaceRoot = getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, RULES_RELATIVE_PATH) : undefined;
  }
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function formatRulesContext(sourcePath: string, rules: string): string {
  const trimmed = trimText(rules, MAX_RULES_CONTEXT_CHARS);
  return [
    "[Правила проекта]",
    `Источник: ${sourcePath}`,
    "Соблюдай эти правила при ответах по проектному чату.",
    "Не сообщай пользователю, что правила были добавлены в контекст, если он прямо не спрашивает.",
    "",
    trimmed
  ].join("\n");
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatKind, SidebarSnapshot } from "./types";
import { isMissingRulesFile, loadScopedRules, RulesTarget, RulesWorkspace, SCOPED_RULES_LIMITS } from "./scopedProjectRules";

export type { RulesTarget } from "./scopedProjectRules";

export interface RulesContextResult {
  text?: string;
  sourcePath?: string;
  matchCount: number;
  status: SidebarSnapshot["rulesContext"];
  /** Optional rules are separate: never charge them to the mandatory/base rules budget. */
  scopedText?: string;
  scopedMatchCount?: number;
  /** Workspace-relative paths of included scoped rules. matchCount still counts only rules.md. */
  scopedPaths?: string[];
  warnings?: string[];
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

  async buildContext(chatKind: ChatKind, rulesEnabled: boolean, targets: readonly RulesTarget[] = []): Promise<RulesContextResult> {
    if (chatKind !== "project" || !rulesEnabled) {
      const status = this.getStatus(chatKind, rulesEnabled);
      this.logger.info(`Rules context skipped: ${status.label}.`);
      return { matchCount: 0, status };
    }
    const root = getWorkspaceRoot();
    if (!root) {
      return {
        matchCount: 0,
        status: { status: "missing", label: "Workspace не найден, правила проекта недоступны" }
      };
    }

    // Snapshot caller-owned input and observe even an A -> B -> A workspace switch.
    const selected = targets.slice(0, SCOPED_RULES_LIMITS.targets).map(target => ({ path: target.path, elementKind: target.elementKind }));
    let changed = false;
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders?.(() => { changed = true; });
    const assertCurrent = () => {
      if (changed || getWorkspaceRoot() !== root) throw new Error("Workspace изменился во время чтения правил. Повторите запрос.");
    };
    const rulesPath = path.join(root, RULES_RELATIVE_PATH);
    const result: RulesContextResult = {
      sourcePath: rulesPath, matchCount: 0, scopedMatchCount: 0, scopedPaths: [],
      status: { status: "missing", label: "Файл .local-codex/rules.md не найден" },
    };
    const warnings: string[] = [];
    try {
      const workspace = await RulesWorkspace.create(root, assertCurrent);
      try {
        const rules = (await workspace.read(RULES_RELATIVE_PATH, MAX_RULES_BYTES)).trim();
        if (rules) {
          result.text = formatRulesContext(rulesPath, rules);
          result.matchCount = 1;
          if (rules.replace(/\r\n/g, "\n").length > MAX_RULES_CONTEXT_CHARS) {
            warnings.push("Контекст .local-codex/rules.md усечен: прежний лимит 12000 символов.");
          }
        } else {
          result.status = { status: "missing", label: "Файл правил пуст" };
        }
      } catch (error) {
        if (!isMissingRulesFile(error)) {
          warnings.push(`.local-codex/rules.md: ${error instanceof Error ? error.message : "правила недоступны"}`);
          result.status = { status: "error", label: "Общепроектные правила недоступны" };
        }
      }
      assertCurrent();
      const scoped = await loadScopedRules(workspace, selected);
      result.scopedText = scoped.scopedText;
      result.scopedMatchCount = scoped.scopedMatchCount;
      result.scopedPaths = scoped.scopedPaths;
      warnings.push(...scoped.warnings);
      if (targets.length > SCOPED_RULES_LIMITS.targets) warnings.push("Подбор целей усечен: использованы первые 64 цели.");
      if (result.text) {
        try { await workspace.validateRead(RULES_RELATIVE_PATH); }
        catch {
          delete result.text;
          result.matchCount = 0;
          warnings.push("Общепроектные правила изменились во время сборки контекста и не добавлены. Повторите запрос.");
        }
      }
      await workspace.checkCurrent();
      if (result.text || result.scopedText) {
        result.status = { status: "active", label: warnings.length ? "Правила проекта активны с предупреждениями" : "Правила проекта активны" };
      } else if (warnings.length) {
        result.status = { status: "error", label: "Правила проекта не добавлены; проверьте предупреждения" };
      }
      if (warnings.length) {
        result.warnings = warnings;
        this.logger.warn(`Rules context warnings: ${warnings.join(" ")}`);
      }
      return result;
    } catch (error) {
      const warning = error instanceof Error ? error.message : "Правила проекта недоступны. Повторите запрос.";
      this.logger.warn(`Rules context skipped: ${warning}`);
      // Never return a partial result belonging to a workspace that is no longer current.
      return { matchCount: 0, status: { status: "error", label: "Правила проекта недоступны" }, warnings: [warning] };
    } finally { subscription?.dispose(); }
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

import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ContextBlock } from "./contextRouterService";
import { Logger } from "./logger";

export interface DiagnosticsContextResult {
  readonly block?: ContextBlock;
  readonly filesCount: number;
  readonly errorsCount: number;
  readonly totalErrorsCount: number;
  readonly omittedErrorsCount: number;
  readonly fingerprint: string;
  readonly reason: "added" | "no-workspace" | "no-errors";
}

interface WorkspaceRoot {
  readonly fsPath: string;
  readonly comparePath: string;
}

interface DiagnosticEntry {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly source: string;
  readonly code: string;
  readonly message: string;
  readonly key: string;
  readonly activeFile: boolean;
}

const MAX_ERRORS = 40;
const MAX_FILES = 25;
const MAX_MESSAGE_CHARS = 500;

export class DiagnosticsContextService {
  constructor(private readonly logger: Logger) {}

  async buildContext(options: {
    readonly prompt: string;
    readonly force?: boolean;
    readonly priority?: number;
  }): Promise<DiagnosticsContextResult> {
    const result = await this.collectErrorContext(options.priority);
    if (!result.block) {
      this.logger.info(`Diagnostics context skipped: reason=${result.reason}; errors=${result.totalErrorsCount}.`);
      return result;
    }

    this.logger.info(
      `Diagnostics context added: files=${result.filesCount}; errors=${result.errorsCount}; ` +
      `totalErrors=${result.totalErrorsCount}; omitted=${result.omittedErrorsCount}; fingerprint=${result.fingerprint}.`
    );
    return result;
  }

  async collectErrorContext(priority = 90): Promise<DiagnosticsContextResult> {
    const roots = getWorkspaceRoots();
    if (!roots.length) {
      return {
        filesCount: 0,
        errorsCount: 0,
        totalErrorsCount: 0,
        omittedErrorsCount: 0,
        fingerprint: "",
        reason: "no-workspace"
      };
    }

    const activeFile = getActiveFilePath();
    const entries = collectDiagnostics(roots, activeFile);
    if (!entries.length) {
      return {
        filesCount: 0,
        errorsCount: 0,
        totalErrorsCount: 0,
        omittedErrorsCount: 0,
        fingerprint: "",
        reason: "no-errors"
      };
    }

    const selected = selectEntries(entries);
    const fingerprint = hashEntries(entries);
    const selectedFiles = new Set(selected.map((entry) => entry.relativePath));
    const text = formatDiagnostics(selected, entries.length, selected.length);

    return {
      block: {
        source: "diagnostics",
        text,
        matchCount: selected.length,
        mode: "matched",
        score: 100,
        priority,
        tokensEstimate: Math.ceil(text.length / 4),
        metadata: {
          filesCount: selectedFiles.size,
          errorsCount: selected.length,
          totalErrorsCount: entries.length,
          omittedErrorsCount: Math.max(0, entries.length - selected.length),
          fingerprint
        }
      },
      filesCount: selectedFiles.size,
      errorsCount: selected.length,
      totalErrorsCount: entries.length,
      omittedErrorsCount: Math.max(0, entries.length - selected.length),
      fingerprint,
      reason: "added"
    };
  }

  isDiagnosticsRelevantPrompt(prompt: string): boolean {
    const normalized = normalizePrompt(prompt);
    return /(?:ошибк|диагностик|diagnostic|error|исправ|почини|fix|repair|build|сборк|компиляц|typescript|tsc|lint|проверк|проверить|не\s+собира|не\s+компилир)/u.test(normalized);
  }

  isHighPriorityPrompt(prompt: string): boolean {
    const normalized = normalizePrompt(prompt);
    return /(?:ошибк|диагностик|diagnostic|error|исправ|почини|fix|repair|не\s+собира|не\s+компилир|падает\s+сборк)/u.test(normalized);
  }
}

function getWorkspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({
      fsPath: path.resolve(folder.uri.fsPath),
      comparePath: normalizeForCompare(path.resolve(folder.uri.fsPath))
    }));
}

function getActiveFilePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? normalizeForCompare(path.resolve(uri.fsPath)) : undefined;
}

function collectDiagnostics(roots: readonly WorkspaceRoot[], activeFile: string | undefined): DiagnosticEntry[] {
  const seen = new Set<string>();
  const entries: DiagnosticEntry[] = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") {
      continue;
    }

    const filePath = path.resolve(uri.fsPath);
    const relativePath = getWorkspaceRelativePath(filePath, roots);
    if (!relativePath) {
      continue;
    }

    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) {
        continue;
      }

      const line = diagnostic.range.start.line + 1;
      const column = diagnostic.range.start.character + 1;
      const source = cleanInline(diagnostic.source || "IDE");
      const code = normalizeDiagnosticCode(diagnostic.code);
      const message = truncate(cleanInline(diagnostic.message), MAX_MESSAGE_CHARS);
      const key = [
        relativePath,
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character,
        source,
        code,
        message
      ].join("\u0000");

      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({
        relativePath,
        line,
        column,
        source,
        code,
        message,
        key,
        activeFile: normalizeForCompare(filePath) === activeFile
      });
    }
  }

  return entries.sort((left, right) =>
    Number(right.activeFile) - Number(left.activeFile)
    || left.relativePath.localeCompare(right.relativePath)
    || left.line - right.line
    || left.column - right.column
    || left.message.localeCompare(right.message)
  );
}

function selectEntries(entries: readonly DiagnosticEntry[]): DiagnosticEntry[] {
  const selected: DiagnosticEntry[] = [];
  const files = new Set<string>();

  for (const entry of entries) {
    if (!files.has(entry.relativePath) && files.size >= MAX_FILES) {
      continue;
    }
    if (selected.length >= MAX_ERRORS) {
      break;
    }
    files.add(entry.relativePath);
    selected.push(entry);
  }

  return selected;
}

function formatDiagnostics(entries: readonly DiagnosticEntry[], totalErrors: number, selectedErrors: number): string {
  const lines = [
    "IDE diagnostics: только ошибки текущего workspace.",
    "Предупреждения, info и hints намеренно исключены.",
    "Исправляй только ошибки IDE, если запрос связан с кодом или проектом.",
    "Не упоминай diagnostics пользователю, если он прямо не спрашивает.",
    "",
    "Ошибки:"
  ];

  for (const entry of entries) {
    const code = entry.code ? ` ${entry.code}` : "";
    lines.push(`- ${entry.relativePath}:${entry.line}:${entry.column} [${entry.source}${code}] ${entry.message}`);
  }

  if (totalErrors > selectedErrors) {
    lines.push(`- ... еще ${totalErrors - selectedErrors} ошибок не добавлено из-за лимита контекста.`);
  }

  return lines.join("\n");
}

function getWorkspaceRelativePath(filePath: string, roots: readonly WorkspaceRoot[]): string | undefined {
  const comparePath = normalizeForCompare(filePath);
  let best: { root: WorkspaceRoot; relative: string } | undefined;

  for (const root of roots) {
    if (comparePath !== root.comparePath && !comparePath.startsWith(`${root.comparePath}${path.sep}`)) {
      continue;
    }
    const relative = path.relative(root.fsPath, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    if (!best || root.fsPath.length > best.root.fsPath.length) {
      best = { root, relative };
    }
  }

  return best ? toPosix(best.relative) : undefined;
}

function normalizeDiagnosticCode(code: vscode.Diagnostic["code"]): string {
  if (typeof code === "number" || typeof code === "string") {
    return String(code);
  }
  if (code && typeof code === "object" && "value" in code) {
    return String(code.value);
  }
  return "";
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function normalizePrompt(prompt: string): string {
  return prompt.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function hashEntries(entries: readonly DiagnosticEntry[]): string {
  const hash = crypto.createHash("sha1");
  for (const entry of entries) {
    hash.update(entry.key);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

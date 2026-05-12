import * as path from "path";
import * as vscode from "vscode";
import { ContextBlock } from "./contextRouterService";

export type EditorContextKind = "file" | "selection";

export interface EditorContextRequest {
  readonly visiblePrompt: string;
  readonly userPrompt: string;
  readonly contextBlock: ContextBlock;
  readonly relativePath: string;
  readonly byteLength: number;
}

const MAX_EDITOR_CONTEXT_BYTES = 200 * 1024;

export class EditorContextService {
  async buildRequest(kind: EditorContextKind): Promise<EditorContextRequest | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Откройте файл в редакторе.");
      return undefined;
    }

    const document = editor.document;
    if (document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("Codex может объяснять только файлы из файловой системы workspace.");
      return undefined;
    }

    return kind === "file"
      ? this.buildFileRequest(document)
      : this.buildSelectionRequest(editor);
  }

  private buildFileRequest(document: vscode.TextDocument): EditorContextRequest | undefined {
    const text = document.getText();
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > MAX_EDITOR_CONTEXT_BYTES) {
      vscode.window.showWarningMessage(`Файл слишком большой для отправки в контекст Codex. Лимит: ${formatBytes(MAX_EDITOR_CONTEXT_BYTES)}.`);
      return undefined;
    }

    const relativePath = getRelativePath(document.uri);
    const userPrompt = `Объясни файл ${relativePath}.`;
    return {
      visiblePrompt: userPrompt,
      userPrompt,
      relativePath,
      byteLength,
      contextBlock: {
        source: "editorFile",
        text: [
          `Файл: ${relativePath}`,
          `Язык: ${document.languageId || languageFromPath(relativePath)}`,
          `Размер: ${byteLength} bytes`,
          "",
          "Содержимое файла:",
          "```",
          text,
          "```"
        ].join("\n"),
        matchCount: 1,
        mode: "matched"
      }
    };
  }

  private buildSelectionRequest(editor: vscode.TextEditor): EditorContextRequest | undefined {
    const selection = editor.selections.find((candidate) => !candidate.isEmpty);
    if (!selection) {
      vscode.window.showWarningMessage("Выделите фрагмент файла.");
      return undefined;
    }

    const document = editor.document;
    const text = document.getText(selection);
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > MAX_EDITOR_CONTEXT_BYTES) {
      vscode.window.showWarningMessage(`Выделенный фрагмент слишком большой для отправки в контекст Codex. Лимит: ${formatBytes(MAX_EDITOR_CONTEXT_BYTES)}.`);
      return undefined;
    }

    const relativePath = getRelativePath(document.uri);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const location = `${relativePath}:${startLine}-${endLine}`;
    const userPrompt = `Объясни выделенный фрагмент ${location}.`;
    return {
      visiblePrompt: userPrompt,
      userPrompt,
      relativePath,
      byteLength,
      contextBlock: {
        source: "editorSelection",
        text: [
          `Файл: ${relativePath}`,
          `Диапазон: ${startLine}-${endLine}`,
          `Язык: ${document.languageId || languageFromPath(relativePath)}`,
          `Размер: ${byteLength} bytes`,
          "",
          "Выделенный фрагмент:",
          "```",
          text,
          "```"
        ].join("\n"),
        matchCount: 1,
        mode: "matched"
      }
    };
  }
}

function getRelativePath(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return relative && relative !== uri.fsPath ? toPosix(relative) : path.basename(uri.fsPath);
}

function languageFromPath(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, "");
  return ext || "text";
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

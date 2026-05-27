import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatDiffFileSummary, ChatDiffTranscriptItem } from "./types";

const BEFORE_SCHEME = "codex-diff-before";
const AFTER_SCHEME = "codex-diff-after";
const MAX_VIRTUAL_DIFF_CHARS = 2_000_000;

interface DiffArtifact {
  beforeText: string;
  afterText: string;
}

export class DiffArtifactService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly artifacts = new Map<string, DiffArtifact>();
  private readonly disposables: vscode.Disposable[];
  private sequence = 0;

  constructor(private readonly logger: Logger) {
    this.disposables = [
      vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, this)
    ];
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const artifact = this.artifacts.get(getArtifactId(uri));
    if (!artifact) {
      return "";
    }
    return uri.scheme === BEFORE_SCHEME ? artifact.beforeText : artifact.afterText;
  }

  async openDiff(item: ChatDiffTranscriptItem, file: ChatDiffFileSummary): Promise<void> {
    const artifact = buildArtifact(file);
    if (!artifact) {
      vscode.window.showWarningMessage("Diff недоступен для открытия в редакторе.");
      return;
    }

    const id = `${Date.now()}-${this.sequence++}`;
    this.artifacts.set(id, artifact);
    const fileName = sanitizeFileName(file.path || "changes.patch");
    const beforeUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${id}/${fileName}` });
    const afterUri = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${id}/${fileName}` });
    const title = `${file.path || item.title || "Изменения"} — Codex`;

    this.logger.info(`Opening native diff editor: diff=${item.id}; file=${file.path || "<unknown>"}.`);
    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, { preview: false });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.artifacts.clear();
  }
}

function buildArtifact(file: ChatDiffFileSummary): DiffArtifact | undefined {
  const diff = typeof file.diff === "string" ? file.diff : "";
  if (!diff.trim() || diff.length > MAX_VIRTUAL_DIFF_CHARS) {
    return undefined;
  }

  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  let sawContent = false;

  for (const line of diff.split(/\r?\n/)) {
    if (isMetadataLine(line)) {
      continue;
    }
    if (line.startsWith("@@")) {
      beforeLines.push(line);
      afterLines.push(line);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      afterLines.push(line.slice(1));
      sawContent = true;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      beforeLines.push(line.slice(1));
      sawContent = true;
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      beforeLines.push(text);
      afterLines.push(text);
      sawContent = true;
      continue;
    }
    if (line.trim() && !line.startsWith("\\")) {
      beforeLines.push(line);
      afterLines.push(line);
    }
  }

  if (!sawContent) {
    return undefined;
  }
  return {
    beforeText: beforeLines.join("\n"),
    afterText: afterLines.join("\n")
  };
}

function isMetadataLine(line: string): boolean {
  return (
    line.startsWith("diff --git ")
    || line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("new file mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ")
    || line.startsWith("similarity index ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
  );
}

function getArtifactId(uri: vscode.Uri): string {
  return uri.path.split("/").filter(Boolean)[0] ?? "";
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value.replace(/\\/g, "/")) || "changes.patch";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

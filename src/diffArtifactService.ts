import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ChatDiffFileSummary, ChatDiffTranscriptItem } from "./types";
import { opaqueId } from "./featureSafety";

const BEFORE_SCHEME = "codex-diff-before";
const AFTER_SCHEME = "codex-diff-after";
const PATCH_SCHEME = "codex-diff-patch";
const MAX_VIRTUAL_DIFF_CHARS = 2_000_000;
const MAX_CACHE_CHARS = 8_000_000;

export interface FullDiffSnapshot {
  path: string;
  beforeText: string;
  afterText: string;
  beforeLabel?: string;
  afterLabel?: string;
  revision?: string;
}

export interface OpenedDiffSnapshot { beforeUri: vscode.Uri; afterUri: vscode.Uri }
export type DiffSnapshotResolver = (item: ChatDiffTranscriptItem, file: ChatDiffFileSummary) => Promise<FullDiffSnapshot | undefined>;

interface DiffArtifact {
  beforeText: string;
  afterText: string;
  patch?: string;
}

export class DiffArtifactService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly artifacts = new Map<string, DiffArtifact>();
  private readonly disposables: vscode.Disposable[];
  private chars = 0;

  constructor(private readonly logger: Logger, private readonly resolveSnapshot?: DiffSnapshotResolver) {
    this.disposables = [BEFORE_SCHEME, AFTER_SCHEME, PATCH_SCHEME].map((scheme) => vscode.workspace.registerTextDocumentContentProvider(scheme, this));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const artifact = this.artifacts.get(uri.path.split("/").filter(Boolean)[0] ?? "");
    if (!artifact) {
      return "This review snapshot has expired. Reopen the review to obtain a current snapshot.";
    }
    return uri.scheme === PATCH_SCHEME ? artifact.patch ?? "" : uri.scheme === BEFORE_SCHEME ? artifact.beforeText : artifact.afterText;
  }

  async openSnapshots(snapshot: FullDiffSnapshot): Promise<OpenedDiffSnapshot> {
    if (snapshot.beforeText.length + snapshot.afterText.length > MAX_VIRTUAL_DIFF_CHARS) throw new Error("Full review exceeds the native snapshot limit.");
    const id = this.store({ beforeText: snapshot.beforeText, afterText: snapshot.afterText });
    const fileName = sanitizeFileName(snapshot.path);
    const beforeUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${id}/${fileName}` });
    const afterUri = vscode.Uri.from({ scheme: AFTER_SCHEME, path: `/${id}/${fileName}` });
    const title = `${snapshot.path} (${snapshot.beforeLabel ?? "Before"} -> ${snapshot.afterLabel ?? "After"}) - Codex`;
    await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, title, { preview: false });
    return { beforeUri, afterUri };
  }

  async openDiff(item: ChatDiffTranscriptItem, file: ChatDiffFileSummary): Promise<void> {
    const full = await this.resolveSnapshot?.(item, file);
    if (full) { await this.openSnapshots(full); return; }
    const patch = file.diff;
    if (!patch?.trim() || patch.length > MAX_VIRTUAL_DIFF_CHARS) {
      await vscode.window.showWarningMessage("The recorded patch is unavailable or exceeds the preview limit.");
      return;
    }
    // Hunk fragments cannot establish either full file revision. Keep them as a patch.
    const id = this.store({ beforeText: "", afterText: "", patch: `# Recorded patch fragment; not full-file revisions${file.truncated ? " (truncated)" : ""}.\n${patch}` });
    const uri = vscode.Uri.from({ scheme: PATCH_SCHEME, path: `/${id}/${sanitizeFileName(file.path)}.patch` });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    this.logger.info("Opened recorded patch fragment; full revisions were not available.");
  }

  clear(): void { this.artifacts.clear(); this.chars = 0; }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.clear();
  }

  private store(artifact: DiffArtifact): string {
    const id = opaqueId();
    this.artifacts.set(id, artifact);
    this.chars += artifact.beforeText.length + artifact.afterText.length + (artifact.patch?.length ?? 0);
    while (this.chars > MAX_CACHE_CHARS || this.artifacts.size > 32) {
      const oldest = this.artifacts.keys().next().value as string;
      const entry = this.artifacts.get(oldest)!;
      this.chars -= entry.beforeText.length + entry.afterText.length + (entry.patch?.length ?? 0);
      this.artifacts.delete(oldest);
    }
    return id;
  }
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value.replace(/\\/g, "/")) || "changes.patch";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DiffArtifactService } from "./diffArtifactService";
import { BrowserArtifactItem, BrowserArtifactPreview, FeatureBrowserArtifacts } from "./featureBrowserArtifacts";
import { captureReview, isDirty, listReviewPaths, mutateReview, ReviewRevision } from "./featureGitReview";
import { contained, deadline, digest, FeatureError, opaqueId, redactPreview } from "./featureSafety";

const LSP_REQUEST = "com.e1c.g5rt.lsp.request";
const OPEN_APPLICATION = "g5rt.commands.applicationMenu.openApplication";
// Verified in Element 9.2.4-6 NavigatorProtocolConstants / NavigatorServiceInvokeHelper.
const READINESS_METHOD = "navigator/uiClientApplications";
const MAX_PREVIEW_CHARS = 24_000;
const MAX_REVIEW_CACHE_BYTES = 16 * 1024 * 1024;
const REVIEW_TTL_MS = 15 * 60_000;

export interface ReviewCommentContext { reviewId: string; revision: string; path: string; line: number }

export interface PluginFeatureServiceOptions {
  getWorkspaceRoot: (chatId: string) => string | undefined;
  /** Must return a namespace derived from verified IDE user/project identity, never a UI profile name. */
  getScopeRoot: () => string | undefined;
  /** Dedicated artifacts directory for the current browser session, inside getScopeRoot(). */
  getBrowserArtifactsRoot?: () => string | undefined;
  diffArtifacts?: DiffArtifactService;
  onReviewComment?: (chatId: string, text: string, context: ReviewCommentContext) => Promise<void>;
  isProjectReady?: () => Promise<boolean>;
  commandTimeoutMs?: number;
}

export type FeatureStatus = "ready" | "opened" | "completed" | "dispatched" | "blocked" | "conflict" | "unsupported" | "timeout" | "error";
export interface FeatureResultBase { ok: boolean; command: string; status: FeatureStatus; message?: string }
export interface FeatureSuccess extends FeatureResultBase { ok: true }
export interface FeatureFailure extends FeatureResultBase {
  ok: false;
  status: "blocked" | "conflict" | "unsupported" | "timeout" | "error";
  error: { category: "needs-attention" | "stale-revision" | "not-supported" | "deadline-exceeded" | "operation-failed"; message: string; retryable: boolean };
}
export interface FeatureCapability { available: boolean; reason?: string }
export interface ReviewListItem {
  id: string;
  path: string;
  layer: "worktree" | "index";
  change: "added" | "modified" | "deleted" | "unavailable";
  revision: string;
  canOpen: boolean;
  canStage: boolean;
  canRevert: boolean;
  reason?: string;
}
export interface ReviewSide {
  text: string;
  hash: string;
  exists: boolean;
  bytes: number;
  lineCount: number;
  previewTruncated: boolean;
  label: string;
}
export interface ReviewComment {
  id: string;
  line: number;
  text: string;
  revision: string;
  native: boolean;
  sentToChat: boolean;
  sendingToChat?: boolean;
}
export interface ReviewDetail extends ReviewListItem {
  full: true;
  source: "git-and-disk";
  before: ReviewSide;
  after: ReviewSide;
  comments: ReviewComment[];
}
export interface ReviewListResult extends FeatureSuccess { command: "review.list"; items: ReviewListItem[]; truncated: boolean; nextOffset?: number; capabilities: { nativeDiff: FeatureCapability; nativeComments: FeatureCapability } }
export interface ReviewOpenResult extends FeatureSuccess { command: "review.open"; review: ReviewDetail; opened: boolean }
export interface ReviewActionResult extends FeatureSuccess { command: "review.stage" | "review.revert"; id: string; revision: string; refreshRequired: true; recoveryId?: string }
export interface ReviewCommentResult extends FeatureSuccess { command: "review.comment"; comment: ReviewComment; followUp: string }
export interface ProjectActionItem { id: "openApplication" | "diagnostics" | "rebuild" | "worktree"; label: string; available: boolean; reason?: string }
export interface ProjectActionsResult extends FeatureSuccess { command: "project.actions"; items: ProjectActionItem[]; capabilities: { terminal: FeatureCapability; worktrees: FeatureCapability } }
export interface ProjectActionResult extends FeatureSuccess {
  command: "project.action.run";
  id: string;
  diagnostics?: { errors: number; warnings: number; total: number; truncated: boolean; freshness: "current-IDE-cache"; buildRequested: false; items: { path: string; line: number; severity: string; message: string }[] };
}
export interface BrowserArtifactsListResult extends FeatureSuccess { command: "browser.artifacts.list"; items: BrowserArtifactItem[]; truncated: boolean }
export interface BrowserArtifactsOpenResult extends FeatureSuccess { command: "browser.artifacts.open"; artifact: BrowserArtifactItem; preview: BrowserArtifactPreview }
export type PluginFeatureResult = FeatureFailure | ReviewListResult | ReviewOpenResult | ReviewActionResult | ReviewCommentResult | ProjectActionsResult | ProjectActionResult | BrowserArtifactsListResult | BrowserArtifactsOpenResult;
export type { BrowserArtifactItem, BrowserArtifactPreview } from "./featureBrowserArtifacts";

interface ReviewRecord { id: string; scope: string; chatId: string; snapshot: ReviewRevision; expires: number; comments: ReviewComment[]; afterUri?: vscode.Uri; sending: Set<string> }
interface FeatureContext { chatId: string; scope: string; workspace?: string; assertCurrent: () => void }

export class PluginFeatureService implements vscode.Disposable {
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly artifacts = new FeatureBrowserArtifacts();
  private readonly commentThreads: vscode.CommentThread[] = [];
  private commentController?: vscode.CommentController;
  private currentScope?: string;
  private disposed = false;
  private projectPending?: Promise<ProjectActionResult>;
  private readonly timeoutMs: number;

  constructor(private readonly options: PluginFeatureServiceOptions) {
    this.timeoutMs = Math.max(50, Math.min(15_000, Number.isFinite(options.commandTimeoutMs) ? options.commandTimeoutMs! : 5000));
  }

  async handle(command: string, payload: unknown, chatId: string): Promise<PluginFeatureResult> {
    try {
      if (this.disposed) throw new FeatureError("blocked", "Feature service is no longer active.");
      if (typeof command !== "string" || command.length > 80 || typeof chatId !== "string" || !chatId || chatId.length > 200) {
        throw new FeatureError("blocked", "A valid feature command and originating chat are required.");
      }
      const context = this.context(chatId);
      const args = payload === undefined || payload === null ? {} : objectPayload(payload);
      let result: PluginFeatureResult;
      switch (command) {
        case "review.list": result = await this.listReviews(context, args); break;
        case "review.open": result = await this.openReview(context, args); break;
        case "review.comment": result = await this.addComment(context, args); break;
        case "review.stage": case "review.revert": result = await this.reviewAction(context, command, args); break;
        case "project.actions": result = await this.projectActions(context); break;
        case "project.action.run": result = await this.projectAction(context, args); break;
        case "browser.artifacts.list": {
          const root = this.browserRoot(context.scope);
          const assertArtifactContext = () => { context.assertCurrent(); if (this.browserRoot(context.scope) !== root) throw new FeatureError("conflict", "The browser session changed. Refresh the artifact list."); };
          result = { ok: true, command, status: "ready", ...await this.artifacts.list(context.scope, root, chatId, assertArtifactContext) };
          assertArtifactContext();
          break;
        }
        case "browser.artifacts.open":
          result = { ok: true, command, status: "opened", ...this.artifacts.open(requiredString(args, "id", 100), context.scope, this.browserRoot(context.scope), chatId) };
          break;
        default: throw new FeatureError("unsupported", "This command is not handled by the feature backend.");
      }
      context.assertCurrent();
      return result;
    } catch (error) {
      const known = error instanceof FeatureError ? error : new FeatureError("error", "The feature could not complete. Refresh and check IDE availability or file permissions; no raw server output is exposed.");
      return {
        ok: false, command: typeof command === "string" ? command.slice(0, 80) : "", status: known.status, message: known.message,
        error: { category: known.status === "conflict" ? "stale-revision" : known.status === "blocked" ? "needs-attention" : known.status === "unsupported" ? "not-supported" : known.status === "timeout" ? "deadline-exceeded" : "operation-failed", message: known.message, retryable: known.status === "conflict" || known.status === "timeout" }
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearScope();
  }

  private context(chatId: string): FeatureContext {
    const requestedScope = this.options.getScopeRoot();
    if (!requestedScope || !path.isAbsolute(requestedScope)) {
      this.clearScope();
      this.currentScope = undefined;
      throw new FeatureError("blocked", "A verified IDE user/project storage scope is required. No shared-profile fallback is used.");
    }
    const scope = fs.realpathSync(requestedScope);
    if (!fs.statSync(scope).isDirectory()) throw new FeatureError("blocked", "Authenticated storage is not available.");
    if (this.currentScope !== scope) { this.clearScope(); this.currentScope = scope; }
    const requestedWorkspace = this.options.getWorkspaceRoot(chatId);
    const workspace = requestedWorkspace && path.isAbsolute(requestedWorkspace) ? fs.realpathSync(requestedWorkspace) : undefined;
    const assertCurrent = () => {
      if (this.disposed || this.options.getScopeRoot() !== requestedScope || this.options.getWorkspaceRoot(chatId) !== requestedWorkspace
          || fs.realpathSync(requestedScope) !== scope || (requestedWorkspace && fs.realpathSync(requestedWorkspace) !== workspace)) {
        throw new FeatureError("conflict", "The authenticated scope or workspace changed. Reopen the feature in the current chat.");
      }
    };
    return { chatId, scope, workspace, assertCurrent };
  }

  private browserRoot(scope: string): string | undefined {
    return this.options.getBrowserArtifactsRoot ? this.options.getBrowserArtifactsRoot() : path.join(scope, "browser", "artifacts");
  }

  private clearScope(): void {
    this.reviews.clear();
    this.artifacts.clear();
    for (const thread of this.commentThreads) thread.dispose();
    this.commentThreads.length = 0;
    this.commentController?.dispose();
    this.commentController = undefined;
    this.options.diffArtifacts?.clear();
  }

  private workspace(context: FeatureContext): string {
    if (!context.workspace) throw new FeatureError("blocked", "Open a project workspace for this chat first.");
    return context.workspace;
  }

  private async commandNames(): Promise<Set<string>> {
    if (typeof vscode.commands?.getCommands !== "function") return new Set();
    return new Set(await deadline(vscode.commands.getCommands(true), this.timeoutMs));
  }

  private async listReviews(context: FeatureContext, args: Record<string, unknown>): Promise<ReviewListResult> {
    const root = this.workspace(context);
    const offset = args.offset === undefined ? 0 : args.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new FeatureError("blocked", "Invalid review list offset.");
    const discovery = await listReviewPaths(root);
    const paths = discovery.items;
    const items: ReviewListItem[] = [];
    let pageBytes = 0;
    for (const entry of paths.slice(offset, offset + 40)) {
      context.assertCurrent();
      const id = opaqueId();
      try {
        const snapshot = await captureReview(root, entry.path, entry.layer);
        context.assertCurrent();
        const bytes = snapshot.before.length + snapshot.after.length;
        if (items.length && pageBytes + bytes > 8 * 1024 * 1024) break;
        pageBytes += bytes;
        const record: ReviewRecord = { id, scope: context.scope, chatId: context.chatId, snapshot, expires: Date.now() + REVIEW_TTL_MS, comments: [], sending: new Set() };
        this.reviews.set(id, record);
        items.push(this.reviewItem(record));
      } catch (error) {
        if (!(error instanceof FeatureError)) throw error;
        items.push({ id, path: entry.path.slice(0, 240), layer: entry.layer, change: "unavailable", revision: "", canOpen: false, canStage: false, canRevert: false, reason: error.message });
      }
    }
    this.pruneReviews();
    const commands = await this.commandNames().catch(() => new Set<string>());
    return {
      ok: true, command: "review.list", status: "ready", items, truncated: discovery.truncated || paths.length > offset + items.length,
      message: discovery.truncated ? "Discovery reached its bounded file/byte budget; this is not a complete repository status." : "Raw full-file comparison; Git clean filters are not executed. Unsupported files are marked unavailable.",
      ...(paths.length > offset + items.length ? { nextOffset: offset + items.length } : {}),
      capabilities: { nativeDiff: { available: !!this.options.diffArtifacts && commands.has("vscode.diff") }, nativeComments: { available: typeof vscode.comments?.createCommentController === "function" } }
    };
  }

  private reviewItem(record: ReviewRecord): ReviewListItem {
    const value = record.snapshot;
    const reason = isDirty(path.join(value.root, value.path)) ? "Unsaved editor changes are preserved. Save or resolve them before stage/revert." : value.mutationReason;
    const changed = value.beforeExists !== value.afterExists || !value.before.equals(value.after) || value.beforeMode !== value.afterMode;
    return { id: record.id, path: value.path, layer: value.layer, change: !value.beforeExists ? "added" : !value.afterExists ? "deleted" : "modified", revision: value.revision, canOpen: true, canStage: !reason && changed, canRevert: !reason && changed, reason };
  }

  private record(context: FeatureContext, args: Record<string, unknown>, requireRevision: boolean): ReviewRecord {
    this.pruneReviews();
    const record = this.reviews.get(requiredString(args, "id", 100));
    if (!record || record.scope !== context.scope || record.chatId !== context.chatId || record.snapshot.root !== context.workspace) {
      throw new FeatureError("blocked", "This review ID is expired or belongs to another chat/scope. Refresh the review list.");
    }
    if (requireRevision && requiredString(args, "revision", 100) !== record.snapshot.revision) throw new FeatureError("conflict", "The requested review revision is stale. Refresh the review list.");
    return record;
  }

  private async openReview(context: FeatureContext, args: Record<string, unknown>): Promise<ReviewOpenResult> {
    const record = this.record(context, args, false);
    let opened = false;
    let message = "Full snapshots captured; the in-chat preview is capped. Unsaved editor content is not included or changed.";
    if (this.options.diffArtifacts && (await this.commandNames().catch(() => new Set<string>())).has("vscode.diff")) {
      context.assertCurrent();
      try {
        const uris = await deadline(this.options.diffArtifacts.openSnapshots({ path: record.snapshot.path, beforeText: record.snapshot.before.toString("utf8"), afterText: record.snapshot.after.toString("utf8"), beforeLabel: record.snapshot.layer === "index" ? "HEAD" : "Index", afterLabel: record.snapshot.layer === "index" ? "Index" : "Working file", revision: record.snapshot.revision }), this.timeoutMs);
        record.afterUri = uris.afterUri;
        opened = true;
      } catch {
        message = "The native editor did not confirm opening. The bounded in-chat review remains available.";
      }
    }
    const value = record.snapshot;
    return { ok: true, command: "review.open", status: opened ? "opened" : "ready", opened, message, review: { ...this.reviewItem(record), full: true, source: "git-and-disk", before: side(value.before, value.beforeExists, value.layer === "index" ? "HEAD" : "Index"), after: side(value.after, value.afterExists, value.layer === "index" ? "Index" : "Working file on disk"), comments: record.comments.map((entry) => ({ ...entry })) } };
  }

  private async reviewAction(context: FeatureContext, command: "review.stage" | "review.revert", args: Record<string, unknown>): Promise<ReviewActionResult> {
    confirm(args);
    const record = this.record(context, args, true);
    const action = command === "review.stage" ? "stage" : "revert";
    const details = await mutateReview(record.snapshot, action, context.scope, context.assertCurrent);
    this.reviews.delete(record.id);
    return { ok: true, command, status: "completed", id: record.id, revision: record.snapshot.revision, refreshRequired: true, ...details, message: action === "stage" ? "Only the reviewed file revision was staged. Working files and editor buffers were not changed." : "The working file was restored to its reviewed index version. Staged changes were preserved; a recovery snapshot was retained in authenticated storage." };
  }

  private async addComment(context: FeatureContext, args: Record<string, unknown>): Promise<ReviewCommentResult> {
    const record = this.record(context, args, true);
    const text = requiredString(args, "text", 8000);
    const line = args.line;
    const lines = Math.max(1, record.snapshot.after.toString("utf8").split("\n").length);
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || line > lines) throw new FeatureError("blocked", "Choose a line in the reviewed after revision (line numbers start at 1).");
    if (args.sendToChat !== undefined && typeof args.sendToChat !== "boolean") throw new FeatureError("blocked", "sendToChat must be an explicit boolean.");
    const key = digest(`${line}\0${text}`);
    let note = record.comments.find((entry) => entry.id === key);
    if (!note) {
      if (record.comments.length >= 50) throw new FeatureError("blocked", "This review reached its comment limit.");
      note = { id: key, line, text, revision: record.snapshot.revision, native: false, sentToChat: false };
      if (record.afterUri && typeof vscode.comments?.createCommentController === "function") {
        try {
          this.commentController ??= vscode.comments.createCommentController(`codex-review-${opaqueId()}`, "Codex Review");
          const body = new vscode.MarkdownString();
          body.appendText(text);
          body.isTrusted = false;
          const thread = this.commentController.createCommentThread(record.afterUri, new vscode.Range(line - 1, 0, line - 1, 0), [{ body, mode: vscode.CommentMode.Preview, author: { name: "Review" } }]);
          thread.canReply = false;
          thread.label = `Review ${record.snapshot.revision.slice(0, 10)}`;
          this.commentThreads.push(thread);
          while (this.commentThreads.length > 100) this.commentThreads.shift()?.dispose();
          note.native = true;
        } catch { /* The returned in-chat note is the fallback on partial Element API support. */ }
      }
      record.comments.push(note);
    }
    const followUp = `Review comment on ${record.snapshot.path}:${line} (snapshot ${record.snapshot.revision}):\n${text}`;
    let message = note.native ? "Review comment added to the immutable native diff." : "Review comment saved in the in-chat review.";
    if (args.sendToChat === true && !note.sentToChat) {
      if (!this.options.onReviewComment) message = "Review note saved. Sending a follow-up is unavailable in this runtime.";
      else if (record.sending.has(key)) message = "This review follow-up is already being submitted.";
      else {
        context.assertCurrent();
        record.sending.add(key);
        note.sendingToChat = true;
        const deliveryNote = note;
        const delivery = Promise.resolve().then(() => {
          context.assertCurrent();
          return this.options.onReviewComment!(context.chatId, followUp, { reviewId: record.id, revision: record.snapshot.revision, path: record.snapshot.path, line });
        });
        void delivery.then(() => {
          deliveryNote.sentToChat = true;
          deliveryNote.sendingToChat = false;
          record.sending.delete(key);
        }, () => { deliveryNote.sendingToChat = false; record.sending.delete(key); });
        try {
          await deadline(delivery, this.timeoutMs);
          message = "Review comment submitted as a follow-up to its originating chat.";
        } catch (error) {
          message = error instanceof FeatureError && error.status === "timeout" ? "Review note saved. Follow-up delivery is still pending; duplicate submissions are blocked until the runtime responds." : "Review note saved, but the runtime did not accept the follow-up. It was not marked as sent.";
        }
      }
    }
    return { ok: true, command: "review.comment", status: "completed", comment: { ...note }, followUp, message };
  }

  private async projectActions(context: FeatureContext): Promise<ProjectActionsResult> {
    this.workspace(context);
    const commands = await this.commandNames();
    const readiness = !!this.options.isProjectReady || commands.has(LSP_REQUEST);
    return {
      ok: true, command: "project.actions", status: "ready",
      items: [
        { id: "openApplication", label: "Open application", available: commands.has(OPEN_APPLICATION) && readiness, reason: commands.has(OPEN_APPLICATION) && readiness ? undefined : "Element application command or readiness capability is unavailable." },
        { id: "diagnostics", label: "Current project diagnostics", available: typeof vscode.languages?.getDiagnostics === "function" && readiness, reason: readiness ? "Reads current IDE diagnostics; does not build or publish." : "Element LSP readiness is unavailable." },
        { id: "rebuild", label: "Rebuild / publish", available: false, reason: "The bundled clean/notify commands do not acknowledge build completion and may run later. Use Element's explicit project workflow." },
        { id: "worktree", label: "Independent Element worktree", available: false, reason: "Git worktrees do not provision an independent Element workspace, LSP or publication lifecycle." }
      ],
      capabilities: { terminal: { available: false, reason: "Terminal/task execution is not assumed to be permitted in this Element mode." }, worktrees: { available: false, reason: "No branch, worktree, remote push or workspace-switch commands are invoked." } }
    };
  }

  private async projectAction(context: FeatureContext, args: Record<string, unknown>): Promise<ProjectActionResult> {
    confirm(args);
    const id = requiredString(args, "id", 100);
    if (id !== "openApplication" && id !== "diagnostics") throw new FeatureError("unsupported", "Only the listed read-only diagnostics and explicit application-opening actions are supported.");
    if (this.projectPending) throw new FeatureError("blocked", "A prior Element request is still pending. It was not cancelled by a UI timeout; duplicate actions are blocked.");
    const expiry = { expired: false };
    const run = async (): Promise<ProjectActionResult> => {
      const root = this.workspace(context);
      const commands = await this.commandNames();
      if ((id === "openApplication" && !commands.has(OPEN_APPLICATION)) || (!this.options.isProjectReady && !commands.has(LSP_REQUEST))) throw new FeatureError("unsupported", "The required Element command is not registered.");
      context.assertCurrent();
      if (expiry.expired) throw new FeatureError("timeout", "The action deadline elapsed before readiness was checked.");
      const ready = this.options.isProjectReady ? await this.options.isProjectReady() : Array.isArray(await vscode.commands.executeCommand(LSP_REQUEST, READINESS_METHOD));
      // A late readiness reply must never launch an action after its timeout reached the UI.
      if (expiry.expired) throw new FeatureError("timeout", "The action deadline elapsed before dispatch; no application action was started.");
      context.assertCurrent();
      if (!ready) throw new FeatureError("blocked", "Element LSP is not ready. No application action was started.");
      if (id === "openApplication") {
        await vscode.commands.executeCommand(OPEN_APPLICATION);
        return { ok: true, command: "project.action.run", status: "dispatched", id, message: "Element accepted the application-opening command. This does not assert application readiness or publication completion." };
      }
      if (typeof vscode.languages?.getDiagnostics !== "function") throw new FeatureError("unsupported", "Current IDE diagnostics are unavailable.");
      const items: NonNullable<ProjectActionResult["diagnostics"]>["items"] = [];
      let errors = 0, warnings = 0, total = 0;
      for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== "file" || !contained(root, uri.fsPath)) continue;
        for (const diagnostic of diagnostics) {
          total++;
          if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors++;
          if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings++;
          if (items.length < 50) items.push({ path: path.relative(root, uri.fsPath).split(path.sep).join("/"), line: diagnostic.range.start.line + 1, severity: diagnostic.severity === 0 ? "error" : diagnostic.severity === 1 ? "warning" : "information", message: redactPreview(diagnostic.message.slice(0, MAX_PREVIEW_CHARS)).slice(0, 800) });
        }
      }
      return { ok: true, command: "project.action.run", status: "completed", id, diagnostics: { errors, warnings, total, truncated: total > items.length, freshness: "current-IDE-cache", buildRequested: false, items }, message: "Current IDE diagnostics collected. No build, terminal process or publication was requested." };
    };
    const pending = run();
    this.projectPending = pending;
    void pending.then(() => { if (this.projectPending === pending) this.projectPending = undefined; }, () => { if (this.projectPending === pending) this.projectPending = undefined; });
    try { return await deadline(pending, this.timeoutMs); }
    finally { expiry.expired = true; }
  }

  private pruneReviews(): void {
    let bytes = 0;
    const size = (value: ReviewRecord) => value.snapshot.before.length + value.snapshot.after.length + value.comments.reduce((total, note) => total + Buffer.byteLength(note.text, "utf8"), 0);
    for (const value of this.reviews.values()) bytes += size(value);
    for (const [id, record] of this.reviews) {
      if (record.expires < Date.now() || bytes > MAX_REVIEW_CACHE_BYTES || this.reviews.size > 100) {
        bytes -= size(record);
        this.reviews.delete(id);
      }
    }
  }
}

function side(buffer: Buffer, exists: boolean, label: string): ReviewSide {
  const text = buffer.toString("utf8");
  return { text: text.slice(0, MAX_PREVIEW_CHARS), hash: digest(buffer), exists, bytes: buffer.length, lineCount: Math.max(1, text.split("\n").length), previewTruncated: text.length > MAX_PREVIEW_CHARS, label };
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeatureError("blocked", "Feature payload must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string, limit: number): string {
  const text = value[key];
  if (typeof text !== "string" || !text.trim() || text.length > limit || text.includes("\0")) throw new FeatureError("blocked", `A valid ${key} is required.`);
  return text;
}

function confirm(value: Record<string, unknown>): void {
  if (value.confirmed !== true) throw new FeatureError("blocked", "This operation requires an explicit user confirmation of the reviewed action.");
}

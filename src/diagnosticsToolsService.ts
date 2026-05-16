import * as path from "path";
import * as vscode from "vscode";
import {
  ContextToolArgs,
  ContextToolLimits,
  ContextToolRequest,
  ContextToolResult,
  ContextToolSource,
  createContextToolFailure,
  createContextToolLedgerEntry,
  createContextToolRequest,
  createContextToolSuccess
} from "./contextTools";
import { DiagnosticsContextService, DiagnosticsContextResult } from "./diagnosticsContextService";
import { Logger } from "./logger";

export interface DiagnosticsListToolArgs extends ContextToolArgs {
  priority?: number;
}

const DIAGNOSTICS_SOURCE: ContextToolSource = "diagnostics";
const DEFAULT_PRIORITY = 115;
const DEFAULT_BLOCK_CHARS = 12_000;

export class DiagnosticsToolsService {
  constructor(
    private readonly diagnosticsContext: DiagnosticsContextService,
    private readonly logger: Logger
  ) {}

  async list(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly reason: string;
    readonly priority?: number;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "diagnostics.list",
      source: DIAGNOSTICS_SOURCE,
      args: { priority: options.priority },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: {
        workspaceOnly: true,
        allowUnsavedEditorText: false
      }
    }));
  }

  async execute(request: ContextToolRequest<DiagnosticsListToolArgs>): Promise<ContextToolResult> {
    const startedAt = Date.now();
    const result = await this.executeUnsafe(request).catch((error: unknown) => createContextToolFailure(request, {
      code: "internalError",
      message: error instanceof Error ? error.message : String(error),
      retryable: false
    }));
    const roots = getMetadataStringArray(result.metadata.roots);
    const ledger = createContextToolLedgerEntry({
      request,
      result,
      startedAt,
      roots,
      metadata: result.metadata
    });

    this.logger.info(
      `Diagnostics tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; ` +
      `chars=${ledger.chars}; roots=${ledger.roots.length}; files=${String(result.metadata.filesCount ?? 0)}; ` +
      `errors=${String(result.metadata.errorsCount ?? 0)}; elapsed=${ledger.elapsedMs}ms.`
    );
    return result;
  }

  private async executeUnsafe(request: ContextToolRequest<DiagnosticsListToolArgs>): Promise<ContextToolResult> {
    if (request.toolName !== "diagnostics.list") {
      return createContextToolFailure(request, {
        code: "unsupported",
        message: `Unsupported diagnostics tool: ${request.toolName}`,
        retryable: false
      });
    }

    const priority = normalizePriority(request.args.priority);
    const result = await this.diagnosticsContext.collectErrorContext(priority);
    const metadata = metadataFromDiagnostics(result);
    const roots = getWorkspaceRootPaths();
    const fullMetadata = { ...metadata, roots };

    if (!result.block) {
      return createContextToolFailure(request, {
        code: result.reason === "no-workspace" ? "unavailable" : "notFound",
        message: diagnosticsFailureMessage(result.reason),
        retryable: true
      }, [], fullMetadata);
    }

    const text = trimToolBlock(result.block.text, request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: DIAGNOSTICS_SOURCE,
      text,
      matchCount: result.errorsCount,
      mode: "matched",
      score: result.block.score,
      priority: result.block.priority,
      tokensEstimate: Math.ceil(text.length / 4),
      metadata: {
        filesCount: result.filesCount,
        errorsCount: result.errorsCount,
        totalErrorsCount: result.totalErrorsCount,
        omittedErrorsCount: result.omittedErrorsCount,
        fingerprint: result.fingerprint,
        truncated: text.endsWith("…")
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: roots.join(";"),
        score: result.block.score
      }
    }], fullMetadata);
  }
}

function normalizePriority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(500, value)) : DEFAULT_PRIORITY;
}

function diagnosticsFailureMessage(reason: DiagnosticsContextResult["reason"]): string {
  if (reason === "no-workspace") {
    return "Workspace diagnostics are unavailable because no file workspace is open.";
  }
  if (reason === "no-errors") {
    return "No IDE errors are currently reported for workspace files.";
  }
  return "IDE diagnostics were not added.";
}

function metadataFromDiagnostics(result: DiagnosticsContextResult): Record<string, unknown> {
  return {
    filesCount: result.filesCount,
    errorsCount: result.errorsCount,
    totalErrorsCount: result.totalErrorsCount,
    omittedErrorsCount: result.omittedErrorsCount,
    fingerprint: result.fingerprint,
    reason: result.reason
  };
}

function getWorkspaceRootPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => path.resolve(folder.uri.fsPath));
}

function trimToolBlock(value: string, maxChars: number): string {
  const limit = Math.max(1000, Math.min(20_000, Math.floor(maxChars)));
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function getMetadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

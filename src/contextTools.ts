import * as crypto from "crypto";
import type { ContextBlock } from "./contextRouterService";

export type ContextToolName =
  | "docs.search"
  | "docs.read"
  | "docs.overview"
  | "project.search"
  | "project.readFile"
  | "project.listSymbols"
  | "diagnostics.list"
  | "editor.currentFile"
  | "editor.currentSelection";

export type ContextToolSource = ContextBlock["source"];

export type ContextToolMode = "native-tools" | "managed-fallback" | "retrieval-only";

export type ContextToolStatus = "ok" | "denied" | "timeout" | "error" | "unsupported";

export type ContextToolErrorCode =
  | "unsupported"
  | "denied"
  | "timeout"
  | "invalidRequest"
  | "notFound"
  | "tooLarge"
  | "unsafePath"
  | "unavailable"
  | "internalError";

export type ContextToolArgs = Record<string, unknown>;

export interface ContextToolLimits {
  readonly maxItems?: number;
  readonly maxChars?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface ContextToolScope {
  readonly readOnly: true;
  readonly workspaceOnly?: boolean;
  readonly allowedRoots?: readonly string[];
  readonly allowUnsavedEditorText?: boolean;
}

export interface ContextToolRequest<TArgs extends ContextToolArgs = ContextToolArgs> {
  readonly id: string;
  readonly chatId: string;
  readonly turnId?: string;
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  readonly args: TArgs;
  readonly reason: string;
  readonly createdAt: string;
  readonly mode: ContextToolMode;
  readonly limits: ContextToolLimits;
  readonly scope: ContextToolScope;
}

export interface ContextToolOrigin {
  readonly toolName: ContextToolName;
  readonly requestId: string;
  readonly root?: string;
  readonly path?: string;
  readonly title?: string;
  readonly corpus?: string;
  readonly score?: number;
}

export interface ContextToolBlock {
  readonly source: ContextToolSource;
  readonly text: string;
  readonly matchCount: number;
  readonly mode?: ContextBlock["mode"];
  readonly score?: number;
  readonly priority?: number;
  readonly tokensEstimate?: number;
  readonly metadata?: Record<string, unknown>;
  readonly origin: ContextToolOrigin;
}

export interface ContextToolStats {
  readonly itemCount: number;
  readonly blockCount: number;
  readonly chars: number;
  readonly truncated: boolean;
}

export interface ContextToolSuccess {
  readonly ok: true;
  readonly requestId: string;
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  readonly blocks: readonly ContextToolBlock[];
  readonly stats: ContextToolStats;
  readonly metadata: Record<string, unknown>;
}

export interface ContextToolFailure {
  readonly ok: false;
  readonly requestId: string;
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  readonly error: ContextToolError;
  readonly partialBlocks: readonly ContextToolBlock[];
  readonly metadata: Record<string, unknown>;
}

export type ContextToolResult = ContextToolSuccess | ContextToolFailure;

export interface ContextToolError {
  readonly code: ContextToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ContextToolLedgerEntry {
  readonly requestId: string;
  readonly chatId: string;
  readonly turnId?: string;
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  readonly status: ContextToolStatus;
  readonly mode: ContextToolMode;
  readonly reasonHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly roots: readonly string[];
  readonly itemCount: number;
  readonly blockCount: number;
  readonly chars: number;
  readonly truncated: boolean;
  readonly errorCode?: ContextToolErrorCode;
  readonly metadata: Record<string, unknown>;
}

export interface ContextSession {
  readonly id: string;
  readonly chatId: string;
  readonly turnId?: string;
  readonly mode: ContextToolMode;
  readonly route: string;
  readonly startedAt: string;
  readonly ledger: ContextToolLedgerEntry[];
}

export interface ContextToolProvider<TArgs extends ContextToolArgs = ContextToolArgs> {
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  execute(request: ContextToolRequest<TArgs>): Promise<ContextToolResult>;
}

export function createContextToolRequest<TArgs extends ContextToolArgs>(options: {
  readonly chatId: string;
  readonly turnId?: string;
  readonly toolName: ContextToolName;
  readonly source: ContextToolSource;
  readonly args: TArgs;
  readonly reason: string;
  readonly mode: ContextToolMode;
  readonly limits?: ContextToolLimits;
  readonly scope?: Partial<ContextToolScope>;
}): ContextToolRequest<TArgs> {
  return {
    id: `ctx-tool-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    chatId: options.chatId,
    turnId: options.turnId,
    toolName: options.toolName,
    source: options.source,
    args: options.args,
    reason: options.reason,
    createdAt: new Date().toISOString(),
    mode: options.mode,
    limits: options.limits ?? {},
    scope: {
      readOnly: true,
      workspaceOnly: options.scope?.workspaceOnly,
      allowedRoots: options.scope?.allowedRoots,
      allowUnsavedEditorText: options.scope?.allowUnsavedEditorText
    }
  };
}

export function toContextBlock(block: ContextToolBlock): ContextBlock {
  return {
    source: block.source,
    text: block.text,
    matchCount: block.matchCount,
    mode: block.mode,
    score: block.score,
    priority: block.priority,
    tokensEstimate: block.tokensEstimate ?? estimateContextToolTokens(block.text),
    metadata: {
      ...block.metadata,
      contextTool: {
        toolName: block.origin.toolName,
        requestId: block.origin.requestId,
        root: block.origin.root,
        path: block.origin.path,
        title: block.origin.title,
        corpus: block.origin.corpus,
        score: block.origin.score
      }
    }
  };
}

export function createContextToolSuccess(
  request: ContextToolRequest,
  blocks: readonly ContextToolBlock[],
  metadata: Record<string, unknown> = {}
): ContextToolSuccess {
  const chars = blocks.reduce((total, block) => total + block.text.length, 0);
  return {
    ok: true,
    requestId: request.id,
    toolName: request.toolName,
    source: request.source,
    blocks,
    stats: {
      itemCount: blocks.reduce((total, block) => total + block.matchCount, 0),
      blockCount: blocks.length,
      chars,
      truncated: blocks.some((block) => Boolean(block.metadata?.truncated))
    },
    metadata: sanitizeContextToolMetadata(metadata)
  };
}

export function createContextToolFailure(
  request: ContextToolRequest,
  error: ContextToolError,
  partialBlocks: readonly ContextToolBlock[] = [],
  metadata: Record<string, unknown> = {}
): ContextToolFailure {
  return {
    ok: false,
    requestId: request.id,
    toolName: request.toolName,
    source: request.source,
    error: sanitizeContextToolError(error),
    partialBlocks,
    metadata: sanitizeContextToolMetadata(metadata)
  };
}

export function createContextToolLedgerEntry(options: {
  readonly request: ContextToolRequest;
  readonly result: ContextToolResult;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly roots?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}): ContextToolLedgerEntry {
  const completedAt = options.completedAt ?? Date.now();
  const status: ContextToolStatus = options.result.ok ? "ok" : mapErrorCodeToStatus(options.result.error.code);
  const stats = options.result.ok
    ? options.result.stats
    : {
      itemCount: options.result.partialBlocks.reduce((total, block) => total + block.matchCount, 0),
      blockCount: options.result.partialBlocks.length,
      chars: options.result.partialBlocks.reduce((total, block) => total + block.text.length, 0),
      truncated: options.result.partialBlocks.some((block) => Boolean(block.metadata?.truncated))
    };

  return {
    requestId: options.request.id,
    chatId: options.request.chatId,
    turnId: options.request.turnId,
    toolName: options.request.toolName,
    source: options.request.source,
    status,
    mode: options.request.mode,
    reasonHash: hashContextToolReason(options.request.reason),
    startedAt: new Date(options.startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    elapsedMs: Math.max(0, completedAt - options.startedAt),
    roots: options.roots ?? options.request.scope.allowedRoots ?? [],
    itemCount: stats.itemCount,
    blockCount: stats.blockCount,
    chars: stats.chars,
    truncated: stats.truncated,
    errorCode: options.result.ok ? undefined : options.result.error.code,
    metadata: sanitizeContextToolMetadata(options.metadata ?? options.result.metadata)
  };
}

export function estimateContextToolTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export function hashContextToolReason(reason: string): string {
  return crypto.createHash("sha256").update(reason).digest("hex").slice(0, 16);
}

export function sanitizeContextToolError(error: ContextToolError): ContextToolError {
  return {
    code: error.code,
    message: shorten(error.message.replace(/\s+/g, " ").trim(), 240),
    retryable: error.retryable
  };
}

export function sanitizeContextToolMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/(^|\.)(text|content|prompt|raw|body|sourceText|fileText)$/iu.test(key)) {
      continue;
    }
    safe[key] = sanitizeMetadataValue(value, 0);
  }
  return safe;
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? shorten(value, 500) : value;
  }
  if (Array.isArray(value)) {
    return depth >= 2 ? `[array:${value.length}]` : value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object]";
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (/(^|\.)(text|content|prompt|raw|body|sourceText|fileText)$/iu.test(key)) {
        continue;
      }
      result[key] = sanitizeMetadataValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function mapErrorCodeToStatus(code: ContextToolErrorCode): ContextToolStatus {
  switch (code) {
    case "denied":
    case "unsafePath":
      return "denied";
    case "timeout":
      return "timeout";
    case "unsupported":
      return "unsupported";
    default:
      return "error";
  }
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

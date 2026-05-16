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
import { Logger } from "./logger";
import {
  ProjectContextService,
  ProjectToolError,
  ProjectToolReadFileResult,
  ProjectToolSearchResult,
  ProjectToolSymbolsResult
} from "./projectContextService";

export interface ProjectSearchToolArgs extends ContextToolArgs {
  query: string;
}

export interface ProjectReadFileToolArgs extends ContextToolArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ProjectListSymbolsToolArgs extends ContextToolArgs {
  query?: string;
  path?: string;
}

type ProjectToolArgs = ProjectSearchToolArgs | ProjectReadFileToolArgs | ProjectListSymbolsToolArgs;

const PROJECT_SOURCE: ContextToolSource = "project";
const DEFAULT_SEARCH_ITEMS = 8;
const DEFAULT_SYMBOL_ITEMS = 60;
const DEFAULT_READ_CHARS = 16_000;
const DEFAULT_BLOCK_CHARS = 20_000;

export class ProjectToolsService {
  constructor(
    private readonly projectContext: ProjectContextService,
    private readonly logger: Logger,
    private readonly getProfileId: () => string | undefined
  ) {}

  async search(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly query: string;
    readonly reason: string;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "project.search",
      source: PROJECT_SOURCE,
      args: { query: options.query },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: {
        workspaceOnly: true,
        allowUnsavedEditorText: false
      }
    }));
  }

  async readFile(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly reason: string;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "project.readFile",
      source: PROJECT_SOURCE,
      args: {
        path: options.path,
        startLine: options.startLine,
        endLine: options.endLine
      },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: {
        workspaceOnly: true,
        allowUnsavedEditorText: true
      }
    }));
  }

  async listSymbols(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly query?: string;
    readonly path?: string;
    readonly reason: string;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "project.listSymbols",
      source: PROJECT_SOURCE,
      args: {
        query: options.query,
        path: options.path
      },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: {
        workspaceOnly: true,
        allowUnsavedEditorText: false
      }
    }));
  }

  async execute(request: ContextToolRequest<ProjectToolArgs>): Promise<ContextToolResult> {
    const startedAt = Date.now();
    const result = await this.executeUnsafe(request).catch((error: unknown) => {
      if (error instanceof ProjectToolError) {
        return createContextToolFailure(request, {
          code: error.code,
          message: error.message,
          retryable: error.code === "unavailable"
        });
      }
      return createContextToolFailure(request, {
        code: "internalError",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      });
    });
    const roots = getMetadataStringArray(result.metadata.roots);
    const ledger = createContextToolLedgerEntry({
      request,
      result,
      startedAt,
      roots,
      metadata: result.metadata
    });

    this.logger.info(
      `Project tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; chars=${ledger.chars}; roots=${ledger.roots.length}; elapsed=${ledger.elapsedMs}ms.`
    );
    return result;
  }

  private async executeUnsafe(request: ContextToolRequest<ProjectToolArgs>): Promise<ContextToolResult> {
    if (request.toolName === "project.search") {
      return this.executeSearch(request as ContextToolRequest<ProjectSearchToolArgs>);
    }
    if (request.toolName === "project.readFile") {
      return this.executeReadFile(request as ContextToolRequest<ProjectReadFileToolArgs>);
    }
    if (request.toolName === "project.listSymbols") {
      return this.executeListSymbols(request as ContextToolRequest<ProjectListSymbolsToolArgs>);
    }
    return createContextToolFailure(request, {
      code: "unsupported",
      message: `Unsupported project tool: ${request.toolName}`,
      retryable: false
    });
  }

  private async executeSearch(request: ContextToolRequest<ProjectSearchToolArgs>): Promise<ContextToolResult> {
    const query = normalizeString(request.args.query);
    if (!query) {
      return createContextToolFailure(request, {
        code: "invalidRequest",
        message: "project.search requires a non-empty query.",
        retryable: false
      });
    }

    const search = await this.projectContext.searchTool(this.getProfileId(), query, {
      maxItems: request.limits.maxItems ?? DEFAULT_SEARCH_ITEMS,
      maxPreviewChars: 420
    });
    if (!search.chunks.length) {
      return createContextToolFailure(request, {
        code: "notFound",
        message: "No project chunks matched the query.",
        retryable: true
      }, [], metadataFromSearch(search));
    }

    const text = trimToolBlock(formatSearchBlock(search), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: PROJECT_SOURCE,
      text,
      matchCount: search.chunks.length,
      mode: "matched",
      score: search.chunks[0]?.score,
      metadata: {
        query,
        totalFiles: search.totalFiles,
        totalChunks: search.totalChunks,
        truncated: text.endsWith("…")
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: search.workspaceRoot,
        path: search.chunks.map((chunk) => chunk.path).join(";"),
        score: search.chunks[0]?.score
      }
    }], metadataFromSearch(search));
  }

  private async executeReadFile(request: ContextToolRequest<ProjectReadFileToolArgs>): Promise<ContextToolResult> {
    const filePath = normalizeString(request.args.path);
    if (!filePath) {
      return createContextToolFailure(request, {
        code: "invalidRequest",
        message: "project.readFile requires a non-empty path.",
        retryable: false
      });
    }

    const file = await this.projectContext.readFileTool(this.getProfileId(), {
      filePath,
      startLine: asOptionalNumber(request.args.startLine),
      endLine: asOptionalNumber(request.args.endLine),
      maxChars: request.limits.maxChars ?? DEFAULT_READ_CHARS,
      maxBytes: request.limits.maxBytes
    });
    const text = trimToolBlock(formatReadFileBlock(file), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: PROJECT_SOURCE,
      text,
      matchCount: 1,
      mode: "matched",
      metadata: {
        path: file.path,
        language: file.language,
        startLine: file.startLine,
        endLine: file.endLine,
        fromOpenDocument: file.fromOpenDocument,
        truncated: text.endsWith("…") || file.truncated
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: file.workspaceRoot,
        path: file.path,
        title: file.path
      }
    }], metadataFromReadFile(file));
  }

  private async executeListSymbols(request: ContextToolRequest<ProjectListSymbolsToolArgs>): Promise<ContextToolResult> {
    const symbols = await this.projectContext.listSymbolsTool(this.getProfileId(), {
      query: normalizeString(request.args.query),
      filePath: normalizeString(request.args.path),
      maxItems: request.limits.maxItems ?? DEFAULT_SYMBOL_ITEMS
    });
    if (!symbols.symbols.length) {
      return createContextToolFailure(request, {
        code: "notFound",
        message: "No project symbols matched the request.",
        retryable: true
      }, [], metadataFromSymbols(symbols));
    }

    const text = trimToolBlock(formatSymbolsBlock(symbols), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: PROJECT_SOURCE,
      text,
      matchCount: symbols.symbols.length,
      mode: "matched",
      score: symbols.symbols[0]?.score,
      metadata: {
        query: symbols.query,
        path: symbols.path,
        totalFiles: symbols.totalFiles,
        totalChunks: symbols.totalChunks,
        truncated: text.endsWith("…")
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: symbols.workspaceRoot,
        path: symbols.path,
        score: symbols.symbols[0]?.score
      }
    }], metadataFromSymbols(symbols));
  }
}

function formatSearchBlock(search: ProjectToolSearchResult): string {
  return [
    "[PROJECT TOOL: search]",
    `Query: ${search.query}`,
    `Workspace: ${search.workspaceRoot}`,
    `Index: v2, files=${search.totalFiles}, chunks=${search.totalChunks}, updated=${search.updatedAt}`,
    "Use these candidates only as an index. Call project.readFile for exact file content before relying on details outside the preview.",
    "",
    ...search.chunks.map((chunk, index) => formatChunkRef(index + 1, chunk))
  ].join("\n");
}

function formatReadFileBlock(file: ProjectToolReadFileResult): string {
  return [
    "[PROJECT TOOL: readFile]",
    `File: ${file.path}:${file.startLine}-${file.endLine}`,
    `Language: ${file.language}`,
    `Workspace: ${file.workspaceRoot}`,
    file.fromOpenDocument ? "Source: open editor document, includes unsaved changes." : "Source: workspace file on disk.",
    file.truncated ? "Note: file content was truncated by tool limits." : "",
    "Use this bounded file content as authoritative for the current answer. Do not mention this service block unless the user asks about sources.",
    "",
    file.text
  ].filter(Boolean).join("\n");
}

function formatSymbolsBlock(result: ProjectToolSymbolsResult): string {
  return [
    "[PROJECT TOOL: listSymbols]",
    result.query ? `Query: ${result.query}` : "",
    result.path ? `Path: ${result.path}` : "",
    `Workspace: ${result.workspaceRoot}`,
    `Index: v2, files=${result.totalFiles}, chunks=${result.totalChunks}, updated=${result.updatedAt}`,
    "",
    ...result.symbols.map((symbol, index) => [
      `${index + 1}. ${symbol.name}`,
      `   path: ${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
      `   language: ${symbol.language}`,
      `   score: ${Math.round(symbol.score)}`,
      symbol.preview ? `   preview: ${symbol.preview}` : ""
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n");
}

function formatChunkRef(index: number, chunk: ProjectToolSearchResult["chunks"][number]): string {
  return [
    `${index}. ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    `   id: ${chunk.chunkId}`,
    `   language: ${chunk.language}`,
    chunk.symbols.length ? `   symbols: ${chunk.symbols.join(", ")}` : "",
    chunk.keywords.length ? `   keywords: ${chunk.keywords.join(", ")}` : "",
    `   score: ${Math.round(chunk.score)}`,
    chunk.preview ? `   preview: ${chunk.preview}` : ""
  ].filter(Boolean).join("\n");
}

function metadataFromSearch(search: ProjectToolSearchResult): Record<string, unknown> {
  return {
    roots: [search.workspaceRoot],
    indexPath: search.indexPath,
    updatedAt: search.updatedAt,
    query: search.query,
    files: search.totalFiles,
    chunks: search.totalChunks,
    selectedChunks: search.chunks.length,
    paths: unique(search.chunks.map((chunk) => chunk.path))
  };
}

function metadataFromReadFile(file: ProjectToolReadFileResult): Record<string, unknown> {
  return {
    roots: [file.workspaceRoot],
    path: file.path,
    language: file.language,
    size: file.size,
    startLine: file.startLine,
    endLine: file.endLine,
    totalLines: file.totalLines,
    fromOpenDocument: file.fromOpenDocument,
    truncated: file.truncated
  };
}

function metadataFromSymbols(result: ProjectToolSymbolsResult): Record<string, unknown> {
  return {
    roots: [result.workspaceRoot],
    indexPath: result.indexPath,
    updatedAt: result.updatedAt,
    query: result.query,
    path: result.path,
    files: result.totalFiles,
    chunks: result.totalChunks,
    symbols: result.symbols.length,
    paths: unique(result.symbols.map((symbol) => symbol.path))
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trimToolBlock(value: string, maxChars: number): string {
  const limit = Math.max(1000, Math.min(30_000, Math.floor(maxChars)));
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

function getMetadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

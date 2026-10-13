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
import {
  DocsContextService,
  DocsToolFragmentRef,
  DocsToolReadResult,
  DocsToolSearchResult
} from "./docsContextService";
import { Logger } from "./logger";
import {
  compareDocumentationVersion,
  documentationVersionLabel,
  documentationVersionRank,
  formatDocumentationVersion,
  normalizePlatformVersion,
  summarizeDocumentationVersions
} from "./documentationCompatibility";

export interface DocsSearchToolArgs extends ContextToolArgs {
  query: string;
}

export interface DocsReadToolArgs extends ContextToolArgs {
  fragmentIds?: string[];
  sourcePath?: string;
  title?: string;
  query?: string;
  symbolNames?: readonly string[];
  expectedPlatformVersion?: string;
}

export interface DocsOverviewToolArgs extends ContextToolArgs {
  query?: string;
}

type DocsToolArgs = DocsSearchToolArgs | DocsReadToolArgs | DocsOverviewToolArgs;

const DOCS_SOURCE: ContextToolSource = "docs";
const DEFAULT_SEARCH_ITEMS = 8;
const DEFAULT_READ_ITEMS = 4;
const DEFAULT_OVERVIEW_ITEMS = 6;
const DEFAULT_BLOCK_CHARS = 7200;
const SYMBOL_READ_CHARS = 7000;
const MAX_SYMBOLS = 3;
const SYMBOL_IDENTIFIER = "[\\p{L}_][\\p{L}\\p{N}\\p{M}_]*";
const QUALIFIED_SYMBOL = `${SYMBOL_IDENTIFIER}(?:(?:::|\\.)${SYMBOL_IDENTIFIER})*`;
const SYMBOL_PATTERN = new RegExp(`^${QUALIFIED_SYMBOL}$`, "u");
const TITLE_SYMBOL_PATTERN = new RegExp('^["`«]?(' + QUALIFIED_SYMBOL + ')(?=$|[^\\p{L}\\p{N}\\p{M}_:.])', "u");

export class DocsToolsService {
  constructor(
    private readonly docsContext: DocsContextService,
    private readonly logger: Logger
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
      toolName: "docs.search",
      source: DOCS_SOURCE,
      args: { query: options.query },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: { workspaceOnly: false }
    }));
  }

  async read(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly fragmentIds?: string[];
    readonly sourcePath?: string;
    readonly title?: string;
    readonly query?: string;
    readonly symbolNames?: readonly string[];
    readonly expectedPlatformVersion?: string;
    readonly reason: string;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "docs.read",
      source: DOCS_SOURCE,
      args: {
        fragmentIds: options.fragmentIds,
        sourcePath: options.sourcePath,
        title: options.title,
        query: options.query,
        symbolNames: options.symbolNames,
        expectedPlatformVersion: options.expectedPlatformVersion
      },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: { workspaceOnly: false }
    }));
  }

  async overview(options: {
    readonly chatId: string;
    readonly turnId?: string;
    readonly query?: string;
    readonly reason: string;
    readonly limits?: ContextToolLimits;
  }): Promise<ContextToolResult> {
    return this.execute(createContextToolRequest({
      chatId: options.chatId,
      turnId: options.turnId,
      toolName: "docs.overview",
      source: DOCS_SOURCE,
      args: { query: options.query },
      reason: options.reason,
      mode: "managed-fallback",
      limits: options.limits,
      scope: { workspaceOnly: false }
    }));
  }

  async execute(request: ContextToolRequest<DocsToolArgs>): Promise<ContextToolResult> {
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
      `Docs tool ${request.toolName}: status=${ledger.status}; blocks=${ledger.blockCount}; items=${ledger.itemCount}; chars=${ledger.chars}; roots=${ledger.roots.length}; elapsed=${ledger.elapsedMs}ms.`
    );
    return result;
  }

  private async executeUnsafe(request: ContextToolRequest<DocsToolArgs>): Promise<ContextToolResult> {
    if (request.toolName === "docs.search") {
      return this.executeSearch(request as ContextToolRequest<DocsSearchToolArgs>);
    }
    if (request.toolName === "docs.read") {
      return this.executeRead(request as ContextToolRequest<DocsReadToolArgs>);
    }
    if (request.toolName === "docs.overview") {
      return this.executeOverview(request as ContextToolRequest<DocsOverviewToolArgs>);
    }
    return createContextToolFailure(request, {
      code: "unsupported",
      message: `Unsupported docs tool: ${request.toolName}`,
      retryable: false
    });
  }

  private async executeSearch(request: ContextToolRequest<DocsSearchToolArgs>): Promise<ContextToolResult> {
    const query = normalizeQuery(request.args.query);
    if (!query) {
      return createContextToolFailure(request, {
        code: "invalidRequest",
        message: "docs.search requires a non-empty query.",
        retryable: false
      });
    }

    const search = await this.docsContext.searchTool(query, {
      maxItems: request.limits.maxItems ?? DEFAULT_SEARCH_ITEMS,
      maxPreviewChars: 420
    });
    if (!search) {
      return createContextToolFailure(request, {
        code: "unavailable",
        message: "No configured documentation corpus is available.",
        retryable: true
      });
    }
    if (!search.fragments.length) {
      return createContextToolFailure(request, {
        code: "notFound",
        message: "No documentation fragments matched the query.",
        retryable: true
      }, [], metadataFromSearch(search));
    }

    const text = trimToolBlock(formatSearchBlock(search), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: DOCS_SOURCE,
      text,
      matchCount: search.fragments.length,
      mode: "matched",
      score: search.fragments[0]?.score,
      metadata: {
        query,
        roots: search.roots.length,
        totalAvailableFragments: search.totalAvailableFragments,
        truncated: text.endsWith("…")
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: search.roots.map((root) => root.root).join(";"),
        corpus: unique(search.fragments.map((fragment) => fragment.corpus)).join(","),
        score: search.fragments[0]?.score
      }
    }], metadataFromSearch(search));
  }

  private async executeRead(request: ContextToolRequest<DocsReadToolArgs>): Promise<ContextToolResult> {
    const hasExplicitSelection = request.args.fragmentIds?.some(id => id.trim())
      || normalizeQuery(request.args.sourcePath) || normalizeQuery(request.args.title);
    if (request.args.symbolNames !== undefined && !hasExplicitSelection) {
      return this.executeReadSymbols(request);
    }
    const read = await this.docsContext.readTool({
      fragmentIds: request.args.fragmentIds,
      sourcePath: request.args.sourcePath,
      title: request.args.title,
      query: request.args.query,
      maxItems: request.limits.maxItems ?? DEFAULT_READ_ITEMS,
      maxCharsPerItem: Math.min(request.limits.maxChars ?? 1800, 4000)
    });
    if (!read) {
      return createContextToolFailure(request, {
        code: "unavailable",
        message: "No configured documentation corpus is available.",
        retryable: true
      });
    }
    if (!read.fragments.length) {
      return createContextToolFailure(request, {
        code: "notFound",
        message: "Requested documentation fragment was not found.",
        retryable: true
      }, [], metadataFromRead(read));
    }

    const text = trimToolBlock(formatReadBlock(read), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: DOCS_SOURCE,
      text,
      matchCount: read.fragments.length,
      mode: "matched",
      metadata: {
        roots: read.roots.length,
        truncated: text.endsWith("…") || read.fragments.some((fragment) => fragment.truncated)
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: read.roots.map((root) => root.root).join(";"),
        path: read.fragments.map((fragment) => fragment.ref.sourcePath).join(";"),
        title: read.fragments.map((fragment) => fragment.ref.title).join(";"),
        corpus: unique(read.fragments.map((fragment) => fragment.ref.corpus)).join(",")
      }
    }], metadataFromRead(read));
  }

  private async executeReadSymbols(request: ContextToolRequest<DocsReadToolArgs>): Promise<ContextToolResult> {
    const symbolNames = normalizeSymbolNames(request.args.symbolNames);
    if (!symbolNames.length) {
      return createContextToolFailure(request, {
        code: "invalidRequest", message: "Не указаны корректные имена символов документации.", retryable: false
      });
    }
    const selected = new Map<string, string>();
    const roots = new Set<string>();
    const unavailableSymbols: string[] = [];
    const candidates = new Map<string, DocsToolFragmentRef[]>();
    const expectedPlatformVersion = normalizePlatformVersion(request.args.expectedPlatformVersion);
    const compatibility = (ref: DocsToolFragmentRef) => compareDocumentationVersion(ref.id, expectedPlatformVersion, ref.documentationVersion);
    const maxItems = boundedLimit(request.limits.maxItems, MAX_SYMBOLS, MAX_SYMBOLS);
    for (const symbol of symbolNames) {
      const search = await this.docsContext.searchTool(symbol, { maxItems: 12, maxPreviewChars: 120 });
      if (!search) { unavailableSymbols.push(symbol); continue; }
      search.roots.forEach(root => roots.add(root.root));
      candidates.set(symbol, search.fragments.slice(0, 12).filter(fragment => titleMatchesSymbol(fragment.title, symbol)));
    }
    for (const [symbol, exact] of candidates) {
      const preferred = exact.sort((a, b) => documentationVersionRank(compatibility(b)) - documentationVersionRank(compatibility(a)))[0];
      if (preferred && selected.size < maxItems) selected.set(preferred.id, symbol);
    }
    const metadata = {
      roots: [...roots], requestedSymbols: symbolNames, unavailableSymbols,
      titleMatch: "exact-identifier", versionCompatibility: "unverified",
      ...(expectedPlatformVersion ? { expectedPlatformVersion } : {}),
      versionSelectionScope: "retrieved-exact-candidates",
      documentationVersions: []
    };
    if (!selected.size) {
      return createContextToolFailure(request, {
        code: unavailableSymbols.length ? "unavailable" : "notFound",
        message: "Точные заголовки документации для выбранных символов не найдены. Похожие названия не подставлены.",
        retryable: true
      }, [], { ...metadata, matchedSymbols: [], unmatchedSymbols: symbolNames });
    }
    const maxChars = boundedLimit(request.limits.maxChars, SYMBOL_READ_CHARS, SYMBOL_READ_CHARS);
    const read = await this.docsContext.readTool({
      fragmentIds: [...selected.keys()], maxItems: selected.size,
      maxCharsPerItem: Math.max(1, Math.min(4000, Math.floor(maxChars / selected.size)))
    });
    if (!read) {
      return createContextToolFailure(request, {
        code: "unavailable", message: "Не удалось прочитать выбранные фрагменты документации.", retryable: true
      }, [], { ...metadata, matchedSymbols: [], unmatchedSymbols: symbolNames });
    }
    // Recheck IDs and titles after reading: a changed corpus must not introduce a fuzzy replacement.
    const fragments = read.fragments.filter(fragment => {
      const symbol = selected.get(fragment.ref.id);
      return symbol !== undefined && titleMatchesSymbol(fragment.ref.title, symbol);
    }).slice(0, maxItems);
    const documentationVersions = fragments.map(fragment => compatibility(fragment.ref));
    const versionCompatibility = summarizeDocumentationVersions(documentationVersions);
    const matchedSymbols = unique(fragments.map(fragment => selected.get(fragment.ref.id)!));
    const resultMetadata = {
      ...metadata, ...metadataFromRead({ ...read, fragments }), matchedSymbols,
      versionCompatibility,
      // Keep evidence flat so the context-tool metadata depth limit preserves it.
      documentationVersions: documentationVersions.map(({ evidence, ...check }) =>
        Object.fromEntries(Object.entries({ ...check, ...evidence }).filter(([, value]) => value !== undefined))),
      unmatchedSymbols: symbolNames.filter(symbol => !matchedSymbols.includes(symbol))
    };
    if (!fragments.length) {
      return createContextToolFailure(request, {
        code: "notFound", message: "Выбранные точные фрагменты документации больше не доступны.", retryable: true
      }, [], resultMetadata);
    }
    const formatted = formatReadBlock({ ...read, fragments },
      `Точное совпадение идентификаторов заголовков: ${matchedSymbols.join(", ")}. ` +
      `Совместимость версии документации: ${documentationVersionLabel(versionCompatibility)}. ` +
      "Сопоставлены только явные метки версий; совместимость API и соответствие разрешённому типу не проверены. " +
      "Без точного совпадения версий не считайте описанный API подтверждённым для проекта.",
      documentationVersions.map(formatDocumentationVersion));
    const text = formatted.length > maxChars ? `${formatted.slice(0, maxChars - 1)}…` : formatted;
    return createContextToolSuccess(request, [{
      source: DOCS_SOURCE, text, matchCount: fragments.length, mode: "matched",
      metadata: { ...resultMetadata, truncated: text.length < formatted.length || fragments.some(fragment => fragment.truncated) },
      origin: {
        toolName: request.toolName, requestId: request.id, root: read.roots.map(root => root.root).join(";"),
        path: fragments.map(fragment => fragment.ref.sourcePath).join(";"),
        title: fragments.map(fragment => fragment.ref.title).join(";"),
        corpus: unique(fragments.map(fragment => fragment.ref.corpus)).join(",")
      }
    }], resultMetadata);
  }

  private async executeOverview(request: ContextToolRequest<DocsOverviewToolArgs>): Promise<ContextToolResult> {
    const overview = await this.docsContext.overviewTool({
      maxItems: request.limits.maxItems ?? DEFAULT_OVERVIEW_ITEMS,
      maxCharsPerItem: Math.min(request.limits.maxChars ?? 1200, 3000)
    });
    if (!overview) {
      return createContextToolFailure(request, {
        code: "unavailable",
        message: "No configured documentation corpus is available.",
        retryable: true
      });
    }
    if (!overview.fragments.length) {
      return createContextToolFailure(request, {
        code: "notFound",
        message: "Documentation corpus has no overview fragments.",
        retryable: true
      }, [], {
        roots: overview.roots.map((root) => root.root),
        corpora: overview.corpora.length
      });
    }

    const text = trimToolBlock(formatOverviewBlock(overview.fragments), request.limits.maxChars ?? DEFAULT_BLOCK_CHARS);
    return createContextToolSuccess(request, [{
      source: DOCS_SOURCE,
      text,
      matchCount: overview.fragments.length,
      mode: "overview",
      metadata: {
        roots: overview.roots.length,
        corpora: overview.corpora.length,
        truncated: text.endsWith("…") || overview.fragments.some((fragment) => fragment.truncated)
      },
      origin: {
        toolName: request.toolName,
        requestId: request.id,
        root: overview.roots.map((root) => root.root).join(";"),
        corpus: unique(overview.fragments.map((fragment) => fragment.ref.corpus)).join(",")
      }
    }], {
      roots: overview.roots.map((root) => root.root),
      corpora: overview.corpora.length,
      fragments: overview.fragments.length,
      query: request.args.query
    });
  }
}

function formatSearchBlock(search: DocsToolSearchResult): string {
  return [
    "[DOCS TOOL: search]",
    `Query: ${search.query}`,
    "Use these candidates only as an index. Call/read a specific fragment before relying on details that are not in the preview.",
    "",
    ...search.fragments.map((fragment, index) => formatFragmentRef(index + 1, fragment))
  ].join("\n");
}

function formatReadBlock(read: DocsToolReadResult, introduction = "Use these documentation fragments as authoritative for the current answer. Do not mention this service block unless the user asks about sources.", versionNotes: readonly string[] = []): string {
  return [
    "[DOCS TOOL: read]",
    introduction,
    "",
    ...read.fragments.map((fragment, index) => [
      formatFragmentRef(index + 1, fragment.ref),
      ...(versionNotes[index] ? [versionNotes[index]] : []),
      fragment.text
    ].join("\n"))
  ].join("\n\n---\n\n");
}

function formatOverviewBlock(fragments: DocsToolReadResult["fragments"]): string {
  return [
    "[DOCS TOOL: overview]",
    "This is a limited overview slice of the configured documentation corpus, not the full corpus.",
    "",
    ...fragments.map((fragment, index) => [
      formatFragmentRef(index + 1, fragment.ref),
      fragment.text
    ].join("\n"))
  ].join("\n\n---\n\n");
}

function formatFragmentRef(index: number, fragment: DocsToolFragmentRef): string {
  return [
    `${index}. ${fragment.title || "Документация"}`,
    `   id: ${fragment.id}`,
    `   corpus: ${fragment.corpusLabel} (${fragment.corpus})`,
    fragment.kind ? `   kind: ${fragment.kind}` : "",
    fragment.breadcrumbs.length ? `   section: ${fragment.breadcrumbs.join(" > ")}` : "",
    fragment.sourcePath ? `   source: ${fragment.sourcePath}` : "",
    fragment.score !== undefined ? `   score: ${Math.round(fragment.score)}` : "",
    fragment.preview ? `   preview: ${fragment.preview}` : ""
  ].filter(Boolean).join("\n");
}

function normalizeQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSymbolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().normalize("NFC");
    const key = name.toLowerCase();
    if (!name || name.length > 200 || !SYMBOL_PATTERN.test(name) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_SYMBOLS) break;
  }
  return names;
}

function titleMatchesSymbol(title: string, symbol: string): boolean {
  // Compare the declared heading identifier, not parameter names, generic arguments or prose mentions.
  const heading = title.trim().normalize("NFC").replace(/^#{1,6}\s+/u, "")
    .replace(/^(?:тип|класс|интерфейс|структура|перечисление|метод|свойство|пространство им[её]н|компонент интерфейса|type|class|interface component|interface|structure|enum|method|property|namespace)\s*:?\s+(?=[\p{L}_`"«])/iu, "");
  return TITLE_SYMBOL_PATTERN.exec(heading)?.[1].toLowerCase() === symbol.toLowerCase();
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

function trimToolBlock(value: string, maxChars: number): string {
  const limit = Math.max(1000, Math.min(20_000, Math.floor(maxChars)));
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function metadataFromSearch(search: DocsToolSearchResult): Record<string, unknown> {
  return {
    query: search.query,
    roots: search.roots.map((root) => root.root),
    rootCount: search.roots.length,
    fragments: search.fragments.length,
    totalAvailableFragments: search.totalAvailableFragments,
    corpora: unique(search.fragments.map((fragment) => fragment.corpus))
  };
}

function metadataFromRead(read: DocsToolReadResult): Record<string, unknown> {
  return {
    roots: read.roots.map((root) => root.root),
    rootCount: read.roots.length,
    fragments: read.fragments.length,
    corpora: unique(read.fragments.map((fragment) => fragment.ref.corpus))
  };
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

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { ProjectContextDetails, SidebarSnapshot } from "./types";

interface ProjectIndexFile {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
  language: string;
  symbols: string[];
  chunkIds: string[];
}

interface ProjectIndexChunk {
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  textPreview: string;
  symbols: string[];
  keywords: string[];
  scoreHints: string[];
}

interface ProjectIndex {
  version: 2;
  workspaceRoot: string;
  updatedAt: string;
  files: ProjectIndexFile[];
  chunks: ProjectIndexChunk[];
}

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

interface IndexedFileResult {
  file: ProjectIndexFile;
  chunks: ProjectIndexChunk[];
}

interface ProjectContextBuildStats {
  totalFiles: number;
  totalChunks: number;
  reusedFiles: number;
  indexedFiles: number;
  removedFiles: number;
  skippedFiles: number;
}

interface ScoredChunk {
  chunk: ProjectIndexChunk;
  score: number;
}

type ProjectToolErrorCode = "invalidRequest" | "notFound" | "tooLarge" | "unsafePath" | "unavailable";

export interface ProjectContextResult {
  text?: string;
  sourcePath?: string;
  matchCount: number;
  mode?: "matched" | "fallback" | "skipped";
  score?: number;
  metadata?: Record<string, unknown>;
  status: SidebarSnapshot["projectContext"];
}

export interface ProjectToolChunkRef {
  readonly chunkId: string;
  readonly path: string;
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbols: readonly string[];
  readonly keywords: readonly string[];
  readonly score: number;
  readonly preview: string;
}

export interface ProjectToolSearchResult {
  readonly query: string;
  readonly workspaceRoot: string;
  readonly indexPath: string;
  readonly updatedAt: string;
  readonly totalFiles: number;
  readonly totalChunks: number;
  readonly chunks: readonly ProjectToolChunkRef[];
}

export interface ProjectToolReadFileResult {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly language: string;
  readonly size: number;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly fromOpenDocument: boolean;
}

export interface ProjectToolSymbolRef {
  readonly name: string;
  readonly path: string;
  readonly language: string;
  readonly chunkId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly preview: string;
}

export interface ProjectToolSymbolsResult {
  readonly query?: string;
  readonly path?: string;
  readonly workspaceRoot: string;
  readonly indexPath: string;
  readonly updatedAt: string;
  readonly totalFiles: number;
  readonly totalChunks: number;
  readonly symbols: readonly ProjectToolSymbolRef[];
}

export class ProjectToolError extends Error {
  constructor(
    readonly code: ProjectToolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProjectToolError";
  }
}

const INDEX_VERSION = 2;
const MAX_INDEX_FILES = 1200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_TOOL_READ_BYTES = 200 * 1024;
const MAX_PROJECT_TOOL_READ_CHARS = 24_000;
const MAX_CONTEXT_CHUNKS = 8;
const MAX_OVERVIEW_CONTEXT_CHUNKS = 5;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_CHUNK_CONTEXT_CHARS = 1800;
const MAX_SYMBOLS = 80;
const MIN_RELEVANCE_SCORE = 8;
const CHUNK_TARGET_LINES = 120;
const CHUNK_OVERLAP_LINES = 12;
const CHUNK_MAX_CHARS = 8 * 1024;

const STOP_WORDS = new Set([
  "а",
  "в",
  "во",
  "и",
  "или",
  "на",
  "но",
  "по",
  "про",
  "с",
  "со",
  "у",
  "что",
  "как",
  "это",
  "мне",
  "для",
  "там",
  "тут",
  "тебя",
  "меня",
  "привет",
  "спасибо",
  "пока",
  "ок",
  "окей",
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "how",
  "what",
  "hello",
  "thanks"
]);

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".turbo",
  ".vscode-test",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor"
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".webp",
  ".zip"
]);

export class ProjectContextService implements vscode.Disposable {
  private cache: ProjectIndex | undefined;
  private cachePath: string | undefined;
  private dirty = true;
  private watcher: vscode.FileSystemWatcher | undefined;
  private lastUsedChunks: ProjectContextDetails["lastUsedChunks"] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configRoot: string,
    private readonly logger: Logger
  ) {}

  async buildContext(prompt: string, profileId: string | undefined): Promise<ProjectContextResult> {
    if (!profileId) {
      this.logger.info("Project context skipped: Codex profile is not selected.");
      return {
        matchCount: 0,
        status: { status: "disabled", label: "Проектный контекст недоступен: профиль не выбран" }
      };
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.info("Project context skipped: workspace folder is not available.");
      return {
        matchCount: 0,
        status: { status: "disabled", label: "Проектный контекст недоступен: workspace не найден" }
      };
    }

    try {
      const startedAt = Date.now();
      const { index, indexPath, stats } = await this.ensureIndex(profileId, workspaceRoot);
      const selection = selectRelevantChunks(index, prompt);
      const matches = selection.chunks.slice(0, MAX_CONTEXT_CHUNKS);
      this.lastUsedChunks = matches.map((item) => ({
        path: item.chunk.path,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
        symbols: item.chunk.symbols.slice(0, 8),
        score: Math.round(item.score)
      }));

      if (!matches.length) {
        this.logger.info(
          `Project context skipped: no relevant chunks found. indexFiles=${index.files.length}, chunks=${index.chunks.length}.`
        );
        return {
          matchCount: 0,
          sourcePath: indexPath,
          mode: "skipped",
          status: { status: "active", label: `Проектный контекст активен: ${index.files.length} файлов, ${index.chunks.length} чанков` },
          metadata: {
            indexVersion: INDEX_VERSION,
            files: index.files.length,
            chunks: index.chunks.length
          }
        };
      }

      const text = formatProjectContext(workspaceRoot, matches, selection.mode);
      const elapsed = Date.now() - startedAt;
      this.logger.info(
        `Project context v2 ${selection.mode === "fallback" ? "fallback added" : "added"}: ` +
        `chunks=${matches.length}, indexFiles=${index.files.length}, indexChunks=${index.chunks.length}, ` +
        `indexed=${stats.indexedFiles}, reused=${stats.reusedFiles}, removed=${stats.removedFiles}, elapsed=${elapsed}ms.`
      );
      if (elapsed > 1000) {
        this.logger.warn(`Project context v2 slow path: ${elapsed}ms.`);
      }
      return {
        text,
        sourcePath: indexPath,
        matchCount: matches.length,
        mode: selection.mode,
        score: matches[0]?.score,
        status: { status: "active", label: `Проектный контекст активен: ${index.files.length} файлов, ${index.chunks.length} чанков` },
        metadata: {
          indexVersion: INDEX_VERSION,
          files: index.files.length,
          chunks: index.chunks.length,
          selectedChunks: matches.length
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Project context skipped: ${message}.`);
      return {
        matchCount: 0,
        status: { status: "error", label: "Проектный контекст недоступен" }
      };
    }
  }

  async getDetails(profileId: string | undefined): Promise<ProjectContextDetails> {
    if (!profileId) {
      return {
        kind: "project",
        status: "disabled",
        label: "Профиль Codex не выбран",
        files: [],
        count: 0,
        error: "Индекс проекта недоступен: профиль Codex не выбран."
      };
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        kind: "project",
        status: "disabled",
        label: "Workspace не найден",
        files: [],
        count: 0,
        error: "Индекс проекта недоступен: workspace не найден."
      };
    }

    const indexPath = this.indexPath(profileId, workspaceRoot);
    try {
      let index: ProjectIndex | undefined;
      if (this.cachePath === indexPath && this.cache) {
        index = this.cache;
      } else {
        const raw = await fs.promises.readFile(indexPath, "utf8");
        index = normalizeIndex(JSON.parse(raw), workspaceRoot);
      }

      if (!index) {
        return {
          kind: "project",
          status: "error",
          label: "Индекс проекта поврежден",
          workspaceRoot,
          indexPath,
          version: INDEX_VERSION,
          files: [],
          count: 0,
          chunkCount: 0,
          dirty: this.dirty,
          lastUsedChunks: this.lastUsedChunks,
          error: "Файл project-index-v2.json найден, но его формат не подходит текущему workspace."
        };
      }

      return {
        kind: "project",
        status: this.dirty ? "indexing" : "active",
        label: `Проектный контекст активен: ${index.files.length} файлов, ${index.chunks.length} чанков`,
        workspaceRoot,
        indexPath,
        version: index.version,
        updatedAt: index.updatedAt,
        dirty: this.dirty,
        chunkCount: index.chunks.length,
        lastUsedChunks: this.lastUsedChunks,
        files: index.files.map((file) => file.path).sort((left, right) => left.localeCompare(right)),
        count: index.files.length
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          kind: "project",
          status: "notIndexed",
          label: "Индекс проекта еще не собран",
          workspaceRoot,
          indexPath,
          version: INDEX_VERSION,
          files: [],
          count: 0,
          chunkCount: 0,
          dirty: true,
          lastUsedChunks: this.lastUsedChunks
        };
      }

      return {
        kind: "project",
        status: "error",
        label: "Индекс проекта недоступен",
        workspaceRoot,
        indexPath,
        version: INDEX_VERSION,
        files: [],
        count: 0,
        chunkCount: 0,
        dirty: this.dirty,
        lastUsedChunks: this.lastUsedChunks,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async searchTool(profileId: string | undefined, query: string, options: {
    readonly maxItems?: number;
    readonly maxPreviewChars?: number;
  } = {}): Promise<ProjectToolSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new ProjectToolError("invalidRequest", "project.search requires a non-empty query.");
    }

    const { index, indexPath, workspaceRoot } = await this.ensureToolIndex(profileId);
    const maxItems = clampInteger(options.maxItems, 1, 30, 8);
    const maxPreviewChars = clampInteger(options.maxPreviewChars, 120, 1600, 420);
    const selection = selectRelevantChunks(index, normalizedQuery);
    const scored = selection.chunks.length
      ? selection.chunks
      : selectOverviewChunks(index).slice(0, maxItems);

    const chunks = scored.slice(0, maxItems).map((item) => toProjectToolChunkRef(index, item, maxPreviewChars));
    this.lastUsedChunks = chunks.map((chunk) => ({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbols: chunk.symbols.slice(0, 8),
      score: Math.round(chunk.score)
    }));

    return {
      query: normalizedQuery,
      workspaceRoot,
      indexPath,
      updatedAt: index.updatedAt,
      totalFiles: index.files.length,
      totalChunks: index.chunks.length,
      chunks
    };
  }

  async readFileTool(profileId: string | undefined, options: {
    readonly filePath: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly maxChars?: number;
    readonly maxBytes?: number;
  }): Promise<ProjectToolReadFileResult> {
    const { workspaceRoot } = await this.ensureToolIndex(profileId);
    const resolved = await resolveWorkspaceFilePathSafe(workspaceRoot, options.filePath);
    if (!resolved) {
      throw new ProjectToolError("unsafePath", "project.readFile can read only files inside the active workspace.");
    }
    if (isDeniedProjectPath(path.basename(resolved.relativePath), resolved.relativePath)) {
      throw new ProjectToolError("unsafePath", "project.readFile denied this path by workspace safety rules.");
    }
    if (BINARY_EXTENSIONS.has(path.extname(resolved.relativePath).toLowerCase())) {
      throw new ProjectToolError("unsafePath", "project.readFile denied a binary file extension.");
    }

    let size = 0;
    let text: string;
    let fromOpenDocument = false;
    const openDocument = vscode.workspace.textDocuments.find((document) =>
      document.uri.scheme === "file" && sameFilePath(document.uri.fsPath, resolved.absolutePath)
    );
    if (openDocument) {
      text = openDocument.getText();
      size = Buffer.byteLength(text, "utf8");
      fromOpenDocument = true;
    } else {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.absolutePath);
      } catch {
        throw new ProjectToolError("notFound", "Requested workspace file was not found.");
      }
      if (!stat.isFile()) {
        throw new ProjectToolError("invalidRequest", "Requested workspace path is not a file.");
      }
      size = stat.size;
      const maxBytes = clampInteger(options.maxBytes, 1024, MAX_PROJECT_TOOL_READ_BYTES, MAX_PROJECT_TOOL_READ_BYTES);
      if (size <= 0 || size > maxBytes) {
        throw new ProjectToolError("tooLarge", "Requested workspace file is empty or exceeds the read limit.");
      }
      const buffer = await fs.promises.readFile(resolved.absolutePath);
      if (!isProbablyText(buffer)) {
        throw new ProjectToolError("unsafePath", "Requested workspace file is not text.");
      }
      text = buffer.toString("utf8");
    }

    const maxChars = clampInteger(options.maxChars, 1000, MAX_PROJECT_TOOL_READ_CHARS, MAX_PROJECT_TOOL_READ_CHARS);
    const lines = text.split(/\r?\n/);
    const requestedStart = clampInteger(options.startLine, 1, Math.max(1, lines.length), 1);
    const requestedEnd = clampInteger(options.endLine, requestedStart, Math.max(requestedStart, lines.length), lines.length);
    const selectedText = lines.slice(requestedStart - 1, requestedEnd).join("\n");
    const truncatedText = selectedText.length > maxChars ? `${selectedText.slice(0, maxChars - 1)}…` : selectedText;

    return {
      workspaceRoot,
      path: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      language: languageFromPath(resolved.relativePath),
      size,
      totalLines: lines.length,
      startLine: requestedStart,
      endLine: requestedEnd,
      text: truncatedText,
      truncated: truncatedText.length < selectedText.length,
      fromOpenDocument
    };
  }

  async listSymbolsTool(profileId: string | undefined, options: {
    readonly query?: string;
    readonly filePath?: string;
    readonly maxItems?: number;
  } = {}): Promise<ProjectToolSymbolsResult> {
    const { index, indexPath, workspaceRoot } = await this.ensureToolIndex(profileId);
    const maxItems = clampInteger(options.maxItems, 1, 120, 60);
    const normalizedQuery = options.query?.trim();
    const terms = normalizedQuery ? tokenize(normalizedQuery) : [];
    const normalizedPath = options.filePath ? normalizeWorkspaceRelativePath(workspaceRoot, options.filePath) : undefined;
    if (options.filePath && !normalizedPath) {
      throw new ProjectToolError("unsafePath", "project.listSymbols can filter only paths inside the active workspace.");
    }

    const fileLanguages = new Map(index.files.map((file) => [file.path, file.language]));
    const symbols = new Map<string, ProjectToolSymbolRef>();
    for (const chunk of index.chunks) {
      if (normalizedPath && chunk.path !== normalizedPath) {
        continue;
      }
      for (const symbol of chunk.symbols) {
        const score = scoreSymbol(symbol, chunk, terms, normalizedQuery ?? "");
        if (terms.length && score <= 0) {
          continue;
        }
        const key = `${chunk.path}:${symbol}`;
        const existing = symbols.get(key);
        if (existing && existing.score >= score) {
          continue;
        }
        symbols.set(key, {
          name: symbol,
          path: chunk.path,
          language: fileLanguages.get(chunk.path) ?? languageFromPath(chunk.path),
          chunkId: chunk.chunkId,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score,
          preview: trimText(chunk.textPreview, 260)
        });
      }
    }

    return {
      query: normalizedQuery,
      path: normalizedPath,
      workspaceRoot,
      indexPath,
      updatedAt: index.updatedAt,
      totalFiles: index.files.length,
      totalChunks: index.chunks.length,
      symbols: [...symbols.values()]
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.name.localeCompare(right.name))
        .slice(0, maxItems)
    };
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private async ensureToolIndex(profileId: string | undefined): Promise<{
    index: ProjectIndex;
    indexPath: string;
    workspaceRoot: string;
  }> {
    if (!profileId) {
      throw new ProjectToolError("unavailable", "Codex profile is not selected.");
    }
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new ProjectToolError("unavailable", "Workspace folder is not available.");
    }
    const { index, indexPath } = await this.ensureIndex(profileId, workspaceRoot);
    return { index, indexPath, workspaceRoot };
  }

  private async ensureIndex(profileId: string, workspaceRoot: string): Promise<{
    index: ProjectIndex;
    indexPath: string;
    stats: ProjectContextBuildStats;
  }> {
    this.ensureWatcher();

    const indexPath = this.indexPath(profileId, workspaceRoot);
    if (this.cachePath !== indexPath) {
      this.cache = await this.loadIndex(indexPath, workspaceRoot);
      this.cachePath = indexPath;
      this.dirty = true;
    }

    if (this.cache && !this.dirty) {
      return {
        index: this.cache,
        indexPath,
        stats: {
          totalFiles: this.cache.files.length,
          totalChunks: this.cache.chunks.length,
          reusedFiles: this.cache.files.length,
          indexedFiles: 0,
          removedFiles: 0,
          skippedFiles: 0
        }
      };
    }

    const refreshed = await this.refreshIndex(this.cache, workspaceRoot);
    this.cache = refreshed.index;
    this.cachePath = indexPath;
    this.dirty = false;
    await this.writeIndex(indexPath, refreshed.index);
    return {
      index: refreshed.index,
      indexPath,
      stats: refreshed.stats
    };
  }

  private async loadIndex(indexPath: string, workspaceRoot: string): Promise<ProjectIndex | undefined> {
    try {
      const raw = await fs.promises.readFile(indexPath, "utf8");
      const parsed = normalizeIndex(JSON.parse(raw), workspaceRoot);
      if (parsed) {
        this.logger.info(`Project index v2 loaded lazily: ${parsed.files.length} files, ${parsed.chunks.length} chunks from ${indexPath}.`);
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.logger.info("Project index v2 not found, will build lazily.");
        return undefined;
      }
      this.logger.warn(`Project index v2 read failed, will rebuild: ${error instanceof Error ? error.message : String(error)}.`);
      return undefined;
    }
  }

  private async refreshIndex(existing: ProjectIndex | undefined, workspaceRoot: string): Promise<{
    index: ProjectIndex;
    stats: ProjectContextBuildStats;
  }> {
    const startedAt = Date.now();
    const scanned = await scanWorkspace(workspaceRoot);
    const previousFiles = new Map((existing?.files ?? []).map((file) => [file.path, file]));
    const previousChunks = new Map((existing?.chunks ?? []).map((chunk) => [chunk.chunkId, chunk]));
    const files: ProjectIndexFile[] = [];
    const chunks: ProjectIndexChunk[] = [];
    let reusedFiles = 0;
    let indexedFiles = 0;
    let skippedFiles = scanned.skippedFiles;

    for (const file of scanned.files) {
      const old = previousFiles.get(file.relativePath);
      if (old && old.mtimeMs === file.mtimeMs && old.size === file.size && old.chunkIds.every((id) => previousChunks.has(id))) {
        files.push(old);
        for (const chunkId of old.chunkIds) {
          const chunk = previousChunks.get(chunkId);
          if (chunk) {
            chunks.push(chunk);
          }
        }
        reusedFiles += 1;
        continue;
      }

      const indexed = await indexFile(file);
      if (!indexed) {
        skippedFiles += 1;
        continue;
      }
      files.push(indexed.file);
      chunks.push(...indexed.chunks);
      indexedFiles += 1;
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    chunks.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine);
    const removedFiles = Math.max(0, previousFiles.size - reusedFiles);
    const elapsed = Date.now() - startedAt;
    this.logger.info(
      `Project index v2 refreshed: files=${files.length}, chunks=${chunks.length}, indexed=${indexedFiles}, reused=${reusedFiles}, ` +
      `removed=${removedFiles}, skipped=${skippedFiles}, elapsed=${elapsed}ms.`
    );
    if (elapsed > 1000) {
      this.logger.warn(`Project index v2 refresh slow path: ${elapsed}ms.`);
    }

    return {
      index: {
        version: INDEX_VERSION,
        workspaceRoot,
        updatedAt: new Date().toISOString(),
        files,
        chunks
      },
      stats: {
        totalFiles: files.length,
        totalChunks: chunks.length,
        reusedFiles,
        indexedFiles,
        removedFiles,
        skippedFiles
      }
    };
  }

  private async writeIndex(indexPath: string, index: ProjectIndex): Promise<void> {
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
    const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await fs.promises.rename(tempPath, indexPath);
    this.logger.info(`Project index v2 saved: ${indexPath}.`);
  }

  private indexPath(profileId: string, workspaceRoot: string): string {
    return path.join(this.configRoot, "users", profileId, "workspaces", workspaceId(workspaceRoot), "project-index-v2.json");
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }

    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    const markDirty = () => {
      this.dirty = true;
    };
    this.watcher.onDidCreate(markDirty);
    this.watcher.onDidChange(markDirty);
    this.watcher.onDidDelete(markDirty);
    this.logger.info("Project context watcher registered lazily.");
  }
}

async function scanWorkspace(workspaceRoot: string): Promise<{ files: ScannedFile[]; skippedFiles: number }> {
  const files: ScannedFile[] = [];
  let skippedFiles = 0;

  async function walk(directory: string): Promise<void> {
    if (files.length >= MAX_INDEX_FILES) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_INDEX_FILES) {
        break;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(workspaceRoot, absolutePath));
      if (shouldSkipPath(entry.name, relativePath)) {
        skippedFiles += 1;
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        skippedFiles += 1;
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch {
        skippedFiles += 1;
        continue;
      }

      if (stat.size <= 0 || stat.size > MAX_FILE_BYTES || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        skippedFiles += 1;
        continue;
      }

      files.push({
        relativePath,
        absolutePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      });
    }
  }

  await walk(workspaceRoot);
  return { files, skippedFiles };
}

async function indexFile(file: ScannedFile): Promise<IndexedFileResult | undefined> {
  const buffer = await fs.promises.readFile(file.absolutePath);
  if (!isProbablyText(buffer)) {
    return undefined;
  }

  const text = buffer.toString("utf8");
  const hash = crypto.createHash("sha1").update(buffer).digest("hex");
  const language = languageFromPath(file.relativePath);
  const symbols = extractSymbols(text);
  const chunks = chunkFile(file.relativePath, text, language, symbols, hash);
  if (!chunks.length) {
    return undefined;
  }

  return {
    file: {
      path: file.relativePath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      hash,
      language,
      symbols,
      chunkIds: chunks.map((chunk) => chunk.chunkId)
    },
    chunks
  };
}

function chunkFile(relativePath: string, text: string, language: string, fileSymbols: string[], hash: string): ProjectIndexChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: ProjectIndexChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < lines.length) {
    let end = Math.min(lines.length, start + CHUNK_TARGET_LINES);
    let chunkText = lines.slice(start, end).join("\n");
    while (chunkText.length > CHUNK_MAX_CHARS && end > start + 20) {
      end -= 10;
      chunkText = lines.slice(start, end).join("\n");
    }

    const localSymbols = extractSymbols(chunkText);
    const symbols = uniqueStrings([...localSymbols, ...fileSymbols.filter((symbol) => chunkText.includes(symbol)).slice(0, 12)]).slice(0, 24);
    const keywords = extractKeywords(relativePath, chunkText, symbols);
    const chunkId = `${hash.slice(0, 12)}-${chunkIndex}`;
    chunks.push({
      chunkId,
      path: relativePath,
      startLine: start + 1,
      endLine: end,
      textPreview: trimText(chunkText, MAX_CHUNK_CONTEXT_CHARS),
      symbols,
      keywords,
      scoreHints: buildScoreHints(relativePath, language, symbols, keywords)
    });

    if (end >= lines.length) {
      break;
    }
    start = Math.max(end - CHUNK_OVERLAP_LINES, start + 1);
    chunkIndex += 1;
  }

  return chunks;
}

function selectRelevantChunks(index: ProjectIndex, prompt: string): { chunks: ScoredChunk[]; mode: "matched" | "fallback" } {
  const terms = tokenize(prompt);
  if (!terms.length) {
    return shouldUseOverviewFallback(prompt)
      ? { chunks: selectOverviewChunks(index).slice(0, MAX_OVERVIEW_CONTEXT_CHUNKS), mode: "fallback" }
      : { chunks: [], mode: "matched" };
  }

  const explicitProjectBoost = isExplicitProjectPrompt(prompt) ? 16 : 0;
  const scored = index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms, prompt) + explicitProjectBoost }))
    .filter((item) => item.score >= MIN_RELEVANCE_SCORE)
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine);

  if (scored.length) {
    return { chunks: dedupeChunks(scored), mode: "matched" };
  }

  return shouldUseOverviewFallback(prompt)
    ? { chunks: selectOverviewChunks(index).slice(0, MAX_OVERVIEW_CONTEXT_CHUNKS), mode: "fallback" }
    : { chunks: [], mode: "matched" };
}

function selectOverviewChunks(index: ProjectIndex): ScoredChunk[] {
  return index.chunks
    .map((chunk) => ({ chunk, score: overviewScore(chunk) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine);
}

function overviewScore(chunk: ProjectIndexChunk): number {
  const filePath = chunk.path.toLowerCase();
  let score = 0;

  if (/(^|\/)(readme|package|tsconfig|manifest|project|config)\./i.test(chunk.path) || /(^|\/)(readme|package|tsconfig|manifest|project|config)$/i.test(chunk.path)) {
    score += 100;
  }
  if (filePath.startsWith("src/")) {
    score += 60;
  }
  if (/\.(json|md|xml|yaml|yml|ts|tsx|js|bsl|os)$/i.test(chunk.path)) {
    score += 35;
  }
  if (chunk.symbols.length) {
    score += 15;
  }
  score += Math.max(0, 20 - filePath.split("/").length);

  return score;
}

function scoreChunk(chunk: ProjectIndexChunk, terms: string[], prompt: string): number {
  const filePath = chunk.path.toLowerCase();
  const symbols = chunk.symbols.join(" ").toLowerCase();
  const keywords = chunk.keywords.join(" ").toLowerCase();
  const hints = chunk.scoreHints.join(" ").toLowerCase();
  const preview = chunk.textPreview.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (filePath.includes(term)) {
      score += explicitPathLike(prompt, term) ? 25 : 10;
    }
    if (symbols.includes(term)) {
      score += 18;
    }
    if (keywords.includes(term)) {
      score += 10;
    }
    if (hints.includes(term)) {
      score += 6;
    }
    if (preview.includes(term)) {
      score += term.length >= 10 ? 6 : 1;
    }
  }

  return score;
}

function scoreSymbol(symbol: string, chunk: ProjectIndexChunk, terms: string[], prompt: string): number {
  if (!terms.length) {
    return 1;
  }

  const name = symbol.toLowerCase();
  const filePath = chunk.path.toLowerCase();
  const preview = chunk.textPreview.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) {
      score += 80;
    } else if (name.includes(term)) {
      score += 35;
    }
    if (filePath.includes(term)) {
      score += explicitPathLike(prompt, term) ? 24 : 8;
    }
    if (preview.includes(term)) {
      score += term.length >= 8 ? 8 : 2;
    }
  }
  return score;
}

function toProjectToolChunkRef(index: ProjectIndex, item: ScoredChunk, maxPreviewChars: number): ProjectToolChunkRef {
  const file = index.files.find((entry) => entry.path === item.chunk.path);
  return {
    chunkId: item.chunk.chunkId,
    path: item.chunk.path,
    language: file?.language ?? languageFromPath(item.chunk.path),
    startLine: item.chunk.startLine,
    endLine: item.chunk.endLine,
    symbols: item.chunk.symbols.slice(0, 12),
    keywords: item.chunk.keywords.slice(0, 16),
    score: Math.round(item.score),
    preview: trimText(item.chunk.textPreview, maxPreviewChars)
  };
}

function formatProjectContext(workspaceRoot: string, chunks: ScoredChunk[], mode: "matched" | "fallback"): string {
  const fragments: string[] = [];
  let total = 0;

  for (const item of chunks) {
    const chunk = item.chunk;
    const fragment = [
      `Файл: ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
      chunk.symbols.length ? `Символы: ${chunk.symbols.slice(0, 16).join(", ")}` : "",
      chunk.keywords.length ? `Ключевые слова: ${chunk.keywords.slice(0, 18).join(", ")}` : "",
      `Score: ${Math.round(item.score)}`,
      chunk.textPreview
    ].filter(Boolean).join("\n");

    if (total + fragment.length > MAX_CONTEXT_CHARS) {
      break;
    }
    fragments.push(fragment);
    total += fragment.length;
  }

  return [
    mode === "fallback" ? "[Проектный индекс V2: краткий обзор]" : "[Проектный индекс V2: релевантные чанки]",
    `Корень workspace: ${workspaceRoot}`,
    `В контекст добавлено чанков: ${fragments.length}. Это ограниченный срез проекта, а не полный проект.`,
    "Используй эти сведения только если они помогают ответить на последний запрос пользователя.",
    "Не утверждай, что изучил весь проект, если в блоке передан только ограниченный срез.",
    "Не упоминай наличие этого служебного блока, если пользователь прямо не спрашивает об источниках.",
    "",
    fragments.join("\n\n---\n\n")
  ].join("\n");
}

function shouldUseOverviewFallback(prompt: string): boolean {
  const normalized = prompt.toLowerCase().normalize("NFKC");
  return /(?:структур|архитектур|обзор|ознаком|прочитай\s+проект|изучи\s+проект|как\s+устроен|что\s+в\s+проекте|весь\s+проект|реализовано|где\s+находится|найди\s+где)/u.test(normalized);
}

function isExplicitProjectPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().normalize("NFKC");
  return /(?:проверь|найди|посмотри|изучи|прочитай|где|в проекте|по проекту|в коде|в файлах|реализовано|используется)/u.test(normalized);
}

function explicitPathLike(prompt: string, term: string): boolean {
  return prompt.includes("/") || prompt.includes("\\") || term.includes("/") || term.includes("\\") || /\.[a-z0-9]+$/i.test(term);
}

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:Функция|Процедура)\s+([A-Za-zА-Яа-яЁё0-9_]+)/g,
    /\b(?:function|procedure)\s+([A-Za-zА-Яа-яЁё0-9_]+)/gi,
    /\b(?:Структура|Справочник|Форма|Модуль|Перечисление|Подсистема|КомпонентИнтерфейса)\s+([A-Za-zА-Яа-яЁё0-9_:.]+)/g,
    /\b(?:structure|catalog|form|module|enum|subsystem)\s+([A-Za-zА-Яа-яЁё0-9_:.]+)/gi,
    /(?:Имя|Name)\s*[:=]\s*["']?([A-Za-zА-Яа-яЁё0-9_:.]+)/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        symbols.add(match[1]);
      }
      if (symbols.size >= MAX_SYMBOLS) {
        return [...symbols];
      }
    }
  }

  return [...symbols];
}

function extractKeywords(filePath: string, text: string, symbols: string[]): string[] {
  const fromPath = filePath.split(/[/.\\_-]+/u).filter((item) => item.length >= 3);
  const fromText = tokenize(text).slice(0, 40);
  return uniqueStrings([...fromPath, ...symbols, ...fromText]).slice(0, 60);
}

function buildScoreHints(filePath: string, language: string, symbols: string[], keywords: string[]): string[] {
  const extension = path.extname(filePath).replace(/^\./, "");
  return uniqueStrings([
    filePath,
    language,
    extension,
    ...symbols,
    ...keywords.slice(0, 20)
  ]).slice(0, 80);
}

function dedupeChunks(items: ScoredChunk[]): ScoredChunk[] {
  const seen = new Set<string>();
  const result: ScoredChunk[] = [];
  for (const item of items) {
    if (seen.has(item.chunk.chunkId)) {
      continue;
    }
    seen.add(item.chunk.chunkId);
    result.push(item);
  }
  return result;
}

function shouldSkipPath(name: string, relativePath: string): boolean {
  return isDeniedProjectPath(name, relativePath);
}

function isDeniedProjectPath(name: string, relativePath: string): boolean {
  if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILE_NAMES.has(name)) {
    return true;
  }

  const normalized = relativePath.toLowerCase();
  const segments = normalized.split("/");
  return segments.some((segment) => EXCLUDED_DIRS.has(segment)) ||
    normalized.endsWith(".env") ||
    normalized.includes("/.env.") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".pfx") ||
    normalized.endsWith(".crt") ||
    normalized.endsWith(".cer") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("token") ||
    normalized.includes("codex-home");
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) {
    return false;
  }

  const decoded = sample.toString("utf8");
  const replacements = decoded.match(/\uFFFD/g)?.length ?? 0;
  return replacements <= Math.max(2, decoded.length * 0.02);
}

function languageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".bsl": "1C BSL",
    ".css": "CSS",
    ".html": "HTML",
    ".js": "JavaScript",
    ".json": "JSON",
    ".md": "Markdown",
    ".os": "1C Element",
    ".scss": "SCSS",
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML"
  };
  return map[ext] ?? ext.replace(/^\./, "").toUpperCase();
}

function normalizeIndex(value: unknown, workspaceRoot: string): ProjectIndex | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (object.version !== INDEX_VERSION || object.workspaceRoot !== workspaceRoot || !Array.isArray(object.files) || !Array.isArray(object.chunks)) {
    return undefined;
  }

  const chunks = object.chunks
    .map(normalizeIndexChunk)
    .filter((chunk): chunk is ProjectIndexChunk => Boolean(chunk));
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  const files = object.files
    .map((item) => normalizeIndexFile(item, chunkIds))
    .filter((file): file is ProjectIndexFile => Boolean(file));
  return {
    version: INDEX_VERSION,
    workspaceRoot,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : new Date().toISOString(),
    files,
    chunks
  };
}

function normalizeIndexFile(value: unknown, chunkIds: Set<string>): ProjectIndexFile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  if (typeof object.path !== "string" || typeof object.hash !== "string") {
    return undefined;
  }

  const fileChunkIds = Array.isArray(object.chunkIds)
    ? object.chunkIds.filter((item): item is string => typeof item === "string" && chunkIds.has(item))
    : [];
  if (!fileChunkIds.length) {
    return undefined;
  }

  return {
    path: object.path,
    mtimeMs: typeof object.mtimeMs === "number" ? object.mtimeMs : 0,
    size: typeof object.size === "number" ? object.size : 0,
    hash: object.hash,
    language: typeof object.language === "string" ? object.language : "",
    symbols: Array.isArray(object.symbols) ? object.symbols.filter((item): item is string => typeof item === "string") : [],
    chunkIds: fileChunkIds
  };
}

function normalizeIndexChunk(value: unknown): ProjectIndexChunk | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  if (typeof object.chunkId !== "string" || typeof object.path !== "string" || typeof object.textPreview !== "string") {
    return undefined;
  }

  return {
    chunkId: object.chunkId,
    path: object.path,
    startLine: typeof object.startLine === "number" ? object.startLine : 1,
    endLine: typeof object.endLine === "number" ? object.endLine : 1,
    textPreview: object.textPreview,
    symbols: Array.isArray(object.symbols) ? object.symbols.filter((item): item is string => typeof item === "string") : [],
    keywords: Array.isArray(object.keywords) ? object.keywords.filter((item): item is string => typeof item === "string") : [],
    scoreHints: Array.isArray(object.scoreHints) ? object.scoreHints.filter((item): item is string => typeof item === "string") : []
  };
}

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? [];
  return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))].slice(0, 64);
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function workspaceId(workspaceRoot: string): string {
  return crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveWorkspaceFilePath(workspaceRoot: string, filePath: string): { absolutePath: string; relativePath: string } | undefined {
  const raw = filePath.trim();
  if (!raw) {
    return undefined;
  }
  const absolutePath = path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw));
  const relativePath = normalizeWorkspaceRelative(workspaceRoot, absolutePath);
  if (!relativePath) {
    return undefined;
  }
  return { absolutePath, relativePath };
}

async function resolveWorkspaceFilePathSafe(workspaceRoot: string, filePath: string): Promise<{ absolutePath: string; relativePath: string } | undefined> {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, filePath);
  if (!resolved) {
    return undefined;
  }

  try {
    const workspaceRealPath = await fs.promises.realpath(workspaceRoot);
    const fileRealPath = await fs.promises.realpath(resolved.absolutePath);
    const relativePath = normalizeWorkspaceRelative(workspaceRealPath, fileRealPath);
    if (!relativePath) {
      return undefined;
    }
    return {
      absolutePath: fileRealPath,
      relativePath
    };
  } catch {
    throw new ProjectToolError("notFound", "Requested workspace file was not found.");
  }
}

function normalizeWorkspaceRelativePath(workspaceRoot: string, filePath: string): string | undefined {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, filePath);
  return resolved?.relativePath;
}

function normalizeWorkspaceRelative(workspaceRoot: string, absolutePath: string): string | undefined {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return toPosix(relative);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sameFilePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

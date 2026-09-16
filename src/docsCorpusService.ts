import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { DocsCapacityError } from "./docsWorkerProtocol";

export type DocsCorpusFormat = "legacy-pages" | "manifest-jsonl" | "generic-jsonl" | "text-tree";

export interface DocsCorpusFile {
  path: string;
  role: string;
  contentField?: string;
  sectionField?: string;
}

export interface DocsCorpusInfo {
  root: string;
  corpus: string;
  label: string;
  format: DocsCorpusFormat;
  indexPath: string;
  manifestPath?: string;
  files: DocsCorpusFile[];
  priority: number;
}

export interface DocsCorpusDiscovery {
  root: string;
  corpora: DocsCorpusInfo[];
  error?: string;
}

export interface DocsFragment {
  corpus: string;
  corpusLabel: string;
  corpusPriority: number;
  title: string;
  kind: string;
  breadcrumbs: string[];
  sourcePath: string;
  url: string;
  keywords: string[];
  excerpt: string;
  text: string;
  indexPath: string;
}

export interface LoadedDocsCorpus {
  root: string;
  corpora: DocsCorpusInfo[];
  fragments: DocsFragment[];
}

export interface DocsCorpusFingerprint {
  value: string;
  fileCount: number;
  latestMtimeMs: number;
  totalBytes: number;
}

export interface DocsLoadLimits {
  maxFragments: number;
  maxChars: number;
  maxCorpora: number;
  maxFiles: number;
  maxInputBytes: number;
  maxRecordChars: number;
}

interface DocsLoadBudget {
  limits?: DocsLoadLimits;
  inputBytes: number;
}

export function docsFragmentChars(fragment: DocsFragment): number {
  return fragment.text.length + fragment.excerpt.length + fragment.title.length + fragment.kind.length
    + fragment.sourcePath.length + fragment.url.length + fragment.indexPath.length
    + fragment.corpus.length + fragment.corpusLabel.length
    + fragment.breadcrumbs.reduce((sum, item) => sum + item.length, 0)
    + fragment.keywords.reduce((sum, item) => sum + item.length, 0);
}

interface ManifestFileEntry {
  path?: unknown;
  description?: unknown;
}

interface ManifestRecordShape {
  content_field?: unknown;
  url_field?: unknown;
  section_field?: unknown;
}

interface ManifestJson {
  corpus?: unknown;
  title?: unknown;
  files?: Record<string, ManifestFileEntry | string>;
  record_shapes?: Record<string, ManifestRecordShape>;
}

const LEGACY_HIGH_PRIORITY = path.join("index", "pages.high-priority.jsonl");
const LEGACY_PAGES = path.join("index", "pages.jsonl");
const MAX_DISCOVERY_DEPTH = 4;
const MAX_GENERIC_JSONL_FILES = 64;
const MAX_TEXT_FILES = 160;
const MAX_FRAGMENT_TEXT_CHARS = 8000;
const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_JSONL_FILE_BYTES = 80_000_000;
const MAX_MANIFEST_FILE_BYTES = 1_000_000;

const MANIFEST_PRIMARY_ROLES = ["chunks", "documents"];
const MANIFEST_SECONDARY_ROLES = [
  "operations",
  "schemas",
  "components",
  "extensions",
  "host_modules",
  "entrypoints",
  "config_files",
  "connections"
];
const IGNORED_MANIFEST_ROLES = new Set(["link_index", "stats"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm"]);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", ".cache", "__pycache__"]);
const DENIED_DOC_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);
const DENIED_DOC_EXTENSIONS = new Set([".cer", ".crt", ".der", ".key", ".p12", ".pfx", ".pem"]);

export function discoverDocsCorpora(root: string): DocsCorpusDiscovery {
  const normalizedRoot = path.resolve(root);
  try {
    const stats = fs.statSync(normalizedRoot);
    if (!stats.isDirectory()) {
      return { root: normalizedRoot, corpora: [], error: "Путь к документации должен быть каталогом." };
    }
    if (isDeniedDocsRoot(normalizedRoot)) {
      return { root: normalizedRoot, corpora: [], error: "Каталог документации запрещен правилами безопасности." };
    }
  } catch {
    return { root: normalizedRoot, corpora: [], error: "Каталог документации недоступен." };
  }

  const corpora: DocsCorpusInfo[] = [];
  const legacy = discoverLegacyCorpus(normalizedRoot);
  if (legacy) {
    corpora.push(legacy);
  }

  for (const manifestPath of findManifestPaths(normalizedRoot)) {
    const corpus = parseManifestCorpus(manifestPath);
    if (corpus) {
      corpora.push(corpus);
    }
  }

  if (!corpora.length) {
    corpora.push(...discoverGenericJsonlCorpora(normalizedRoot));
  }

  if (!corpora.length) {
    const textCorpus = discoverTextCorpus(normalizedRoot);
    if (textCorpus) {
      corpora.push(textCorpus);
    }
  }

  const unique = uniqueCorpora(corpora).sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
  return unique.length
    ? { root: normalizedRoot, corpora: unique }
    : {
        root: normalizedRoot,
        corpora: [],
        error: "В каталоге документации не найден поддерживаемый корпус: index/pages*.jsonl, manifest.json, *.jsonl или .md/.txt/.html."
      };
}

export async function loadDocsCorpora(root: string, limits?: DocsLoadLimits): Promise<LoadedDocsCorpus> {
  const discovery = discoverDocsCorpora(root);
  if (discovery.error || !discovery.corpora.length) {
    throw new Error(discovery.error || "Корпус документации не найден.");
  }
  if (limits && discovery.corpora.length > limits.maxCorpora) {
    throw new DocsCapacityError("Too many docs corpora.");
  }
  if (limits && discovery.corpora.reduce((sum, corpus) => sum + corpus.files.length, 0) > limits.maxFiles) {
    throw new DocsCapacityError("Too many docs corpus files.");
  }

  const fragments: DocsFragment[] = [];
  const budget: DocsLoadBudget = { limits, inputBytes: 0 };
  let chars = 0;
  for (const corpus of discovery.corpora) {
    for (const file of corpus.files) {
      const loaded = corpus.format === "text-tree"
        ? await loadTextFile(corpus, file, budget)
        : loadJsonlFile(corpus, file, budget);
      for await (const fragment of loaded) {
        chars += docsFragmentChars(fragment);
        if (limits && (fragments.length >= limits.maxFragments || chars > limits.maxChars)) {
          throw new DocsCapacityError("Docs corpus exceeds the fragment or text budget.");
        }
        fragments.push(fragment);
      }
    }
  }

  if (!fragments.length) {
    throw new Error("Поддерживаемый корпус документации найден, но не содержит пригодных фрагментов.");
  }

  return {
    root: discovery.root,
    corpora: discovery.corpora,
    fragments
  };
}

export function fingerprintDocsCorpora(root: string): DocsCorpusFingerprint | undefined {
  const discovery = discoverDocsCorpora(root);
  if (discovery.error || !discovery.corpora.length) {
    return undefined;
  }

  const normalizedRoot = path.resolve(root);
  const files = new Set<string>();
  for (const corpus of discovery.corpora) {
    files.add(corpus.indexPath);
    if (corpus.manifestPath) {
      files.add(corpus.manifestPath);
    }
    for (const file of corpus.files) {
      files.add(file.path);
    }
  }

  const hash = crypto.createHash("sha256");
  let fileCount = 0;
  let latestMtimeMs = 0;
  let totalBytes = 0;

  for (const filePath of [...files].sort()) {
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        continue;
      }
      fileCount += 1;
      latestMtimeMs = Math.max(latestMtimeMs, stats.mtimeMs);
      totalBytes += stats.size;
      hash.update(path.relative(normalizedRoot, filePath));
      hash.update("\0");
      hash.update(String(stats.size));
      hash.update("\0");
      hash.update(String(stats.mtimeMs));
      hash.update("\0");
      hash.update(String(stats.ctimeMs));
      hash.update("\0");
      hash.update(`${stats.dev}:${stats.ino}:${fs.realpathSync(filePath)}`);
      hash.update("\0");
    } catch {
      hash.update(filePath);
      hash.update("\0missing\0");
    }
  }

  return {
    value: hash.digest("hex").slice(0, 16),
    fileCount,
    latestMtimeMs,
    totalBytes
  };
}

function discoverLegacyCorpus(root: string): DocsCorpusInfo | undefined {
  const highPriority = path.join(root, LEGACY_HIGH_PRIORITY);
  const pages = path.join(root, LEGACY_PAGES);
  const indexPath = fs.existsSync(highPriority) ? highPriority : fs.existsSync(pages) ? pages : "";
  if (!indexPath) {
    return undefined;
  }

  return {
    root,
    corpus: "legacy",
    label: "Legacy normalized docs",
    format: "legacy-pages",
    indexPath,
    files: [{ path: indexPath, role: "pages", contentField: "body_text" }],
    priority: 2
  };
}

function findManifestPaths(root: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const direct = [path.join(root, "manifest.json"), path.join(root, "out", "manifest.json")];
  for (const candidate of direct) {
    pushExisting(candidate, result, seen);
  }

  for (const candidate of findFiles(root, (filePath) => path.basename(filePath) === "manifest.json", MAX_DISCOVERY_DEPTH, 48)) {
    pushExisting(candidate, result, seen);
  }
  return result;
}

function parseManifestCorpus(manifestPath: string): DocsCorpusInfo | undefined {
  try {
    const manifest = JSON.parse(readManifest(manifestPath)) as ManifestJson;
    const files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};
    const manifestRoot = path.dirname(manifestPath);
    const selected: DocsCorpusFile[] = [];

    const primaryRole = MANIFEST_PRIMARY_ROLES.find((role) => manifestFileExists(manifestRoot, files, role));
    if (primaryRole) {
      selected.push(manifestFileFromRole(manifestRoot, files, manifest.record_shapes, primaryRole));
    }

    for (const role of MANIFEST_SECONDARY_ROLES) {
      if (manifestFileExists(manifestRoot, files, role)) {
        selected.push(manifestFileFromRole(manifestRoot, files, manifest.record_shapes, role));
      }
    }

    for (const role of Object.keys(files)) {
      if (primaryRole === role || MANIFEST_SECONDARY_ROLES.includes(role) || IGNORED_MANIFEST_ROLES.has(role)) {
        continue;
      }
      if (manifestFileExists(manifestRoot, files, role)) {
        selected.push(manifestFileFromRole(manifestRoot, files, manifest.record_shapes, role));
      }
    }

    if (!selected.length) {
      return undefined;
    }

    const corpus = getString(manifest.corpus) || path.basename(path.dirname(manifestRoot)) || path.basename(manifestRoot);
    return {
      root: manifestRoot,
      corpus,
      label: getString(manifest.title) || labelForCorpus(corpus),
      format: "manifest-jsonl",
      indexPath: manifestPath,
      manifestPath,
      files: selected,
      priority: corpusPriority(corpus, manifestRoot)
    };
  } catch {
    return undefined;
  }
}

function readManifest(manifestPath: string): string {
  const descriptor = fs.openSync(manifestPath, "r");
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_MANIFEST_FILE_BYTES) throw new Error("Docs manifest is too large.");
    const buffer = Buffer.alloc(Math.min(stats.size + 1, MAX_MANIFEST_FILE_BYTES + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stats.size) throw new Error("Docs manifest changed while reading.");
    return buffer.toString("utf8", 0, size);
  } finally {
    fs.closeSync(descriptor);
  }
}

function manifestFileExists(root: string, files: Record<string, ManifestFileEntry | string>, role: string): boolean {
  const relative = getManifestFilePath(files[role]);
  const resolved = relative ? resolveSafeDocsChildPath(root, relative) : undefined;
  return Boolean(resolved && fs.existsSync(resolved));
}

function manifestFileFromRole(
  root: string,
  files: Record<string, ManifestFileEntry | string>,
  shapes: Record<string, ManifestRecordShape> | undefined,
  role: string
): DocsCorpusFile {
  const shape = shapes?.[role];
  const relative = getManifestFilePath(files[role]);
  const filePath = resolveSafeDocsChildPath(root, relative);
  if (!filePath) {
    throw new Error(`Unsafe docs manifest file path for role ${role}.`);
  }
  return {
    path: filePath,
    role,
    contentField: getString(shape?.content_field),
    sectionField: getString(shape?.section_field)
  };
}

function getManifestFilePath(entry: ManifestFileEntry | string | undefined): string {
  return typeof entry === "string" ? entry : getString(entry?.path);
}

function discoverGenericJsonlCorpora(root: string): DocsCorpusInfo[] {
  const jsonlFiles = findFiles(root, (filePath) => filePath.endsWith(".jsonl"), MAX_DISCOVERY_DEPTH, MAX_GENERIC_JSONL_FILES)
    .filter((filePath) => !path.basename(filePath).startsWith("link-index") && !path.basename(filePath).startsWith("stats"));
  if (!jsonlFiles.length) {
    return [];
  }

  return [{
    root,
    corpus: "generic",
    label: "Generic JSONL documentation",
    format: "generic-jsonl",
    indexPath: jsonlFiles[0],
    files: jsonlFiles.map((filePath) => ({
      path: filePath,
      role: path.basename(filePath, ".jsonl")
    })),
    priority: 1
  }];
}

function discoverTextCorpus(root: string): DocsCorpusInfo | undefined {
  const files = findFiles(root, (filePath) => TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()), MAX_DISCOVERY_DEPTH, MAX_TEXT_FILES);
  if (!files.length) {
    return undefined;
  }

  return {
    root,
    corpus: "text",
    label: "Text documentation",
    format: "text-tree",
    indexPath: root,
    files: files.map((filePath) => ({ path: filePath, role: "text" })),
    priority: 1
  };
}

async function* loadJsonlFile(corpus: DocsCorpusInfo, file: DocsCorpusFile, budget: DocsLoadBudget): AsyncGenerator<DocsFragment> {
  try {
    const safePath = await resolveSafeDocsFilePath(corpus.root, file.path);
    if (!safePath) {
      return;
    }
    const stats = await fs.promises.stat(safePath);
    if (!stats.isFile() || stats.size > MAX_JSONL_FILE_BYTES) {
      return;
    }
    let pending = "";
    let fileBytes = 0;
    const stream = fs.createReadStream(safePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        const value = String(chunk);
        const bytes = Buffer.byteLength(value);
        fileBytes += bytes;
        if (fileBytes > MAX_JSONL_FILE_BYTES) throw new DocsCapacityError("Docs JSONL file grew beyond its byte limit.");
        accountDocsBytes(budget, bytes);
        pending += value;
        let start = 0;
        let newline: number;
        while ((newline = pending.indexOf("\n", start)) >= 0) {
          const line = pending.slice(start, newline);
          checkRecordSize(line, budget);
          const fragment = parseJsonlFragment(corpus, file, line.trim());
          if (fragment) yield fragment;
          start = newline + 1;
        }
        pending = pending.slice(start);
        checkRecordSize(pending, budget);
      }
      const fragment = parseJsonlFragment(corpus, file, pending.trim());
      if (fragment) yield fragment;
    } finally {
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof DocsCapacityError) throw error;
  }
}

function checkRecordSize(value: string, budget: DocsLoadBudget): void {
  if (budget.limits && value.length > budget.limits.maxRecordChars) {
    throw new DocsCapacityError("Docs JSONL record exceeds the size budget.");
  }
}

function accountDocsBytes(budget: DocsLoadBudget, bytes: number): void {
  budget.inputBytes += bytes;
  if (budget.limits && budget.inputBytes > budget.limits.maxInputBytes) {
    throw new DocsCapacityError("Docs corpus exceeds the input byte budget.");
  }
}

async function loadTextFile(corpus: DocsCorpusInfo, file: DocsCorpusFile, budget: DocsLoadBudget): Promise<DocsFragment[]> {
  try {
    const safePath = await resolveSafeDocsFilePath(corpus.root, file.path);
    if (!safePath) {
      return [];
    }
    const stats = await fs.promises.stat(safePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) {
      return [];
    }
    const chunks: string[] = [];
    let fileBytes = 0;
    const stream = fs.createReadStream(safePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        const value = String(chunk);
        const bytes = Buffer.byteLength(value);
        fileBytes += bytes;
        accountDocsBytes(budget, bytes);
        if (fileBytes > MAX_TEXT_FILE_BYTES) return [];
        chunks.push(value);
      }
    } finally {
      stream.destroy();
    }
    const raw = chunks.join("");
    const text = normalizeWhitespace(stripHtml(raw));
    if (!text) {
      return [];
    }
    return [{
      corpus: corpus.corpus,
      corpusLabel: corpus.label,
      corpusPriority: corpus.priority,
      title: path.basename(safePath),
      kind: path.extname(file.path).slice(1) || "text",
      breadcrumbs: relativeParts(corpus.root, safePath),
      sourcePath: safePath,
      url: "",
      keywords: [],
      excerpt: text.slice(0, 500),
      text: trimFragmentText(text),
      indexPath: corpus.indexPath
    }];
  } catch (error) {
    if (error instanceof DocsCapacityError) throw error;
    return [];
  }
}

function parseJsonlFragment(corpus: DocsCorpusInfo, file: DocsCorpusFile, line: string): DocsFragment | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const title = firstString(value.title, value.doc_title, value.name, value.operationId, value.id, value.chunk_id);
    const breadcrumbs = getStringArray(value.breadcrumbs)
      .concat(getStringArray(value.section_path))
      .filter(Boolean);
    const keywords = getStringArray(value.keywords).concat(getStringArray(value.tags));
    const text = extractContent(value, file);
    if (!text) {
      return undefined;
    }
    return {
      corpus: corpus.corpus,
      corpusLabel: corpus.label,
      corpusPriority: corpus.priority,
      title: title || labelForRole(file.role),
      kind: firstString(value.kind, value.doc_kind, value.type, file.role) || file.role,
      breadcrumbs,
      sourcePath: firstString(value.source_relpath, value.path, value.file, file.path),
      url: firstString(value.url, value.source_url, value.canonical_url),
      keywords,
      excerpt: firstString(value.summary, value.excerpt, value.description),
      text: trimFragmentText(text),
      indexPath: corpus.indexPath
    };
  } catch {
    return undefined;
  }
}

function extractContent(value: Record<string, unknown>, file: DocsCorpusFile): string {
  const preferred = file.contentField ? getString(value[file.contentField]) : "";
  if (preferred) {
    return normalizeWhitespace(preferred);
  }

  const direct = firstString(
    value.text,
    value.content,
    value.body_text,
    value.body,
    value.description,
    value.summary,
    value.excerpt
  );
  if (direct) {
    return normalizeWhitespace(direct);
  }

  const structured: string[] = [];
  for (const key of ["method", "path", "title", "name", "operationId", "description", "responsibilities", "parameters", "request_body", "responses", "schema", "fields"]) {
    const text = stringifyStructured(value[key]);
    if (text) {
      structured.push(`${key}: ${text}`);
    }
  }
  return normalizeWhitespace(structured.join("\n"));
}

function stringifyStructured(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyStructured).filter(Boolean).join("; ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 4000);
    } catch {
      return "";
    }
  }
  return "";
}

function findFiles(root: string, predicate: (filePath: string) => boolean, maxDepth: number, maxFiles: number): string[] {
  const result: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (result.length >= maxFiles || depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) {
        break;
      }
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !isDeniedDocsPath(root, filePath)) {
          visit(filePath, depth + 1);
        }
      } else if (entry.isFile() && !isDeniedDocsPath(root, filePath) && predicate(filePath)) {
        result.push(filePath);
      }
    }
  };
  visit(root, 0);
  return result.sort();
}

function pushExisting(candidate: string, result: string[], seen: Set<string>): void {
  const resolved = path.resolve(candidate);
  if (!seen.has(resolved) && fs.existsSync(resolved)) {
    seen.add(resolved);
    result.push(resolved);
  }
}

function resolveSafeDocsChildPath(root: string, childPath: string): string | undefined {
  if (!childPath) {
    return undefined;
  }
  const resolved = path.resolve(root, childPath);
  return isPathInside(path.resolve(root), resolved) && !isDeniedDocsPath(root, resolved) ? resolved : undefined;
}

async function resolveSafeDocsFilePath(root: string, filePath: string): Promise<string | undefined> {
  const rootPath = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  if (!isPathInside(rootPath, resolvedPath) || isDeniedDocsPath(rootPath, resolvedPath)) {
    return undefined;
  }

  try {
    const rootRealPath = await fs.promises.realpath(rootPath);
    const fileRealPath = await fs.promises.realpath(resolvedPath);
    return isPathInside(rootRealPath, fileRealPath) && !isDeniedDocsPath(rootRealPath, fileRealPath)
      ? fileRealPath
      : undefined;
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isDeniedDocsPath(root: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  const normalized = relative.split(path.sep).join("/").toLowerCase();
  if (!normalized || normalized.startsWith("../")) {
    return false;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => SKIPPED_DIRS.has(segment))) {
    return true;
  }
  const name = path.basename(normalized);
  const ext = path.extname(normalized);
  return DENIED_DOC_FILE_NAMES.has(name) ||
    DENIED_DOC_EXTENSIONS.has(ext) ||
    name.endsWith(".env") ||
    name.includes("private-key") ||
    name.includes("secret-key");
}

function isDeniedDocsRoot(root: string): boolean {
  const normalized = path.resolve(root);
  const segments = normalized.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const name = path.basename(normalized).toLowerCase();
  const ext = path.extname(normalized).toLowerCase();
  return segments.some((segment) => SKIPPED_DIRS.has(segment)) ||
    DENIED_DOC_FILE_NAMES.has(name) ||
    DENIED_DOC_EXTENSIONS.has(ext) ||
    name.endsWith(".env") ||
    name.includes("private-key") ||
    name.includes("secret-key");
}

function uniqueCorpora(corpora: DocsCorpusInfo[]): DocsCorpusInfo[] {
  const seen = new Set<string>();
  const result: DocsCorpusInfo[] = [];
  for (const corpus of corpora) {
    const key = corpus.manifestPath || `${corpus.format}:${corpus.indexPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(corpus);
    }
  }
  return result;
}

function corpusPriority(corpus: string, root: string): number {
  const value = `${corpus} ${root}`.toLowerCase();
  if (value.includes("lang") || value.includes("language")) {
    return 8;
  }
  if (value.includes("bundle") || value.includes("server")) {
    return 5;
  }
  if (value.includes("console")) {
    return 4;
  }
  return 2;
}

function labelForCorpus(corpus: string): string {
  if (corpus.includes("language") || corpus.includes("lang")) {
    return "1C: Element language";
  }
  if (corpus.includes("bundle") || corpus.includes("server")) {
    return "1C: Element bundle";
  }
  if (corpus.includes("console")) {
    return "1C: Element console";
  }
  return corpus || "Документация";
}

function labelForRole(role: string): string {
  if (role === "chunks") {
    return "Фрагмент документации";
  }
  if (role === "documents") {
    return "Документ";
  }
  return role;
}

function relativeParts(root: string, filePath: string): string[] {
  const relative = path.relative(root, filePath);
  return relative ? relative.split(path.sep).filter(Boolean) : [];
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimFragmentText(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > MAX_FRAGMENT_TEXT_CHARS
    ? `${normalized.slice(0, MAX_FRAGMENT_TEXT_CHARS - 1)}…`
    : normalized;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = getString(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => getString(item))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[>/|]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectContextService = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const INDEX_VERSION = 1;
const MAX_INDEX_FILES = 1200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_CHARS = 7600;
const MAX_FILE_CONTEXT_CHARS = 950;
const MAX_SYMBOLS = 40;
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
class ProjectContextService {
    constructor(context, configRoot, logger) {
        this.context = context;
        this.configRoot = configRoot;
        this.logger = logger;
        this.dirty = true;
    }
    async buildContext(prompt, profileId) {
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
            const selection = selectRelevantFiles(index.files, prompt);
            const matches = selection.files.slice(0, MAX_CONTEXT_FILES);
            if (!matches.length) {
                this.logger.info(`Project context skipped: no relevant files found. indexFiles=${index.files.length}.`);
                return {
                    matchCount: 0,
                    sourcePath: indexPath,
                    mode: "skipped",
                    status: { status: "active", label: `Проектный контекст активен: ${index.files.length} файлов` }
                };
            }
            const text = formatProjectContext(workspaceRoot, matches);
            const elapsed = Date.now() - startedAt;
            this.logger.info(`Project context ${selection.mode === "fallback" ? "fallback added" : "added"}: ` +
                `${matches.length} files, indexFiles=${index.files.length}, ` +
                `indexed=${stats.indexedFiles}, reused=${stats.reusedFiles}, removed=${stats.removedFiles}, elapsed=${elapsed}ms.`);
            if (elapsed > 1000) {
                this.logger.warn(`Project context slow path: ${elapsed}ms.`);
            }
            return {
                text,
                sourcePath: indexPath,
                matchCount: matches.length,
                mode: selection.mode,
                status: { status: "active", label: `Проектный контекст активен: ${index.files.length} файлов` }
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Project context skipped: ${message}.`);
            return {
                matchCount: 0,
                status: { status: "error", label: "Проектный контекст недоступен" }
            };
        }
    }
    dispose() {
        this.watcher?.dispose();
        this.watcher = undefined;
    }
    async ensureIndex(profileId, workspaceRoot) {
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
    async loadIndex(indexPath, workspaceRoot) {
        try {
            const raw = await fs.promises.readFile(indexPath, "utf8");
            const parsed = normalizeIndex(JSON.parse(raw), workspaceRoot);
            if (parsed) {
                this.logger.info(`Project index loaded lazily: ${parsed.files.length} files from ${indexPath}.`);
            }
            return parsed;
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                this.logger.info("Project index not found, will build lazily.");
                return undefined;
            }
            this.logger.warn(`Project index read failed, will rebuild: ${error instanceof Error ? error.message : String(error)}.`);
            return undefined;
        }
    }
    async refreshIndex(existing, workspaceRoot) {
        const startedAt = Date.now();
        const scanned = await scanWorkspace(workspaceRoot);
        const previous = new Map((existing?.files ?? []).map((file) => [file.path, file]));
        const files = [];
        let reusedFiles = 0;
        let indexedFiles = 0;
        let skippedFiles = scanned.skippedFiles;
        for (const file of scanned.files) {
            const old = previous.get(file.relativePath);
            if (old && old.mtimeMs === file.mtimeMs && old.size === file.size) {
                files.push(old);
                reusedFiles += 1;
                continue;
            }
            const indexed = await indexFile(file);
            if (!indexed) {
                skippedFiles += 1;
                continue;
            }
            files.push(indexed);
            indexedFiles += 1;
        }
        files.sort((left, right) => left.path.localeCompare(right.path));
        const removedFiles = Math.max(0, previous.size - reusedFiles);
        const elapsed = Date.now() - startedAt;
        this.logger.info(`Project index refreshed: total=${files.length}, indexed=${indexedFiles}, reused=${reusedFiles}, ` +
            `removed=${removedFiles}, skipped=${skippedFiles}, elapsed=${elapsed}ms.`);
        if (elapsed > 1000) {
            this.logger.warn(`Project index refresh slow path: ${elapsed}ms.`);
        }
        return {
            index: {
                version: INDEX_VERSION,
                workspaceRoot,
                updatedAt: new Date().toISOString(),
                files
            },
            stats: {
                totalFiles: files.length,
                reusedFiles,
                indexedFiles,
                removedFiles,
                skippedFiles
            }
        };
    }
    async writeIndex(indexPath, index) {
        await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
        const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
        await fs.promises.rename(tempPath, indexPath);
        this.logger.info(`Project index saved: ${indexPath}.`);
    }
    indexPath(profileId, workspaceRoot) {
        return path.join(this.configRoot, "users", profileId, "workspaces", workspaceId(workspaceRoot), "project-index.json");
    }
    ensureWatcher() {
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
exports.ProjectContextService = ProjectContextService;
async function scanWorkspace(workspaceRoot) {
    const files = [];
    let skippedFiles = 0;
    async function walk(directory) {
        if (files.length >= MAX_INDEX_FILES) {
            return;
        }
        let entries;
        try {
            entries = await fs.promises.readdir(directory, { withFileTypes: true });
        }
        catch {
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
            let stat;
            try {
                stat = await fs.promises.stat(absolutePath);
            }
            catch {
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
async function indexFile(file) {
    const buffer = await fs.promises.readFile(file.absolutePath);
    if (!isProbablyText(buffer)) {
        return undefined;
    }
    const text = buffer.toString("utf8");
    return {
        path: file.relativePath,
        mtimeMs: file.mtimeMs,
        size: file.size,
        hash: crypto.createHash("sha1").update(buffer).digest("hex"),
        language: languageFromPath(file.relativePath),
        summary: summarizeText(text),
        symbols: extractSymbols(text)
    };
}
function selectRelevantFiles(files, prompt) {
    const terms = tokenize(prompt);
    if (!terms.length) {
        return { files: selectOverviewFiles(files), mode: "fallback" };
    }
    const scored = files
        .map((file) => ({ file, score: scoreFile(file, terms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
        .map((item) => item.file);
    if (scored.length) {
        return { files: scored, mode: "matched" };
    }
    return { files: selectOverviewFiles(files), mode: "fallback" };
}
function selectOverviewFiles(files) {
    return files
        .map((file) => ({ file, score: overviewScore(file) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
        .map((item) => item.file)
        .slice(0, MAX_CONTEXT_FILES);
}
function overviewScore(file) {
    const filePath = file.path.toLowerCase();
    let score = 0;
    if (/(^|\/)(readme|package|tsconfig|manifest|project|config)\./i.test(file.path) || /(^|\/)(readme|package|tsconfig|manifest|project|config)$/i.test(file.path)) {
        score += 100;
    }
    if (filePath.startsWith("src/")) {
        score += 60;
    }
    if (/\.(json|md|xml|yaml|yml|ts|tsx|js|bsl|os)$/i.test(file.path)) {
        score += 35;
    }
    if (file.symbols.length) {
        score += 15;
    }
    score += Math.max(0, 20 - filePath.split("/").length);
    return score;
}
function scoreFile(file, terms) {
    const filePath = file.path.toLowerCase();
    const symbols = file.symbols.join(" ").toLowerCase();
    const summary = file.summary.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (filePath.includes(term)) {
            score += 8;
        }
        if (symbols.includes(term)) {
            score += 10;
        }
        if (summary.includes(term)) {
            score += 2;
        }
    }
    return score;
}
function formatProjectContext(workspaceRoot, files) {
    const fragments = [];
    let total = 0;
    for (const file of files) {
        const fragment = [
            `Файл: ${file.path}`,
            file.language ? `Тип: ${file.language}` : "",
            file.symbols.length ? `Символы: ${file.symbols.slice(0, 18).join(", ")}` : "",
            trimText(file.summary, MAX_FILE_CONTEXT_CHARS)
        ].filter(Boolean).join("\n");
        if (total + fragment.length > MAX_CONTEXT_CHARS) {
            break;
        }
        fragments.push(fragment);
        total += fragment.length;
    }
    return [
        "[Проектный индекс]",
        `Корень workspace: ${workspaceRoot}`,
        "Используй эти сведения только если они помогают ответить на последний запрос пользователя.",
        "Не упоминай наличие этого блока, если пользователь прямо не спрашивает об источниках.",
        "",
        fragments.join("\n\n---\n\n")
    ].join("\n");
}
function summarizeText(text) {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line !== "{" && line !== "}" && !line.startsWith("//# sourceMappingURL="));
    return trimText(lines.slice(0, 36).join("\n"), 1800);
}
function extractSymbols(text) {
    const symbols = new Set();
    const patterns = [
        /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
        /\b(?:Функция|Процедура)\s+([A-Za-zА-Яа-яЁё0-9_]+)/g,
        /\b(?:function|procedure)\s+([A-Za-zА-Яа-яЁё0-9_]+)/gi
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
function shouldSkipPath(name, relativePath) {
    if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILE_NAMES.has(name)) {
        return true;
    }
    const normalized = relativePath.toLowerCase();
    return normalized.includes("/.git/") ||
        normalized.includes("/node_modules/") ||
        normalized.includes("/dist/") ||
        normalized.endsWith(".env") ||
        normalized.endsWith(".pem") ||
        normalized.endsWith(".key") ||
        normalized.endsWith(".pfx");
}
function isProbablyText(buffer) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    if (sample.includes(0)) {
        return false;
    }
    const decoded = sample.toString("utf8");
    const replacements = decoded.match(/\uFFFD/g)?.length ?? 0;
    return replacements <= Math.max(2, decoded.length * 0.02);
}
function languageFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        ".css": "CSS",
        ".html": "HTML",
        ".js": "JavaScript",
        ".json": "JSON",
        ".md": "Markdown",
        ".scss": "SCSS",
        ".ts": "TypeScript",
        ".tsx": "TypeScript React",
        ".xml": "XML",
        ".yaml": "YAML",
        ".yml": "YAML"
    };
    return map[ext] ?? ext.replace(/^\./, "").toUpperCase();
}
function normalizeIndex(value, workspaceRoot) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const object = value;
    if (object.version !== INDEX_VERSION || object.workspaceRoot !== workspaceRoot || !Array.isArray(object.files)) {
        return undefined;
    }
    const files = object.files
        .map(normalizeIndexFile)
        .filter((file) => Boolean(file));
    return {
        version: INDEX_VERSION,
        workspaceRoot,
        updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : new Date().toISOString(),
        files
    };
}
function normalizeIndexFile(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const object = value;
    if (typeof object.path !== "string" || typeof object.hash !== "string") {
        return undefined;
    }
    return {
        path: object.path,
        mtimeMs: typeof object.mtimeMs === "number" ? object.mtimeMs : 0,
        size: typeof object.size === "number" ? object.size : 0,
        hash: object.hash,
        language: typeof object.language === "string" ? object.language : "",
        summary: typeof object.summary === "string" ? object.summary : "",
        symbols: Array.isArray(object.symbols) ? object.symbols.filter((item) => typeof item === "string") : []
    };
}
function tokenize(value) {
    const matches = value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))].slice(0, 32);
}
function trimText(value, maxLength) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function workspaceId(workspaceRoot) {
    return crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function toPosix(value) {
    return value.split(path.sep).join("/");
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
//# sourceMappingURL=projectContextService.js.map
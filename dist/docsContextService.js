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
exports.DocsContextService = void 0;
exports.getDocsCorpusDiscoveryForPath = getDocsCorpusDiscoveryForPath;
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const docsCorpusService_1 = require("./docsCorpusService");
const MAX_DOCS = 6;
const MAX_EXPLICIT_OVERVIEW_DOCS = 6;
const MAX_PLANNER_DOCS = 12;
const MAX_ITEM_CHARS = 1200;
const MAX_CONTEXT_CHARS = 7800;
const MIN_DOCS_SCORE = 4;
const DENIED_EXPLICIT_DOC_SEGMENTS = new Set([".git", "node_modules", ".cache"]);
const DENIED_EXPLICIT_DOC_FILE_NAMES = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519"
]);
const DENIED_EXPLICIT_DOC_EXTENSIONS = new Set([".cer", ".crt", ".der", ".key", ".p12", ".pfx", ".pem"]);
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
    "если",
    "надо",
    "можно",
    "нужно",
    "привет",
    "спасибо",
    "пока",
    "ок",
    "окей",
    "element",
    "элемент",
    "элемента",
    "1c",
    "1с",
    "xbsl",
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
const LANGUAGE_HINTS = [
    "язык",
    "синтаксис",
    "тип",
    "структура",
    "структуры",
    "справочник",
    "форма",
    "модуль",
    "метод",
    "свойство",
    "файл",
    "каталог",
    "путь",
    "существ",
    "реквизит",
    "подсистема",
    "перечисление",
    "темаоформления",
    "stdlib",
    "api"
];
const BUNDLE_HINTS = [
    "bundle",
    "бандл",
    "сервер",
    "плагин",
    "поставка",
    "runtime",
    "ide",
    "extension"
];
const CONSOLE_HINTS = [
    "console",
    "консоль",
    "ide",
    "endpoint",
    "http",
    "панель",
    "публикация",
    "приложение",
    "проект"
];
class DocsContextService {
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
        this.cacheByRoot = new Map();
    }
    async buildContext(prompt) {
        const candidates = this.getAllowedRootCandidates();
        if (!candidates.length) {
            this.logger.info("Docs context skipped: no allowed docs roots are configured or discovered.");
            return undefined;
        }
        const caches = await this.loadAllowedDocsCaches(candidates);
        if (!caches.length) {
            this.logger.info(`Docs context skipped: no supported docs corpus found in allowed roots (${candidates.length}).`);
            return undefined;
        }
        const fragmentsPool = caches.flatMap((cache) => cache.loaded.fragments);
        const overviewIntent = isExplicitDocsOverviewPrompt(prompt);
        const matches = overviewIntent ? [] : searchFragments(fragmentsPool, prompt).slice(0, MAX_DOCS);
        const fragments = matches.length
            ? matches.map((item) => item.fragment)
            : overviewIntent ? selectOverviewFragments(fragmentsPool) : [];
        const mode = matches.length ? "matched" : "overview";
        if (!fragments.length) {
            const corpusCount = caches.reduce((total, cache) => total + cache.loaded.corpora.length, 0);
            const fragmentCount = caches.reduce((total, cache) => total + cache.loaded.fragments.length, 0);
            this.logger.info(`Docs context skipped: no relevant docs were found. roots=${caches.length}, corpora=${corpusCount}, fragments=${fragmentCount}.`);
            return undefined;
        }
        const text = formatCombinedContext(caches, fragments);
        const corpusLabels = [...new Set(fragments.map((item) => item.corpus))].join(",");
        const scores = matches
            .slice(0, 4)
            .map((item) => `${item.fragment.corpus}:${Math.round(item.score)}`)
            .join(",");
        this.logger.info(`Docs context ${mode === "overview" ? "overview" : "added"}: fragments=${fragments.length}, corpora=${corpusLabels}, scores=${scores || "<overview>"}, roots=${caches.map((cache) => cache.root).join(";")}.`);
        return {
            text,
            sourcePath: caches.map((cache) => cache.root).join(";"),
            matchCount: fragments.length,
            mode
        };
    }
    async buildExplicitPathContext(prompt, workspaceRoot) {
        const candidates = extractExplicitDocsPaths(prompt, workspaceRoot);
        if (!candidates.length) {
            return undefined;
        }
        const promptWithoutPaths = removeKnownPathsFromPrompt(prompt, candidates);
        for (const candidate of candidates) {
            try {
                const resolved = await resolveCorpusRoot(candidate);
                if (!resolved) {
                    this.logger.info(`Explicit docs context skipped: path is not a readable directory or file (${candidate}).`);
                    continue;
                }
                const cache = await this.load(resolved.root);
                const overviewIntent = isExplicitDocsOverviewPrompt(promptWithoutPaths);
                const matches = overviewIntent ? [] : searchFragments(cache.loaded.fragments, promptWithoutPaths).slice(0, MAX_DOCS);
                const mode = matches.length ? "matched" : "overview";
                const fragments = matches.length
                    ? matches.map((item) => item.fragment)
                    : selectOverviewFragments(cache.loaded.fragments);
                if (!fragments.length) {
                    this.logger.info(`Explicit docs context skipped: corpus has no usable fragments (${resolved.root}).`);
                    continue;
                }
                const text = formatExplicitPathContext(cache.loaded, fragments, resolved.requestedPath, mode);
                const corpusLabels = [...new Set(fragments.map((item) => item.corpus))].join(",");
                this.logger.info(`Explicit docs context added: mode=${mode}, fragments=${fragments.length}, corpora=${corpusLabels}; requested=${resolved.requestedPath}; root=${cache.root}.`);
                return {
                    text,
                    sourcePath: cache.root,
                    matchCount: fragments.length,
                    mode
                };
            }
            catch (error) {
                this.logger.warn(`Explicit docs context skipped: ${error instanceof Error ? error.message : String(error)}.`);
            }
        }
        return undefined;
    }
    async buildPlannerInput() {
        const candidates = this.getAllowedRootCandidates();
        if (!candidates.length) {
            return undefined;
        }
        const caches = await this.loadAllowedDocsCaches(candidates);
        if (!caches.length) {
            return undefined;
        }
        const roots = caches.map((cache) => ({
            root: cache.root,
            fingerprint: cache.fingerprint?.value,
            fileCount: cache.fingerprint?.fileCount,
            latestMtimeMs: cache.fingerprint?.latestMtimeMs,
            corpusCount: cache.loaded.corpora.length,
            fragmentCount: cache.loaded.fragments.length
        }));
        const corpora = [];
        for (const cache of caches) {
            for (const corpus of cache.loaded.corpora) {
                const fragments = cache.loaded.fragments.filter((fragment) => fragment.corpus === corpus.corpus && fragment.indexPath === corpus.indexPath);
                corpora.push({
                    corpus: corpus.corpus,
                    label: corpus.label,
                    root: cache.root,
                    priority: corpus.priority,
                    format: corpus.format,
                    fragmentCount: fragments.length,
                    titles: uniqueStrings(fragments.map((fragment) => fragment.title).filter(Boolean)).slice(0, 48),
                    keywords: uniqueStrings(fragments.flatMap((fragment) => fragment.keywords)).slice(0, 80),
                    excerpts: selectOverviewFragments(fragments)
                        .slice(0, 8)
                        .map((fragment) => trimText(fragment.excerpt || fragment.text, 260))
                        .filter(Boolean)
                });
            }
        }
        return { roots, corpora };
    }
    async buildContextFromPlan(prompt, plan) {
        const candidates = this.getAllowedRootCandidates();
        if (!candidates.length) {
            this.logger.info("Docs model-assisted retrieval skipped: no allowed docs roots are configured or discovered.");
            return undefined;
        }
        const caches = await this.loadAllowedDocsCaches(candidates);
        if (!caches.length) {
            this.logger.info(`Docs model-assisted retrieval skipped: no supported docs corpus found in allowed roots (${candidates.length}).`);
            return undefined;
        }
        const fragmentsPool = caches.flatMap((cache) => cache.loaded.fragments);
        const preferredCorpora = new Set(plan.preferredCorpora.map((item) => item.toLowerCase()));
        const targetTitles = plan.targetTitles.map((item) => item.toLowerCase()).filter(Boolean);
        const queries = normalizePlannerQueries(plan, prompt);
        const overview = plan.needOverview || isExplicitDocsOverviewPrompt(prompt);
        const fragments = overview
            ? selectOverviewFragmentsForPlan(fragmentsPool, preferredCorpora).slice(0, MAX_PLANNER_DOCS)
            : selectPlannerFragments(fragmentsPool, queries, preferredCorpora, targetTitles).slice(0, MAX_PLANNER_DOCS);
        if (!fragments.length) {
            this.logger.info(`Docs model-assisted retrieval found no fragments: queries=${queries.length}, preferred=${[...preferredCorpora].join(",") || "-"}, overview=${overview}.`);
            return undefined;
        }
        const text = formatCombinedContext(caches, fragments);
        const corpusLabels = [...new Set(fragments.map((item) => item.corpus))].join(",");
        this.logger.info(`Docs model-assisted context added: fragments=${fragments.length}, corpora=${corpusLabels}, queries=${queries.length}, overview=${overview}, roots=${caches.map((cache) => cache.root).join(";")}.`);
        return {
            text,
            sourcePath: caches.map((cache) => cache.root).join(";"),
            matchCount: fragments.length,
            mode: overview ? "overview" : "matched"
        };
    }
    async searchTool(query, options = {}) {
        const caches = await this.loadAllowedDocsCaches(this.getAllowedRootCandidates());
        if (!caches.length) {
            return undefined;
        }
        const fragmentsPool = caches.flatMap((cache) => cache.loaded.fragments);
        const maxItems = clampPositiveInteger(options.maxItems, 8, 1, 24);
        const maxPreviewChars = clampPositiveInteger(options.maxPreviewChars, 360, 120, 1200);
        const matches = searchFragments(fragmentsPool, query).slice(0, maxItems);
        return {
            query,
            roots: summarizeCaches(caches),
            fragments: matches.map((item) => toDocsToolFragmentRef(item.fragment, item.score, maxPreviewChars)),
            totalAvailableFragments: fragmentsPool.length
        };
    }
    async readTool(options) {
        const caches = await this.loadAllowedDocsCaches(this.getAllowedRootCandidates());
        if (!caches.length) {
            return undefined;
        }
        const fragmentsPool = caches.flatMap((cache) => cache.loaded.fragments);
        const maxItems = clampPositiveInteger(options.maxItems, 4, 1, 12);
        const maxCharsPerItem = clampPositiveInteger(options.maxCharsPerItem, MAX_ITEM_CHARS, 400, 4000);
        const selected = selectReadFragments(fragmentsPool, options).slice(0, maxItems);
        return {
            roots: summarizeCaches(caches),
            fragments: selected.map((fragment) => {
                const text = trimText(fragment.text || fragment.excerpt, maxCharsPerItem);
                return {
                    ref: toDocsToolFragmentRef(fragment, undefined, 360),
                    text,
                    truncated: text.length < (fragment.text || fragment.excerpt).replace(/\s+/g, " ").trim().length
                };
            })
        };
    }
    async overviewTool(options = {}) {
        const caches = await this.loadAllowedDocsCaches(this.getAllowedRootCandidates());
        if (!caches.length) {
            return undefined;
        }
        const fragmentsPool = caches.flatMap((cache) => cache.loaded.fragments);
        const maxItems = clampPositiveInteger(options.maxItems, MAX_EXPLICIT_OVERVIEW_DOCS, 1, 16);
        const maxCharsPerItem = clampPositiveInteger(options.maxCharsPerItem, 900, 300, 3000);
        const fragments = selectOverviewFragments(fragmentsPool).slice(0, maxItems);
        const plannerInput = await this.buildPlannerInput();
        return {
            roots: summarizeCaches(caches),
            corpora: plannerInput?.corpora ?? [],
            fragments: fragments.map((fragment) => {
                const text = trimText(fragment.excerpt || fragment.text, maxCharsPerItem);
                return {
                    ref: toDocsToolFragmentRef(fragment, undefined, 360),
                    text,
                    truncated: text.length < (fragment.excerpt || fragment.text).replace(/\s+/g, " ").trim().length
                };
            })
        };
    }
    async load(root) {
        const normalizedRoot = path.resolve(root);
        const fingerprint = (0, docsCorpusService_1.fingerprintDocsCorpora)(normalizedRoot);
        const cached = this.cacheByRoot.get(normalizedRoot);
        if (cached && cached.fingerprint?.value === fingerprint?.value) {
            this.cache = cached;
            return cached;
        }
        if (this.cache?.root === normalizedRoot && this.cache.fingerprint?.value === fingerprint?.value) {
            return this.cache;
        }
        const loaded = await (0, docsCorpusService_1.loadDocsCorpora)(normalizedRoot);
        this.cache = {
            root: normalizedRoot,
            fingerprint,
            loaded
        };
        this.cacheByRoot.set(normalizedRoot, this.cache);
        this.logger.info(`Docs corpus loaded lazily: ${loaded.fragments.length} fragments from ${loaded.corpora.length} corpora (${loaded.corpora.map((item) => `${item.corpus}:${item.format}`).join(", ")}); fingerprint=${fingerprint?.value ?? "<unknown>"}.`);
        return this.cache;
    }
    invalidate(root) {
        if (root) {
            this.cacheByRoot.delete(path.resolve(root));
            if (this.cache?.root === path.resolve(root)) {
                this.cache = undefined;
            }
            return;
        }
        this.cache = undefined;
        this.cacheByRoot.clear();
    }
    getAllowedRootCandidates() {
        const docs = this.settings.getDocsSettingsView();
        const candidates = [];
        if (docs.normalizedPath) {
            candidates.push({
                root: docs.normalizedPath,
                kind: "normalized",
                label: "Нормализованная документация из настроек"
            });
        }
        if (docs.sourcePath && (!docs.normalizedPath || path.resolve(docs.sourcePath) !== path.resolve(docs.normalizedPath))) {
            candidates.push({
                root: docs.sourcePath,
                kind: "source",
                label: "Исходная документация из настроек"
            });
        }
        candidates.push(...findAutoServerDocsRoots(this.settings.getConfigRoot()));
        const seen = new Set();
        return candidates.filter((candidate) => {
            const root = path.resolve(candidate.root);
            if (seen.has(root)) {
                return false;
            }
            seen.add(root);
            return true;
        });
    }
    async loadAllowedDocsCaches(candidates) {
        const caches = [];
        for (const candidate of candidates) {
            try {
                const resolved = await resolveCorpusRoot(candidate.root);
                if (!resolved) {
                    this.logger.info(`Docs root skipped: ${candidate.label}; path is not readable (${candidate.root}).`);
                    continue;
                }
                const cache = await this.load(resolved.root);
                caches.push(cache);
            }
            catch (error) {
                this.logger.warn(`Docs root skipped: ${candidate.label}; ${error instanceof Error ? error.message : String(error)}.`);
            }
        }
        return caches;
    }
}
exports.DocsContextService = DocsContextService;
function summarizeCaches(caches) {
    return caches.map((cache) => ({
        root: cache.root,
        fingerprint: cache.fingerprint?.value,
        fileCount: cache.fingerprint?.fileCount,
        latestMtimeMs: cache.fingerprint?.latestMtimeMs,
        corpusCount: cache.loaded.corpora.length,
        fragmentCount: cache.loaded.fragments.length
    }));
}
function docsFragmentId(fragment) {
    return crypto
        .createHash("sha256")
        .update([
        fragment.corpus,
        fragment.indexPath,
        fragment.sourcePath,
        fragment.title,
        fragment.url,
        fragment.text.slice(0, 200)
    ].join("\u0000"))
        .digest("hex")
        .slice(0, 16);
}
function toDocsToolFragmentRef(fragment, score, maxPreviewChars) {
    return {
        id: docsFragmentId(fragment),
        corpus: fragment.corpus,
        corpusLabel: fragment.corpusLabel,
        kind: fragment.kind,
        title: fragment.title,
        breadcrumbs: fragment.breadcrumbs,
        sourcePath: fragment.sourcePath,
        url: fragment.url,
        indexPath: fragment.indexPath,
        score,
        preview: trimText(fragment.excerpt || fragment.text, maxPreviewChars)
    };
}
function selectReadFragments(fragments, options) {
    const ids = new Set((options.fragmentIds ?? []).map((item) => item.trim()).filter(Boolean));
    if (ids.size) {
        return fragments.filter((fragment) => ids.has(docsFragmentId(fragment)));
    }
    const sourcePath = options.sourcePath?.trim().toLowerCase();
    if (sourcePath) {
        const bySource = fragments.filter((fragment) => fragment.sourcePath.toLowerCase() === sourcePath || path.normalize(fragment.sourcePath).toLowerCase() === path.normalize(sourcePath));
        if (bySource.length) {
            return bySource;
        }
    }
    const title = options.title?.trim().toLowerCase();
    if (title) {
        const byTitle = fragments.filter((fragment) => fragment.title.toLowerCase() === title || fragment.title.toLowerCase().includes(title));
        if (byTitle.length) {
            return byTitle;
        }
    }
    const query = options.query?.trim();
    return query ? searchFragments(fragments, query).map((item) => item.fragment) : [];
}
function searchFragments(fragments, prompt) {
    const terms = tokenize(prompt);
    if (!terms.length) {
        return [];
    }
    const intent = detectIntent(prompt);
    return fragments
        .map((fragment) => ({ fragment, score: scoreFragment(fragment, terms, intent) }))
        .filter((item) => item.score >= MIN_DOCS_SCORE)
        .sort((left, right) => right.score - left.score)
        .filter((item, index, items) => index === items.findIndex((other) => sameFragment(item.fragment, other.fragment)));
}
function normalizePlannerQueries(plan, prompt) {
    return uniqueStrings([
        ...plan.queries,
        ...plan.targetTitles,
        prompt
    ].map((item) => item.trim()).filter(Boolean)).slice(0, 10);
}
function selectPlannerFragments(fragments, queries, preferredCorpora, targetTitles) {
    const scored = new Map();
    for (const query of queries) {
        for (const item of searchFragments(fragments, query)) {
            const key = fragmentKey(item.fragment);
            const boosted = {
                fragment: item.fragment,
                score: item.score + plannerBoost(item.fragment, preferredCorpora, targetTitles)
            };
            const existing = scored.get(key);
            if (!existing || existing.score < boosted.score) {
                scored.set(key, boosted);
            }
        }
    }
    return [...scored.values()]
        .sort((left, right) => right.score - left.score
        || right.fragment.corpusPriority - left.fragment.corpusPriority
        || left.fragment.title.localeCompare(right.fragment.title))
        .map((item) => item.fragment);
}
function plannerBoost(fragment, preferredCorpora, targetTitles) {
    const corpus = fragment.corpus.toLowerCase();
    const title = fragment.title.toLowerCase();
    let score = 0;
    for (const preferred of preferredCorpora) {
        if (preferred && (corpus.includes(preferred) || fragment.corpusLabel.toLowerCase().includes(preferred))) {
            score += 22;
        }
    }
    for (const target of targetTitles) {
        if (target && title.includes(target)) {
            score += 18;
        }
    }
    return score;
}
function selectOverviewFragmentsForPlan(fragments, preferredCorpora) {
    return [...fragments]
        .sort((left, right) => overviewPlannerBoost(right, preferredCorpora) - overviewPlannerBoost(left, preferredCorpora)
        || scoreOverviewFragment(right) - scoreOverviewFragment(left)
        || right.corpusPriority - left.corpusPriority
        || left.title.localeCompare(right.title))
        .filter((item, index, items) => index === items.findIndex((other) => sameFragment(item, other)))
        .slice(0, MAX_PLANNER_DOCS);
}
function overviewPlannerBoost(fragment, preferredCorpora) {
    const corpus = fragment.corpus.toLowerCase();
    let score = 0;
    for (const preferred of preferredCorpora) {
        if (preferred && corpus.includes(preferred)) {
            score += 30;
        }
    }
    return score;
}
function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = value.trim();
        if (!normalized) {
            continue;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(normalized);
    }
    return result;
}
function fragmentKey(fragment) {
    return [
        fragment.corpus,
        fragment.title,
        fragment.sourcePath,
        fragment.url,
        fragment.text.slice(0, 80)
    ].join("\u0000");
}
function scoreFragment(fragment, terms, intent) {
    const title = fragment.title.toLowerCase();
    const breadcrumbs = fragment.breadcrumbs.join(" ").toLowerCase();
    const keywords = fragment.keywords.join(" ").toLowerCase();
    const excerpt = fragment.excerpt.toLowerCase();
    const text = fragment.text.toLowerCase();
    const corpus = fragment.corpus.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (title.includes(term)) {
            score += 12;
        }
        if (breadcrumbs.includes(term)) {
            score += 7;
        }
        if (keywords.includes(term)) {
            score += 6;
        }
        if (excerpt.includes(term)) {
            score += 4;
        }
        if (text.includes(term)) {
            score += term.length >= 10 ? 5 : 1;
        }
    }
    score += Math.min(fragment.corpusPriority, 8) * 0.4;
    if (intent.language && (corpus.includes("lang") || corpus.includes("language"))) {
        score += 18;
    }
    if (intent.bundle && (corpus.includes("bundle") || corpus.includes("server"))) {
        score += 14;
    }
    if (intent.console && corpus.includes("console")) {
        score += 14;
    }
    if (intent.language && !intent.bundle && !intent.console && (corpus.includes("bundle") || corpus.includes("console"))) {
        score -= 6;
    }
    if (intent.bundle && !intent.language && (corpus.includes("lang") || corpus.includes("language"))) {
        score -= 2;
    }
    if (intent.console && !intent.language && (corpus.includes("lang") || corpus.includes("language"))) {
        score -= 2;
    }
    return score;
}
function detectIntent(prompt) {
    const text = prompt.toLowerCase();
    return {
        language: LANGUAGE_HINTS.some((term) => text.includes(term)),
        bundle: BUNDLE_HINTS.some((term) => text.includes(term)),
        console: CONSOLE_HINTS.some((term) => text.includes(term))
    };
}
function sameFragment(left, right) {
    return Boolean(left.sourcePath && left.sourcePath === right.sourcePath && left.title === right.title)
        || Boolean(left.url && left.url === right.url && left.title === right.title);
}
function formatCombinedContext(caches, fragments) {
    const loadedCorpora = caches.flatMap((cache) => cache.loaded.corpora);
    const formatted = [];
    let total = 0;
    for (const [index, fragment] of fragments.entries()) {
        const source = [
            `[${index + 1}] ${fragment.title || "Документация 1C: Element"}`,
            `Корпус: ${fragment.corpusLabel} (${fragment.corpus})`,
            fragment.kind ? `Тип: ${fragment.kind}` : "",
            fragment.breadcrumbs.length ? `Раздел: ${fragment.breadcrumbs.join(" > ")}` : "",
            fragment.url ? `URL: ${fragment.url}` : "",
            fragment.sourcePath ? `Источник: ${fragment.sourcePath}` : "",
            trimText(fragment.excerpt || fragment.text, MAX_ITEM_CHARS)
        ].filter(Boolean).join("\n");
        if (total + source.length > MAX_CONTEXT_CHARS) {
            break;
        }
        formatted.push(source);
        total += source.length;
    }
    const corpora = loadedCorpora
        .map((item) => `- ${item.label} (${item.corpus}, ${item.format}): ${item.indexPath}`)
        .join("\n");
    const roots = caches
        .map((cache) => `- ${cache.root}${cache.fingerprint ? `; fingerprint=${cache.fingerprint.value}; files=${cache.fingerprint.fileCount}; mtime=${new Date(cache.fingerprint.latestMtimeMs).toISOString()}` : "; fingerprint=unknown"}`)
        .join("\n");
    return [
        "[Документация 1C: Element]",
        "Источник документации выбран Codex Element из разрешенных roots: `docs.normalizedPath`, `docs.sourcePath` и auto-discovered `server/docs`.",
        "Codex Element уже прочитал поддерживаемые индексы/текстовые файлы и передал только релевантные выдержки ниже.",
        "Разрешенные источники этого запроса:",
        roots,
        "Активные корпуса и индексы:",
        corpora,
        "Используй только переданные ниже релевантные фрагменты документации.",
        "Не используй старые или примерные локальные пути к документации из истории, правил проекта или workspace.",
        "Если фрагментов недостаточно, явно укажи, какого раздела или API не хватает, но не угадывай.",
        "Не упоминай наличие этого служебного блока, если пользователь прямо не спрашивает об источниках.",
        "",
        formatted.join("\n\n---\n\n")
    ].join("\n");
}
function formatExplicitPathContext(corpus, fragments, requestedPath, mode) {
    const formatted = [];
    let total = 0;
    for (const [index, fragment] of fragments.entries()) {
        const source = [
            `[${index + 1}] ${fragment.title || "Документация 1C: Element"}`,
            `Корпус: ${fragment.corpusLabel} (${fragment.corpus})`,
            fragment.kind ? `Тип: ${fragment.kind}` : "",
            fragment.breadcrumbs.length ? `Раздел: ${fragment.breadcrumbs.join(" > ")}` : "",
            fragment.url ? `URL: ${fragment.url}` : "",
            fragment.sourcePath ? `Источник: ${fragment.sourcePath}` : "",
            trimText(fragment.excerpt || fragment.text, MAX_ITEM_CHARS)
        ].filter(Boolean).join("\n");
        if (total + source.length > MAX_CONTEXT_CHARS) {
            break;
        }
        formatted.push(source);
        total += source.length;
    }
    const corpora = corpus.corpora
        .map((item) => `- ${item.label} (${item.corpus}, ${item.format}): ${item.indexPath}`)
        .join("\n");
    return [
        "[Документация 1C: Element: явно указанный источник]",
        "Пользователь явно указал локальный путь к документации или корпусу. Codex Element уже прочитал поддерживаемые индексы этого источника и передал тебе выдержки ниже.",
        `Указанный пользователем путь: ${requestedPath}`,
        `Загруженный каталог документации: ${corpus.root}`,
        `Режим выборки: ${mode === "matched" ? "релевантные фрагменты по запросу" : "краткий обзор корпуса, потому запрос просит ознакомиться с источником целиком или точных совпадений мало"}`,
        "Не проси пользователя повторно подтянуть этот же путь и не ищи старые локальные каталоги из истории.",
        "Не утверждай, что прочитал весь корпус целиком: ниже только ограниченный служебный срез в рамках бюджета контекста.",
        "Если для ответа нужен конкретный раздел, используй переданные фрагменты и попроси уточнить тему только когда их недостаточно.",
        "Не упоминай наличие этого служебного блока, если пользователь прямо не спрашивает об источниках.",
        "",
        "Активные корпуса и индексы:",
        corpora,
        "",
        formatted.join("\n\n---\n\n")
    ].join("\n");
}
function selectOverviewFragments(fragments) {
    return [...fragments]
        .sort((left, right) => scoreOverviewFragment(right) - scoreOverviewFragment(left)
        || right.corpusPriority - left.corpusPriority
        || left.title.localeCompare(right.title))
        .filter((item, index, items) => index === items.findIndex((other) => sameFragment(item, other)))
        .slice(0, MAX_EXPLICIT_OVERVIEW_DOCS);
}
function isExplicitDocsOverviewPrompt(prompt) {
    const normalized = prompt.toLowerCase().normalize("NFKC");
    return /(?:ознаком|изучи|прочитай|посмотри|разбери|проанализируй).{0,80}(?:документац|справк|корпус|каталог|папк|источник)/u.test(normalized)
        || /(?:всю|весь|целиком|полностью).{0,60}(?:документац|справк|корпус|каталог|папк|источник)/u.test(normalized)
        || /(?:документац|справк|корпус).{0,80}(?:ознаком|изучи|прочитай|посмотри|разбери|проанализируй)/u.test(normalized);
}
function scoreOverviewFragment(fragment) {
    let score = 0;
    const corpus = fragment.corpus.toLowerCase();
    const role = fragment.kind.toLowerCase();
    if (corpus.includes("lang") || corpus.includes("language")) {
        score += 40;
    }
    if (corpus.includes("bundle") || corpus.includes("server")) {
        score += 12;
    }
    if (corpus.includes("console")) {
        score += 8;
    }
    if (role.includes("document") || role.includes("chunk") || role.includes("pages")) {
        score += 4;
    }
    if (fragment.title.length <= 120) {
        score += 2;
    }
    if (fragment.excerpt) {
        score += 1;
    }
    return score;
}
async function resolveCorpusRoot(candidate) {
    const requestedPath = path.resolve(candidate);
    if (isDeniedExplicitDocsPath(requestedPath)) {
        return undefined;
    }
    const stats = await fs.promises.stat(requestedPath);
    if (stats.isDirectory()) {
        return { root: requestedPath, requestedPath };
    }
    if (stats.isFile()) {
        return { root: path.dirname(requestedPath), requestedPath };
    }
    return undefined;
}
function isDeniedExplicitDocsPath(filePath) {
    const normalized = path.normalize(filePath).split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
    if (normalized.some((segment) => DENIED_EXPLICIT_DOC_SEGMENTS.has(segment))) {
        return true;
    }
    const name = path.basename(filePath).toLowerCase();
    const ext = path.extname(filePath).toLowerCase();
    return DENIED_EXPLICIT_DOC_FILE_NAMES.has(name) ||
        DENIED_EXPLICIT_DOC_EXTENSIONS.has(ext) ||
        name.endsWith(".env") ||
        name.includes("private-key") ||
        name.includes("secret-key");
}
function extractExplicitDocsPaths(prompt, workspaceRoot) {
    const found = new Set();
    const candidates = [];
    const quoted = prompt.matchAll(/[`"“”'«»]([^`"“”'«»]+)[`"“”'«»]/gu);
    for (const match of quoted) {
        pushPathCandidate(match[1], workspaceRoot, candidates, found, true);
    }
    const windowsPaths = prompt.matchAll(/[A-Za-z]:[\\/][^\s`"'“”«»<>|]+/g);
    for (const match of windowsPaths) {
        pushPathCandidate(match[0], workspaceRoot, candidates, found, false);
    }
    const unixPaths = prompt.matchAll(/(^|[\s(])\/[^\s`"'“”«»<>|]+/g);
    for (const match of unixPaths) {
        pushPathCandidate(match[0].trim(), workspaceRoot, candidates, found, false);
    }
    return candidates.slice(0, 4);
}
function pushPathCandidate(rawValue, workspaceRoot, candidates, found, allowRelative) {
    const cleaned = cleanPathCandidate(rawValue);
    if (!cleaned || /^https?:\/\//i.test(cleaned)) {
        return;
    }
    const looksAbsolute = path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned);
    const looksRelative = allowRelative && /(?:^\.{1,2}[\\/]|[\\/]|\.jsonl$|\.md$|docs?|документац|ai-docs|ai-dosc|lang)/i.test(cleaned);
    if (!looksAbsolute && !looksRelative) {
        return;
    }
    const resolved = looksAbsolute ? path.resolve(cleaned) : path.resolve(workspaceRoot, cleaned);
    if (found.has(resolved)) {
        return;
    }
    found.add(resolved);
    candidates.push(resolved);
}
function cleanPathCandidate(value) {
    return value
        .trim()
        .replace(/^[({\[]+/, "")
        .replace(/[),.;:\]}]+$/u, "")
        .replace(/\\$/u, "")
        .trim();
}
function removeKnownPathsFromPrompt(prompt, paths) {
    let result = prompt;
    for (const item of paths) {
        result = result.split(item).join(" ");
        result = result.split(path.basename(item)).join(" ");
    }
    return result;
}
function findAutoServerDocsRoots(configRoot) {
    const candidates = [];
    const push = (root, label = "Автообнаруженная документация server/docs") => {
        if (!root) {
            return;
        }
        try {
            if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
                candidates.push({ root, kind: "serverDocs", label });
            }
        }
        catch {
            // ignored: auto-discovery is best-effort only.
        }
    };
    push(process.env.CODEX_ELEMENT_SERVER_DOCS?.trim() ?? "", "Документация server/docs из CODEX_ELEMENT_SERVER_DOCS");
    push(path.join(configRoot, "server", "docs"));
    let current = process.cwd();
    for (let index = 0; index < 8; index += 1) {
        push(path.join(current, "server", "docs", "help", "ru"));
        push(path.join(current, "server", "docs"));
        push(path.join(current, "docs", "help", "ru"));
        push(path.join(current, "docs"));
        const next = path.dirname(current);
        if (next === current) {
            break;
        }
        current = next;
    }
    return candidates;
}
function trimText(value, maxLength) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function clampPositiveInteger(value, fallback, min, max) {
    if (!Number.isFinite(value) || value === undefined) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function tokenize(value) {
    const matches = value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    const terms = new Set();
    for (const match of matches) {
        if (STOP_WORDS.has(match)) {
            continue;
        }
        terms.add(match);
        for (const alias of aliasesForTerm(match)) {
            if (!STOP_WORDS.has(alias)) {
                terms.add(alias);
            }
        }
    }
    return [...terms].slice(0, 48);
}
function aliasesForTerm(term) {
    if (/^структур/u.test(term)) {
        return ["struct", "record", "поля", "field"];
    }
    if (/^справоч/u.test(term)) {
        return ["catalog", "directory", "reference"];
    }
    if (/^форм/u.test(term)) {
        return ["form", "ui", "компонент"];
    }
    if (/^модул/u.test(term)) {
        return ["module", "метод", "функция"];
    }
    if (/^свойств/u.test(term)) {
        return ["property", "field", "реквизит"];
    }
    if (/^метод/u.test(term)) {
        return ["method", "function", "процедура"];
    }
    if (/^файл/u.test(term)) {
        return ["file", "fs", "filesystem"];
    }
    if (/^каталог/u.test(term) || /^папк/u.test(term)) {
        return ["directory", "folder", "path"];
    }
    if (/^существ/u.test(term) || /^провер/u.test(term)) {
        return ["exists", "exist", "наличие"];
    }
    if (/^темаоформ/u.test(term)) {
        return ["theme", "оформление"];
    }
    return [];
}
function getDocsCorpusDiscoveryForPath(root) {
    return (0, docsCorpusService_1.discoverDocsCorpora)(root);
}
//# sourceMappingURL=docsContextService.js.map
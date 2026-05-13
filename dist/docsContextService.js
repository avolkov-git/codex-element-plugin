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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_DOCS = 5;
const MAX_ITEM_CHARS = 1100;
const MAX_CONTEXT_CHARS = 6500;
const MIN_DOCS_SCORE = 4;
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
class DocsContextService {
    constructor(settings, logger) {
        this.settings = settings;
        this.logger = logger;
    }
    async buildContext(prompt) {
        const docs = this.settings.getDocsSettingsView();
        if (!docs.normalizedPath) {
            this.logger.info("Docs context skipped: normalized docs path is not configured.");
            return undefined;
        }
        if (docs.validationMessage) {
            this.logger.warn(`Docs context skipped: ${docs.validationMessage}`);
            return undefined;
        }
        try {
            const cache = await this.load(docs.normalizedPath);
            const matches = searchPages(cache.pages, prompt).slice(0, MAX_DOCS);
            if (!matches.length) {
                this.logger.info("Docs context skipped: no relevant docs were found.");
                return undefined;
            }
            const text = formatContext(cache, matches);
            this.logger.info(`Docs context added: ${matches.length} fragments from ${cache.indexPath}.`);
            return {
                text,
                sourcePath: cache.indexPath,
                matchCount: matches.length
            };
        }
        catch (error) {
            this.logger.warn(`Docs context skipped: ${error instanceof Error ? error.message : String(error)}.`);
            return undefined;
        }
    }
    async load(root) {
        const normalizedRoot = path.resolve(root);
        if (this.cache?.root === normalizedRoot) {
            return this.cache;
        }
        const indexPath = resolveIndexPath(normalizedRoot);
        const raw = await fs.promises.readFile(indexPath, "utf8");
        const pages = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map(parsePage)
            .filter((page) => Boolean(page));
        if (!pages.length) {
            throw new Error("Индекс нормализованной документации пуст.");
        }
        this.cache = {
            root: normalizedRoot,
            indexPath,
            pages
        };
        this.logger.info(`Docs index loaded lazily: ${pages.length} pages from ${indexPath}.`);
        return this.cache;
    }
}
exports.DocsContextService = DocsContextService;
function resolveIndexPath(root) {
    const highPriority = path.join(root, "index", "pages.high-priority.jsonl");
    if (fs.existsSync(highPriority)) {
        return highPriority;
    }
    return path.join(root, "index", "pages.jsonl");
}
function parsePage(line) {
    try {
        const value = JSON.parse(line);
        return {
            title: getString(value.title),
            url: getString(value.url) || getString(value.canonical_url),
            breadcrumbs: getStringArray(value.breadcrumbs),
            tags: getStringArray(value.tags),
            excerpt: getString(value.excerpt) || getString(value.description),
            bodyText: getString(value.body_text)
        };
    }
    catch {
        return undefined;
    }
}
function searchPages(pages, prompt) {
    const terms = tokenize(prompt);
    if (!terms.length) {
        return [];
    }
    return pages
        .map((page) => ({ page, score: scorePage(page, terms) }))
        .filter((item) => item.score >= MIN_DOCS_SCORE)
        .sort((left, right) => right.score - left.score)
        .map((item) => item.page);
}
function scorePage(page, terms) {
    const title = page.title.toLowerCase();
    const breadcrumbs = page.breadcrumbs.join(" ").toLowerCase();
    const tags = page.tags.join(" ").toLowerCase();
    const excerpt = page.excerpt.toLowerCase();
    const body = page.bodyText.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (title.includes(term)) {
            score += 8;
        }
        if (breadcrumbs.includes(term)) {
            score += 5;
        }
        if (tags.includes(term)) {
            score += 4;
        }
        if (excerpt.includes(term)) {
            score += 3;
        }
        if (body.includes(term)) {
            score += term.length >= 10 ? 4 : 1;
        }
    }
    return score;
}
function formatContext(cache, pages) {
    const fragments = [];
    let total = 0;
    for (const [index, page] of pages.entries()) {
        const source = [
            `[${index + 1}] ${page.title || "Документация 1C: Element"}`,
            page.breadcrumbs.length ? `Раздел: ${page.breadcrumbs.join(" > ")}` : "",
            page.url ? `URL: ${page.url}` : "",
            trimText(page.excerpt || page.bodyText, MAX_ITEM_CHARS)
        ].filter(Boolean).join("\n");
        if (total + source.length > MAX_CONTEXT_CHARS) {
            break;
        }
        fragments.push(source);
        total += source.length;
    }
    return [
        "[Документация 1C: Element]",
        "Источник документации выбран Codex Element из текущих настроек `docs.normalizedPath`.",
        `Текущий каталог нормализованной документации: ${cache.root}`,
        `Текущий индекс нормализованной документации: ${cache.indexPath}`,
        "Используй только переданные ниже фрагменты документации.",
        "Не ищи локальные каталоги документации самостоятельно и не используй старые пути из правил или истории диалога.",
        "Используй эти фрагменты только если они помогают ответить на последний запрос пользователя.",
        "Не упоминай наличие этого блока, если пользователь прямо не спрашивает об источниках.",
        "",
        fragments.join("\n\n---\n\n")
    ].join("\n");
}
function trimText(value, maxLength) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function tokenize(value) {
    const matches = value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))].slice(0, 24);
}
function getString(value) {
    return typeof value === "string" ? value : "";
}
function getStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
//# sourceMappingURL=docsContextService.js.map
import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";
import { SettingsService } from "./settingsService";

interface DocsPage {
  title: string;
  url: string;
  breadcrumbs: string[];
  tags: string[];
  excerpt: string;
  bodyText: string;
}

interface DocsCache {
  root: string;
  indexPath: string;
  pages: DocsPage[];
}

export interface DocsContextResult {
  text: string;
  sourcePath: string;
  matchCount: number;
}

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

export class DocsContextService {
  private cache: DocsCache | undefined;

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger
  ) {}

  async buildContext(prompt: string): Promise<DocsContextResult | undefined> {
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
    } catch (error) {
      this.logger.warn(`Docs context skipped: ${error instanceof Error ? error.message : String(error)}.`);
      return undefined;
    }
  }

  private async load(root: string): Promise<DocsCache> {
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
      .filter((page): page is DocsPage => Boolean(page));

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

function resolveIndexPath(root: string): string {
  const highPriority = path.join(root, "index", "pages.high-priority.jsonl");
  if (fs.existsSync(highPriority)) {
    return highPriority;
  }
  return path.join(root, "index", "pages.jsonl");
}

function parsePage(line: string): DocsPage | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return {
      title: getString(value.title),
      url: getString(value.url) || getString(value.canonical_url),
      breadcrumbs: getStringArray(value.breadcrumbs),
      tags: getStringArray(value.tags),
      excerpt: getString(value.excerpt) || getString(value.description),
      bodyText: getString(value.body_text)
    };
  } catch {
    return undefined;
  }
}

function searchPages(pages: DocsPage[], prompt: string): DocsPage[] {
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

function scorePage(page: DocsPage, terms: string[]): number {
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

function formatContext(cache: DocsCache, pages: DocsPage[]): string {
  const fragments: string[] = [];
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

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))].slice(0, 24);
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SITE_PREFIX = "/docs/help/";
const SITE_TITLE_SUFFIX = " | 1С:Предприятие.Элемент";
async function main() {
    const args = parseArgs(process.argv.slice(2));
    validateSource(args.source);
    await fs.promises.rm(args.tempOutput, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(args.tempOutput, "pages"), { recursive: true });
    await fs.promises.mkdir(path.join(args.tempOutput, "index"), { recursive: true });
    await fs.promises.mkdir(path.join(args.tempOutput, "reports"), { recursive: true });
    emitProgress(1, "scan", "Сканирование HTML-документации");
    const htmlPages = findHtmlPages(args.source);
    if (!htmlPages.length) {
        throw new Error("В исходном каталоге не найдено HTML-страниц index.html.");
    }
    const { documents, byUrl } = readSearchDocuments(args.source);
    const glossary = readGlossary(args.source);
    const records = [];
    for (const [index, htmlPath] of htmlPages.entries()) {
        const record = await buildRecord(args, htmlPath, byUrl);
        records.push(record);
        if (index % 25 === 0 || index === htmlPages.length - 1) {
            const percent = 2 + Math.floor(((index + 1) / htmlPages.length) * 83);
            emitProgress(percent, "pages", `Обработано страниц: ${index + 1} из ${htmlPages.length}`);
        }
    }
    emitProgress(90, "index", "Формирование индексов");
    await writeIndexes(args, records, documents, glossary);
    emitProgress(100, "complete", "Нормализация завершена");
    emit({ type: "complete", tempOutput: args.tempOutput, pageCount: records.length });
}
async function buildRecord(args, htmlPath, searchByUrl) {
    const raw = await fs.promises.readFile(htmlPath, "utf8");
    const html = raw.replace(/\x00/g, "");
    const slug = slugFromHtmlPath(args.source, htmlPath);
    const url = siteUrlFromSlug(slug);
    const searchEntry = searchByUrl.get(url);
    const article = extractArticle(html);
    const title = stripSiteSuffix(normalizeSpace(extractTitle(html) || slug));
    const canonicalUrl = normalizeSpace(extractLinkHref(html, "canonical"));
    const description = normalizeSpace(extractMetaContent(html, "description"));
    const breadcrumbs = extractBreadcrumbs(html);
    const effectiveBreadcrumbs = breadcrumbs.length ? breadcrumbs : searchEntry?.breadcrumbs ?? [];
    const docGroup = inferDocGroup(slug, effectiveBreadcrumbs);
    const relevance = inferRelevance(docGroup, slug, effectiveBreadcrumbs);
    const tags = getTags(slug, docGroup, searchEntry);
    const bodyMarkdown = htmlToMarkdown(article, title);
    const bodyText = markdownToText(bodyMarkdown);
    const excerpt = normalizeSpace(bodyText.split(/\n/).slice(0, 6).join(" ")).slice(0, 800);
    const mdPath = markdownPathFromSlug(args.tempOutput, slug);
    const finalMdPath = markdownPathFromSlug(args.finalOutput, slug);
    const record = {
        slug,
        title,
        url,
        canonical_url: canonicalUrl,
        source_html: htmlPath,
        description,
        doc_group: docGroup,
        lsp_relevance: relevance,
        version: extractVersion(slug, title),
        tags,
        breadcrumbs: effectiveBreadcrumbs,
        search_breadcrumbs: searchEntry?.breadcrumbs ?? [],
        last_updated: extractLastUpdated(html),
        headings: extractHeadings(article),
        links: extractLinks(article),
        code_blocks: extractCodeBlocks(article),
        qualified_name: extractQualifiedName(article),
        availability: extractAvailability(article),
        base_types: extractBaseTypes(article),
        excerpt,
        body_text: bodyText,
        word_count: bodyText.split(/\s+/).filter(Boolean).length,
        markdown_path: finalMdPath
    };
    const metadata = buildMetadata(record);
    await fs.promises.mkdir(path.dirname(mdPath), { recursive: true });
    await fs.promises.writeFile(mdPath, `${metadata}\n\n---\n\n${bodyMarkdown}`.trim() + "\n", "utf8");
    return record;
}
async function writeIndexes(args, records, searchDocuments, glossary) {
    const indexDir = path.join(args.tempOutput, "index");
    const reportsDir = path.join(args.tempOutput, "reports");
    const highPriority = records.filter((record) => record.lsp_relevance === "high");
    const stdlibSymbols = records
        .filter((record) => record.doc_group.startsWith("stdlib-"))
        .map((record) => ({
        title: record.title,
        slug: record.slug,
        url: record.url,
        doc_group: record.doc_group,
        qualified_name: record.qualified_name,
        availability: record.availability,
        base_types: record.base_types,
        excerpt: record.excerpt,
        markdown_path: record.markdown_path
    }));
    const versionHistory = records
        .filter((record) => record.doc_group === "version-history")
        .map((record) => ({
        title: record.title,
        slug: record.slug,
        url: record.url,
        version: record.version,
        last_updated: record.last_updated,
        excerpt: record.excerpt,
        markdown_path: record.markdown_path
    }));
    const docGroups = countBy(records, (record) => record.doc_group);
    const relevance = countBy(records, (record) => record.lsp_relevance);
    const manifest = {
        generated_at: new Date().toISOString(),
        source_root: args.source,
        output_root: args.finalOutput,
        page_count: records.length,
        glossary_terms: glossary.length,
        search_documents: searchDocuments.length,
        doc_groups: docGroups,
        lsp_relevance: relevance,
        index_files: {
            pages: path.join(args.finalOutput, "index", "pages.jsonl"),
            high_priority_pages: path.join(args.finalOutput, "index", "pages.high-priority.jsonl"),
            stdlib_symbols: path.join(args.finalOutput, "index", "stdlib-symbols.jsonl"),
            version_history: path.join(args.finalOutput, "index", "version-history.json"),
            glossary: path.join(args.finalOutput, "index", "glossary.json"),
            titles: path.join(args.finalOutput, "index", "titles.tsv"),
            search_documents: path.join(args.finalOutput, "index", "search-documents.json")
        }
    };
    await writeJson(path.join(indexDir, "manifest.json"), manifest);
    await writeJsonl(path.join(indexDir, "pages.jsonl"), records);
    await writeJsonl(path.join(indexDir, "pages.high-priority.jsonl"), highPriority);
    await writeJsonl(path.join(indexDir, "stdlib-symbols.jsonl"), stdlibSymbols);
    await writeJson(path.join(indexDir, "version-history.json"), versionHistory);
    await writeJson(path.join(indexDir, "glossary.json"), glossary);
    await writeJson(path.join(indexDir, "search-documents.json"), searchDocuments);
    await fs.promises.writeFile(path.join(indexDir, "titles.tsv"), buildTitlesTsv(records), "utf8");
    await fs.promises.writeFile(path.join(reportsDir, "knowledge-map.md"), buildKnowledgeMap(args, records, glossary), "utf8");
    await fs.promises.writeFile(path.join(args.tempOutput, "README.md"), buildReadme(manifest), "utf8");
}
function parseArgs(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        values.set(argv[index], argv[index + 1]);
    }
    const source = values.get("--source");
    const tempOutput = values.get("--temp-output");
    const finalOutput = values.get("--final-output");
    if (!source || !tempOutput || !finalOutput) {
        throw new Error("Usage: docsNormalizerWorker --source <docs/help/ru> --temp-output <tmp> --final-output <target>");
    }
    return {
        source: path.resolve(source),
        tempOutput: path.resolve(tempOutput),
        finalOutput: path.resolve(finalOutput)
    };
}
function validateSource(source) {
    const stats = fs.statSync(source);
    if (!stats.isDirectory()) {
        throw new Error("Исходная документация должна быть каталогом.");
    }
    if (!fs.existsSync(path.join(source, "search-index.json"))) {
        throw new Error("В исходной документации не найден search-index.json.");
    }
}
function findHtmlPages(root) {
    const result = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const current = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(current);
            }
            else if (entry.isFile() && entry.name === "index.html") {
                result.push(current);
            }
        }
    };
    visit(root);
    return result.sort();
}
function readSearchDocuments(sourceRoot) {
    const filePath = path.join(sourceRoot, "search-index.json");
    const documents = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        collectSearchDocuments(parsed, documents);
    }
    catch {
        return { documents, byUrl: new Map() };
    }
    const byUrl = new Map();
    for (const doc of documents) {
        const existing = byUrl.get(doc.url);
        if (!existing || doc.breadcrumbs.length > existing.breadcrumbs.length) {
            byUrl.set(doc.url, doc);
        }
    }
    return { documents, byUrl };
}
function collectSearchDocuments(value, documents) {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectSearchDocuments(item, documents);
        }
        return;
    }
    if (!value || typeof value !== "object") {
        return;
    }
    const record = value;
    if (typeof record.u === "string" && typeof record.t === "string") {
        documents.push({
            id: record.i,
            title: normalizeSpace(record.t),
            url: record.u,
            breadcrumbs: Array.isArray(record.b) ? record.b.map(String).map(normalizeSpace).filter(Boolean) : []
        });
    }
    if (Array.isArray(record.documents)) {
        collectSearchDocuments(record.documents, documents);
    }
}
function readGlossary(sourceRoot) {
    const filePath = path.join(sourceRoot, "docs", "glossary.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Object.entries(parsed).flatMap(([slug, value]) => {
            if (!value || typeof value !== "object") {
                return [];
            }
            const record = value;
            const title = normalizeSpace(String(record.title ?? ""));
            if (!title) {
                return [];
            }
            return [{
                    slug,
                    title,
                    hover_text: normalizeSpace(String(record.hoverText ?? "")),
                    source_json: filePath
                }];
        });
    }
    catch {
        return [];
    }
}
function slugFromHtmlPath(sourceRoot, htmlPath) {
    const rel = path.relative(sourceRoot, htmlPath);
    const dir = path.dirname(rel);
    if (dir === ".") {
        return "_root";
    }
    return dir.split(path.sep).join("/");
}
function siteUrlFromSlug(slug) {
    return slug === "_root" ? SITE_PREFIX : `${SITE_PREFIX}${slug}/`;
}
function markdownPathFromSlug(root, slug) {
    if (slug === "_root") {
        return path.join(root, "pages", "_root.md");
    }
    return path.join(root, "pages", ...slug.split("/")) + ".md";
}
function extractArticle(html) {
    return matchFirst(html, /<article\b[\s\S]*?<\/article>/i)
        || matchFirst(html, /<main\b[\s\S]*?<\/main>/i)
        || matchFirst(html, /<body\b[\s\S]*?<\/body>/i)
        || html;
}
function htmlToMarkdown(html, title) {
    const codeBlocks = [];
    let value = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
        .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
        .replace(/<a\b[^>]*class=["'][^"']*hash-link[^"']*["'][\s\S]*?<\/a>/gi, "");
    value = value.replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => {
        const index = codeBlocks.length;
        codeBlocks.push(decodeHtml(stripTags(block)).replace(/\n{3,}/g, "\n\n").trim());
        return `\n\n__CODE_BLOCK_${index}__\n\n`;
    });
    value = value.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
        return `\n\n${"#".repeat(Number(level))} ${normalizeSpace(decodeHtml(stripTags(content)))}\n\n`;
    });
    value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
        return `\n- ${normalizeSpace(decodeHtml(stripTags(content)))}`;
    });
    value = value.replace(/<br\s*\/?>/gi, "\n");
    value = value.replace(/<\/(p|div|section|table|tr|ul|ol)>/gi, "\n\n");
    value = value.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => `[Изображение: ${normalizeSpace(decodeHtml(alt)) || "Изображение"}]`);
    value = stripTags(value);
    value = decodeHtml(value);
    value = value.replace(/__CODE_BLOCK_(\d+)__/g, (_, rawIndex) => {
        const block = codeBlocks[Number(rawIndex)] ?? "";
        return `\n\n\`\`\`\n${block}\n\`\`\`\n\n`;
    });
    value = value
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const escapedTitle = escapeRegExp(title);
    value = value.replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), "");
    return value ? `${value}\n` : "\n";
}
function markdownToText(markdown) {
    return normalizeSpace(markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/\n{2,}/g, "\n"));
}
function extractTitle(html) {
    return decodeHtml(stripTags(matchFirst(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i, 1)));
}
function extractMetaContent(html, name) {
    const regex = new RegExp(`<meta\\b(?=[^>]*name=["']${escapeRegExp(name)}["'])([^>]*)>`, "i");
    const attrs = matchFirst(html, regex, 1);
    return decodeHtml(extractAttribute(attrs, "content"));
}
function extractLinkHref(html, rel) {
    const regex = new RegExp(`<link\\b(?=[^>]*rel=["']${escapeRegExp(rel)}["'])([^>]*)>`, "i");
    const attrs = matchFirst(html, regex, 1);
    return decodeHtml(extractAttribute(attrs, "href"));
}
function extractBreadcrumbs(html) {
    const nav = matchFirst(html, /<nav\b[^>]*theme-doc-breadcrumbs[\s\S]*?<\/nav>/i);
    if (!nav) {
        return [];
    }
    return [...nav.matchAll(/<a\b[^>]*class=["'][^"']*breadcrumbs__link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .map((match) => normalizeSpace(decodeHtml(stripTags(match[1]))))
        .filter((item) => item && item !== "...");
}
function extractLastUpdated(html) {
    return normalizeSpace(extractAttribute(matchFirst(html, /<time\b([^>]*)datetime=["'][^"']+["'][^>]*>/i, 1), "datetime")) || null;
}
function extractHeadings(html) {
    return [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)]
        .map((match) => ({
        level: Number(match[1]),
        text: normalizeSpace(decodeHtml(stripTags(match[3]))),
        anchor: extractAttribute(match[2], "id") || null
    }))
        .filter((heading) => Boolean(heading.text));
}
function extractLinks(html) {
    return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
        .map((match) => ({
        text: normalizeSpace(decodeHtml(stripTags(match[2]))),
        href: normalizeSpace(decodeHtml(extractAttribute(match[1], "href")))
    }))
        .filter((link) => link.text && link.href)
        .slice(0, 300);
}
function extractCodeBlocks(html) {
    return [...html.matchAll(/<pre\b[\s\S]*?<\/pre>/gi)]
        .map((match) => normalizeSpace(decodeHtml(stripTags(match[0]))))
        .filter(Boolean)
        .slice(0, 80);
}
function extractQualifiedName(html) {
    const text = normalizeSpace(decodeHtml(stripTags(matchFirst(html, /<p\b[^>]*>([\s\S]*?)<\/p>/i, 1))));
    const match = text.match(/[A-Za-zА-Яа-я_][\wА-Яа-я.]+/);
    return match?.[0] ?? null;
}
function extractAvailability(html) {
    const text = normalizeSpace(decodeHtml(stripTags(html)));
    const match = text.match(/Доступность:\s*([^.;]+)/i);
    return match ? normalizeSpace(match[1]) : null;
}
function extractBaseTypes(_html) {
    return [];
}
function inferDocGroup(slug, breadcrumbs) {
    if (slug === "_root") {
        return "root";
    }
    if (slug.startsWith("console/")) {
        return "console-api";
    }
    if (slug.startsWith("topics/terms/") || slug === "glossary") {
        return "glossary";
    }
    if (/topics\/whats-new-in-\d+[.-]\d+/.test(slug)) {
        return "version-history";
    }
    if (slug.startsWith("stdlib/element/xbsl/Std/")) {
        return "stdlib-xbsl-system";
    }
    if (slug.startsWith("stdlib/element/xbsl/DeveloperName/ProjectName/SubsystemName")) {
        return "stdlib-xbsl-project-template";
    }
    if (slug.startsWith("stdlib/element/xbsl/")) {
        return "stdlib-xbsl-other";
    }
    if (slug.startsWith("stdlib/element/xbql/")) {
        return "stdlib-xbql";
    }
    if (slug.startsWith("stdlib/")) {
        return "stdlib-root";
    }
    if (slug.startsWith("topics/")) {
        const top = breadcrumbs[0] ?? "";
        if (top === "Язык «1С:Элемент»") {
            return "language-guide";
        }
        if (top === "Язык запросов") {
            return "query-language-guide";
        }
        if (top === "Среда разработки") {
            return "ide-guide";
        }
        if (top === "Проекты") {
            return "projects-guide";
        }
        if (top === "Библиотеки") {
            return "libraries-guide";
        }
        if (top === "Устройство сервера" || top === "Панель управления сервера") {
            return "server-guide";
        }
        return "topics-guide";
    }
    if (slug.startsWith("search")) {
        return "search";
    }
    return "misc";
}
function inferRelevance(group, slug, breadcrumbs) {
    const high = new Set(["language-guide", "query-language-guide", "ide-guide", "version-history", "glossary", "stdlib-xbsl-system", "stdlib-xbsl-project-template", "stdlib-xbql"]);
    const low = new Set(["console-api", "server-guide", "search", "root", "misc"]);
    if (high.has(group)) {
        return "high";
    }
    if (low.has(group)) {
        return "low";
    }
    if (breadcrumbs[0] && ["Язык «1С:Элемент»", "Язык запросов", "Среда разработки"].includes(breadcrumbs[0])) {
        return "high";
    }
    if (slug.startsWith("topics/")) {
        return "medium";
    }
    if (slug.startsWith("stdlib/")) {
        return "high";
    }
    return "medium";
}
function getTags(slug, group, searchEntry) {
    const tags = new Set([group]);
    if (slug.startsWith("topics/")) {
        tags.add("topics");
    }
    if (slug.startsWith("stdlib/")) {
        tags.add("stdlib");
    }
    if (slug.startsWith("console/")) {
        tags.add("console");
    }
    if (slug.includes("xbsl")) {
        tags.add("xbsl");
    }
    if (slug.includes("xbql")) {
        tags.add("xbql");
    }
    for (const item of searchEntry?.breadcrumbs ?? []) {
        const normalized = item.toLowerCase().replace(/[^0-9a-zа-яё]+/gi, "-").replace(/^-|-$/g, "");
        if (normalized) {
            tags.add(normalized);
        }
    }
    return [...tags].sort();
}
function extractVersion(slug, title) {
    const match = `${slug} ${title}`.match(/(\d+[.-]\d+)/);
    return match ? match[1].replace("-", ".") : null;
}
function buildMetadata(record) {
    const lines = [
        `# ${record.title}`,
        "",
        `- Source URL: \`${record.url}\``,
        `- Source HTML: \`${record.source_html}\``,
        `- Group: \`${record.doc_group}\``,
        `- Relevance: \`${record.lsp_relevance}\``
    ];
    if (record.breadcrumbs.length) {
        lines.push(`- Breadcrumbs: ${record.breadcrumbs.join(" > ")}`);
    }
    if (record.last_updated) {
        lines.push(`- Last Updated: \`${record.last_updated}\``);
    }
    return lines.join("\n");
}
function buildTitlesTsv(records) {
    return [
        "title\tdoc_group\tslug\tmarkdown_path",
        ...records
            .slice()
            .sort((left, right) => left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug))
            .map((record) => [record.title, record.doc_group, record.slug, record.markdown_path].join("\t"))
    ].join("\n") + "\n";
}
function buildKnowledgeMap(args, records, glossary) {
    const groups = countBy(records, (record) => record.doc_group);
    const relevance = countBy(records, (record) => record.lsp_relevance);
    return [
        "# Карта корпуса 1С:Элемент",
        "",
        `- Сгенерировано: \`${new Date().toISOString()}\``,
        `- Источник: \`${args.source}\``,
        `- Всего страниц: \`${records.length}\``,
        `- Терминов глоссария: \`${glossary.length}\``,
        "",
        "## Разделы",
        "",
        ...Object.entries(groups).map(([group, count]) => `- \`${group}\`: \`${count}\``),
        "",
        "## Приоритет",
        "",
        ...Object.entries(relevance).map(([level, count]) => `- \`${level}\`: \`${count}\``),
        ""
    ].join("\n");
}
function buildReadme(manifest) {
    return [
        "# Local Docs Corpus",
        "",
        "Нормализованный локальный корпус документации `1С:Элемент` для Codex Element.",
        "",
        "## Что внутри",
        "",
        "- `pages/`: markdown-страницы.",
        "- `index/pages.jsonl`: общий индекс.",
        "- `index/pages.high-priority.jsonl`: приоритетный индекс для контекста.",
        "- `reports/knowledge-map.md`: краткая карта корпуса.",
        "",
        "## Сводка",
        "",
        `- Всего страниц: \`${manifest.page_count}\``,
        ""
    ].join("\n");
}
async function writeJson(filePath, payload) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
async function writeJsonl(filePath, rows) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
function countBy(items, selector) {
    const counts = {};
    for (const item of items) {
        const key = selector(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
function matchFirst(value, regex, group = 0) {
    return value.match(regex)?.[group] ?? "";
}
function extractAttribute(attrs, name) {
    const regex = new RegExp(`${escapeRegExp(name)}=["']([^"']*)["']`, "i");
    return attrs.match(regex)?.[1] ?? "";
}
function stripSiteSuffix(title) {
    return title.endsWith(SITE_TITLE_SUFFIX) ? title.slice(0, -SITE_TITLE_SUFFIX.length) : title;
}
function normalizeSpace(value) {
    return value.replace(/\x00/g, "").replace(/\u200b/g, "").replace(/\xa0/g, " ").replace(/\s+/g, " ").trim();
}
function stripTags(value) {
    return value.replace(/<[^>]+>/g, " ");
}
function decodeHtml(value) {
    return value
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, "/")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function emitProgress(percent, stage, message) {
    emit({ type: "progress", percent, stage, message });
}
function emit(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}
main().catch((error) => {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
});
//# sourceMappingURL=docsNormalizerWorker.js.map
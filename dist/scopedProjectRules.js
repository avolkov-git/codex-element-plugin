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
exports.RulesWorkspace = exports.SCOPED_RULES_LIMITS = void 0;
exports.parseScopedRule = parseScopedRule;
exports.isMissingRulesFile = isMissingRulesFile;
exports.loadScopedRules = loadScopedRules;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const projectStructure_1 = require("./projectStructure");
const projectModulePaths_1 = require("./projectModulePaths");
const yaml = require(path.join(__dirname, "..", "resources", "context", "yaml.cjs"));
exports.SCOPED_RULES_LIMITS = Object.freeze({
    files: 64, directoryEntries: 256, fileBytes: 32 * 1024, totalBytes: 256 * 1024,
    frontmatterBytes: 8 * 1024, contextChars: 12000, targets: 64, selectors: 32, patternChars: 256,
    // Enough for one 2048-character confirmed path even after JSON quote escaping.
    displayTargets: 8, targetListChars: 4100,
    targetFileBytes: 256 * 1024, targetTotalBytes: 1024 * 1024,
});
const RULES_DIRECTORY = ".local-codex/rules";
function invalid(message) {
    throw new Error(`Некорректные дополнительные правила: ${message}`);
}
// YAML frontmatter is mandatory; only nonempty string lists paths/elementKinds are allowed.
// Selector classes use AND on the SAME confirmed target; entries within each list use OR.
// No glob dependency is shipped. Restricted, case-sensitive prefix/suffix syntax only:
// exact/file.xbsl, dir/**, *.xbsl, dir/*.xbsl, **/*.xbsl, dir/**/*.xbsl.
// A single '*' matches a basename; '**/' permits zero or more directories. No negation,
// braces, character classes, escaping, '?' or other wildcard placements are supported.
function parseScopedRule(raw) {
    const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n"))
        invalid("нужен YAML frontmatter между строками ---.");
    const end = normalized.indexOf("\n---\n", 3);
    if (end < 0)
        invalid("не найден конец YAML frontmatter.");
    const header = normalized.slice(4, end);
    if (Buffer.byteLength(header, "utf8") > exports.SCOPED_RULES_LIMITS.frontmatterBytes)
        invalid("frontmatter превышает 8 КБ.");
    const document = yaml.parseDocument(header, { schema: "core", uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length || !yaml.isMap(document.contents))
        invalid("ошибка YAML или ожидался объект селекторов.");
    const result = { body: normalized.slice(end + 5).trim() };
    if (!result.body)
        invalid("текст правила пуст.");
    if (document.contents.anchor || document.contents.tag || document.contents.items.length > 2)
        invalid("лишние поля, теги или якоря YAML.");
    for (const pair of document.contents.items) {
        if (!yaml.isScalar(pair.key) || pair.key.anchor || pair.key.tag
            || (pair.key.value !== "paths" && pair.key.value !== "elementKinds"))
            invalid("разрешены только paths и elementKinds.");
        if (!yaml.isSeq(pair.value) || pair.value.anchor || pair.value.tag
            || !pair.value.items.length || pair.value.items.length > exports.SCOPED_RULES_LIMITS.selectors)
            invalid("селектор должен быть списком из 1–32 строк.");
        const values = [];
        for (const item of pair.value.items) {
            if (!yaml.isScalar(item) || item.anchor || item.tag || typeof item.value !== "string"
                || !item.value.trim() || item.value !== item.value.trim() || /[\x00-\x1f\x7f]/.test(item.value)
                || item.value.length > exports.SCOPED_RULES_LIMITS.patternChars)
                invalid("недопустимое значение селектора (до 256 символов, без тегов и ссылок YAML).");
            if (pair.key.value === "paths" && !validPattern(item.value))
                invalid(`неподдерживаемый шаблон пути: ${item.value}.`);
            values.push(item.value);
        }
        result[pair.key.value] = values;
    }
    if (!result.paths && !result.elementKinds)
        invalid("нужен хотя бы один селектор.");
    return result;
}
function validLiteral(value) {
    return Boolean(value) && !/[\\:*?\[\]{}!\x00-\x1f\x7f]/.test(value)
        && value.split("/").every(part => Boolean(part) && part !== "." && part !== "..");
}
function validPattern(pattern) {
    if (validLiteral(pattern))
        return true;
    if (pattern.endsWith("/**"))
        return validLiteral(pattern.slice(0, -3));
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    if (star < 0 || (prefix && (!prefix.endsWith("/") || !validLiteral(prefix.slice(0, -1)))))
        return false;
    const suffix = pattern.slice(star).replace(/^\*\*\/\*/, "*");
    return /^\*\.[^/]+$/.test(suffix) && validLiteral(suffix.slice(1));
}
function matchesPath(target, pattern) {
    if (!pattern.includes("*"))
        return target === pattern;
    if (pattern.endsWith("/**"))
        return target.startsWith(pattern.slice(0, -2));
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    if (!target.startsWith(prefix))
        return false;
    const remainder = target.slice(prefix.length);
    const wildcard = pattern.slice(star);
    const recursive = wildcard.startsWith("**/");
    const suffix = wildcard.slice(recursive ? 4 : 1);
    const basename = remainder.slice(remainder.lastIndexOf("/") + 1);
    return (recursive || !remainder.includes("/")) && basename.endsWith(suffix) && basename.length >= suffix.length;
}
function matchesRule(rule, target) {
    return (!rule.paths || rule.paths.some(pattern => matchesPath(target.path, pattern)))
        && (!rule.elementKinds || (target.elementKind !== undefined && rule.elementKinds.includes(target.elementKind)));
}
function formatRuleScope(rule, matchingPaths) {
    const displayed = [];
    let listChars = 2;
    for (const filePath of matchingPaths) {
        const entryChars = JSON.stringify(filePath).length + (displayed.length ? 1 : 0);
        if (displayed.length >= exports.SCOPED_RULES_LIMITS.displayTargets || listChars + entryChars > exports.SCOPED_RULES_LIMITS.targetListChars)
            break;
        displayed.push(filePath);
        listChars += entryChars;
    }
    const omitted = matchingPaths.length - displayed.length;
    return {
        text: [
            `Область действия: paths=${rule.paths ? JSON.stringify(rule.paths) : "без ограничения"}; elementKinds=${rule.elementKinds ? JSON.stringify(rule.elementKinds) : "без ограничения"}.`,
            "Условия: И между заданными классами селекторов для одной цели; ИЛИ внутри каждого списка.",
            `Совпавшие цели (${displayed.length} из ${matchingPaths.length}): ${JSON.stringify(displayed)}`,
            ...(omitted ? [`Список совпавших целей усечен: не показано ${omitted}. Область действия задают селекторы, а не полнота списка.`] : []),
            "Это локальное дополнение: применяй только в указанной области, не ко всем целям задачи. Оно не отменяет базовые и общепроектные правила.",
        ].join("\n"),
        omitted,
    };
}
function inside(root, file) {
    const relative = path.relative(root, file);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function stamp(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function isMissingRulesFile(error) {
    return error?.code === "ENOENT";
}
/** Per-request reader: no file/content cache, no symlinks below the selected workspace root. */
class RulesWorkspace {
    constructor(root, realRoot, assertCurrent) {
        this.root = root;
        this.realRoot = realRoot;
        this.assertCurrent = assertCurrent;
        this.snapshots = new Map();
        this.directories = new Map();
        this.targetReads = new Set();
        this.targetKinds = new Map();
        this.yamlKinds = new Map();
        this.targetBudget = { remaining: exports.SCOPED_RULES_LIMITS.targetTotalBytes };
        this.targetWarnings = [];
    }
    static async create(root, assertCurrent) {
        assertCurrent();
        const realRoot = await fs.promises.realpath(root);
        assertCurrent();
        return new RulesWorkspace(path.resolve(root), realRoot, assertCurrent);
    }
    async checkCurrent() {
        this.assertCurrent();
        if (await fs.promises.realpath(this.root) !== this.realRoot)
            throw new Error("Workspace изменился во время чтения правил. Повторите запрос.");
        this.assertCurrent();
    }
    absolute(relative) { return path.join(this.root, relative); }
    dirtyDocument(relative) {
        const lexical = this.absolute(relative);
        const canonical = path.join(this.realRoot, relative);
        return (vscode.workspace.textDocuments ?? []).find(document => !document.isClosed && document.isDirty
            && document.uri.scheme === "file" && [lexical, canonical].includes(path.resolve(document.uri.fsPath)));
    }
    async safePath(relative, allowMissingLeaf = false) {
        await this.checkCurrent();
        if (/[\x00-\x1f\x7f]/.test(relative) || (process.platform !== "win32" && relative.includes("\\")))
            throw new Error("Недопустимый путь правил.");
        if (!inside(this.root, this.absolute(relative)))
            throw new Error("Путь правил вне текущего workspace.");
        const parts = relative.split(/[\\/]/);
        if (parts.some(part => !part || part === "." || part === ".."))
            throw new Error("Недопустимый путь правил.");
        let current = this.realRoot;
        for (let index = 0; index < parts.length; index++) {
            current = path.join(current, parts[index]);
            try {
                const stat = await fs.promises.lstat(current);
                this.assertCurrent();
                if (stat.isSymbolicLink())
                    throw new Error("Символические ссылки ниже workspace не разрешены для правил и целей.");
                const real = await fs.promises.realpath(current);
                this.assertCurrent();
                if (!inside(this.realRoot, real) || real !== current)
                    throw new Error("Путь вышел за границы workspace или изменился.");
                if (index < parts.length - 1 && !stat.isDirectory())
                    throw new Error("Родитель пути не является каталогом.");
            }
            catch (error) {
                if (allowMissingLeaf && index === parts.length - 1 && isMissingRulesFile(error))
                    return current;
                throw error;
            }
        }
        return current;
    }
    async confirmTarget(target, enrich = true) {
        if (typeof target.path !== "string" || !target.path || target.path.length > 2048 || /[\x00-\x1f\x7f]/.test(target.path)
            || target.path.split(/[\\/]/).includes(".."))
            throw new Error("Неподтвержденный или недопустимый путь цели.");
        const absolute = path.resolve(this.root, target.path);
        if (!inside(this.root, absolute))
            throw new Error("Цель находится вне текущего workspace.");
        const relative = path.relative(this.root, absolute);
        if (process.platform !== "win32" && /[\\:]/.test(relative))
            throw new Error("Нужен путь файла, а не URI или путь другой платформы.");
        const file = await this.safePath(relative, Boolean(this.dirtyDocument(relative)));
        try {
            if (!(await fs.promises.stat(file)).isFile())
                throw new Error("Цель не является файлом.");
        }
        catch (error) {
            if (!isMissingRulesFile(error) || !this.dirtyDocument(relative))
                throw error;
        }
        this.assertCurrent();
        const confirmedPath = relative.split(path.sep).join("/");
        let elementKind = typeof target.elementKind === "string" ? target.elementKind : undefined;
        if (enrich && elementKind === undefined)
            elementKind = await this.targetKind(confirmedPath);
        return { path: confirmedPath, elementKind };
    }
    async targetKind(relative) {
        if (this.targetKinds.has(relative))
            return this.targetKinds.get(relative);
        let kind;
        try {
            let candidates = [];
            if (/\.ya?ml$/i.test(relative))
                candidates = [relative];
            else if (/\.xbsl$/i.test(relative)) {
                const directory = path.posix.dirname(relative);
                const catalog = await this.directoryPaths(directory, /\.ya?ml$/i);
                candidates = catalog.filter(candidate => (0, projectModulePaths_1.isElementModuleCompanion)(relative, candidate));
            }
            if (candidates.length > 1)
                throw new Error("неоднозначная пара YAML/XBSL");
            if (candidates.length === 1) {
                const yamlPath = candidates[0];
                if (this.yamlKinds.has(yamlPath))
                    kind = this.yamlKinds.get(yamlPath);
                else {
                    this.targetReads.add(yamlPath);
                    try {
                        if (this.targetBudget.remaining <= 0)
                            throw new Error("исчерпан общий лимит чтения YAML 1 МБ");
                        const text = await this.read(yamlPath, exports.SCOPED_RULES_LIMITS.targetFileBytes, this.targetBudget);
                        const structure = (0, projectStructure_1.analyzeProjectStructure)(yamlPath, text);
                        if (structure.errors.length)
                            throw new Error("некорректная структура YAML");
                        kind = structure.element?.kind;
                    }
                    finally {
                        this.yamlKinds.set(yamlPath, kind);
                    }
                }
            }
        }
        catch (error) {
            this.targetWarnings.push(`${relative}: вид элемента не подтвержден; ${error instanceof Error ? error.message : "не удалось прочитать YAML"}.`);
        }
        this.targetKinds.set(relative, kind);
        return kind;
    }
    async read(relative, maxBytes, budget) {
        const dirty = this.dirtyDocument(relative);
        const version = dirty?.version;
        const filePath = await this.safePath(relative, Boolean(dirty));
        const tooLarge = () => new Error(`Файл или буфер слишком большой: лимит ${maxBytes / 1024} КБ UTF-8.`);
        const consume = (bytes) => {
            if (budget) {
                if (bytes > budget.remaining) {
                    budget.remaining = 0;
                    throw new Error(budget === this.targetBudget ? "Подбор видов элементов усечен: общий лимит чтения YAML 1 МБ."
                        : "Подбор дополнительных правил усечен: общий лимит чтения 256 КБ.");
                }
                budget.remaining -= bytes;
            }
            if (bytes > maxBytes)
                throw tooLarge();
        };
        let before;
        try {
            before = await fs.promises.lstat(filePath);
            if (!before.isFile() || before.isSymbolicLink())
                throw new Error("Правила должны быть обычным файлом, без символических ссылок.");
        }
        catch (error) {
            if (!isMissingRulesFile(error) || !dirty)
                throw error;
        }
        this.snapshots.set(relative, { diskStamp: before && stamp(before), document: dirty, version });
        let text;
        if (dirty) {
            // The buffer is the source; disk metadata is only used for path safety and freshness.
            text = dirty.getText();
            consume(Buffer.byteLength(text, "utf8"));
        }
        else {
            if (!before || before.size > maxBytes)
                throw tooLarge();
            const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
            try {
                await this.safePath(relative);
                if (stamp(await file.stat()) !== stamp(before))
                    throw new Error("Файл правил изменился перед чтением. Повторите запрос.");
                const buffer = Buffer.alloc(Math.min(maxBytes, budget?.remaining ?? maxBytes) + 1);
                let length = 0;
                while (length < buffer.length) {
                    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
                    this.assertCurrent();
                    if (!bytesRead)
                        break;
                    length += bytesRead;
                }
                consume(length);
                await this.safePath(relative);
                if (stamp(before) !== stamp(await file.stat()) || stamp(before) !== stamp(await fs.promises.lstat(filePath))) {
                    throw new Error("Файл правил изменился во время чтения. Повторите запрос.");
                }
                text = buffer.subarray(0, length).toString("utf8");
            }
            finally {
                await file.close();
            }
        }
        await this.validateRead(relative);
        return text;
    }
    async validateRead(relative) {
        const snapshot = this.snapshots.get(relative);
        if (!snapshot)
            throw new Error("Нет подтвержденного чтения правил.");
        const file = await this.safePath(relative, Boolean(snapshot.document));
        let currentStamp;
        try {
            currentStamp = stamp(await fs.promises.lstat(file));
        }
        catch (error) {
            if (!isMissingRulesFile(error))
                throw error;
        }
        this.assertCurrent();
        if (currentStamp !== snapshot.diskStamp || this.dirtyDocument(relative) !== snapshot.document
            || snapshot.document?.version !== snapshot.version) {
            throw new Error("Правила изменились во время сборки контекста. Повторите запрос.");
        }
    }
    async rulePaths() {
        return this.directoryPaths(RULES_DIRECTORY, /\.md$/);
    }
    async directoryPaths(relative, pattern, remember = true) {
        const key = `${relative}\0${pattern}`;
        const existing = this.directories.get(key);
        if (remember && existing)
            return existing.paths;
        await this.checkCurrent();
        const directory = relative === "." ? this.realRoot : await this.safePath(relative);
        const before = stamp(await fs.promises.lstat(directory));
        const names = new Set();
        const handle = await fs.promises.opendir(directory);
        let entries = 0;
        for await (const entry of handle) {
            this.assertCurrent();
            // Fail closed rather than selecting an arbitrary filesystem-order subset.
            if (++entries > exports.SCOPED_RULES_LIMITS.directoryEntries)
                throw new Error("Подбор дополнительных правил усечен: в каталоге больше 256 записей.");
            if (pattern.test(entry.name))
                names.add(entry.name);
        }
        for (const document of vscode.workspace.textDocuments ?? []) {
            if (document.isClosed || !document.isDirty || document.uri.scheme !== "file")
                continue;
            const file = path.resolve(document.uri.fsPath);
            if (![this.absolute(relative), path.join(this.realRoot, relative)].includes(path.dirname(file)))
                continue;
            if (pattern.test(file))
                names.add(path.basename(file));
            if (names.size > exports.SCOPED_RULES_LIMITS.directoryEntries)
                throw new Error("Подбор дополнительных правил усечен: больше 256 файлов и буферов.");
        }
        if (relative !== ".")
            await this.safePath(relative);
        else
            await this.checkCurrent();
        if (stamp(await fs.promises.lstat(directory)) !== before)
            throw new Error("Каталог изменился во время чтения. Повторите запрос.");
        const paths = [...names].sort().map(name => path.posix.join(relative, name));
        if (remember)
            this.directories.set(key, { relative, pattern, stamp: before, paths });
        return paths;
    }
    async validateScopedReads() {
        // Nonmatching, malformed and oversized reads also influenced the selection.
        for (const relative of this.snapshots.keys()) {
            if (relative.startsWith(`${RULES_DIRECTORY}/`) || this.targetReads.has(relative))
                await this.validateRead(relative);
        }
        for (const snapshot of this.directories.values()) {
            const { relative } = snapshot;
            const paths = await this.directoryPaths(relative, snapshot.pattern, false);
            const directory = relative === "." ? this.realRoot : await this.safePath(relative);
            if (stamp(await fs.promises.lstat(directory)) !== snapshot.stamp || JSON.stringify(paths) !== JSON.stringify(snapshot.paths)) {
                throw new Error("Каталог изменился во время сборки контекста. Повторите запрос.");
            }
        }
    }
}
exports.RulesWorkspace = RulesWorkspace;
async function loadScopedRules(workspace, targets) {
    const result = { scopedMatchCount: 0, scopedPaths: [], warnings: [] };
    if (!targets.length)
        return result;
    if (targets.length > exports.SCOPED_RULES_LIMITS.targets)
        result.warnings.push("Подбор целей усечен: использованы первые 64 цели.");
    const confirmed = [];
    for (const target of targets.slice(0, exports.SCOPED_RULES_LIMITS.targets)) {
        try {
            confirmed.push(await workspace.confirmTarget(target));
        }
        catch {
            result.warnings.push("Цель пропущена: путь не подтвержден в текущем workspace или содержит символическую ссылку.");
        }
    }
    result.warnings.push(...workspace.targetWarnings);
    if (!confirmed.length)
        return result;
    let paths;
    try {
        paths = await workspace.rulePaths();
    }
    catch (error) {
        if (!isMissingRulesFile(error))
            result.warnings.push(`Дополнительные правила недоступны: ${error instanceof Error ? error.message : "ошибка чтения каталога"}`);
        return result;
    }
    if (paths.length > exports.SCOPED_RULES_LIMITS.files)
        result.warnings.push("Подбор дополнительных правил усечен: использованы первые 64 файла по имени.");
    const budget = { remaining: exports.SCOPED_RULES_LIMITS.totalBytes };
    let text = "";
    for (const relative of paths.slice(0, exports.SCOPED_RULES_LIMITS.files)) {
        if (budget.remaining <= 0) {
            result.warnings.push("Подбор дополнительных правил усечен: достигнут общий лимит чтения 256 КБ.");
            break;
        }
        try {
            const rule = parseScopedRule(await workspace.read(relative, exports.SCOPED_RULES_LIMITS.fileBytes, budget));
            const matchingPaths = [...new Set(confirmed.filter(target => matchesRule(rule, target)).map(target => target.path))];
            if (!matchingPaths.length)
                continue;
            const scope = formatRuleScope(rule, matchingPaths);
            // Keep the complete scope before the body, including when downstream budgets trim the tail.
            const prefix = `${text ? "\n\n" : ""}[Дополнительные правила проекта]\nИсточник: ${relative}\n${scope.text}\n\nТекст правила:\n`;
            const available = exports.SCOPED_RULES_LIMITS.contextChars - text.length - prefix.length;
            if (available < 2) {
                result.warnings.push(`Контекст дополнительных правил усечен: ${relative} пропущен, полная область действия не помещается в лимит 12000 символов.`);
                continue;
            }
            if (scope.omitted)
                result.warnings.push(`${relative}: список совпавших целей усечен, не показано ${scope.omitted}.`);
            const truncated = rule.body.length > available;
            text += prefix + (truncated ? `${rule.body.slice(0, available - 1)}…` : rule.body);
            result.scopedPaths.push(relative);
            result.scopedMatchCount++;
            if (truncated) {
                result.warnings.push(`Контекст ${relative} усечен: лимит дополнительных правил 12000 символов.`);
                break;
            }
        }
        catch (error) {
            result.warnings.push(`${relative}: правило пропущено; ${error instanceof Error ? error.message : "не удалось прочитать правило"}`);
        }
    }
    // Targets may disappear or turn into symlinks while rule files are being read.
    try {
        for (const target of confirmed)
            await workspace.confirmTarget(target, false);
    }
    catch {
        return { scopedMatchCount: 0, scopedPaths: [], warnings: [...result.warnings, "Цели изменились во время подбора; дополнительные правила не добавлены. Повторите запрос."] };
    }
    try {
        await workspace.validateScopedReads();
    }
    catch {
        return { scopedMatchCount: 0, scopedPaths: [], warnings: [...result.warnings, "Дополнительные правила изменились во время сборки контекста и не добавлены. Повторите запрос."] };
    }
    if (text)
        result.scopedText = text;
    return result;
}
//# sourceMappingURL=scopedProjectRules.js.map
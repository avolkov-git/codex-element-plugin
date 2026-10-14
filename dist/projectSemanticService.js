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
exports.ProjectSemanticService = void 0;
exports.isCompanion = isCompanion;
exports.formatSemanticContext = formatSemanticContext;
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const vscode = __importStar(require("vscode"));
const projectStructure_1 = require("./projectStructure");
const MAX_FILES = 10;
const MAX_DEPTH = 2;
const CONTEXT_CHARS = 32000;
const MAX_SNIPPETS = 20;
/** Query-local semantic neighbourhood, not a speculative global call graph. */
class ProjectSemanticService {
    constructor(ast, language, logger, analysisBudgetMs = 8000) {
        this.ast = ast;
        this.language = language;
        this.logger = logger;
        this.analysisBudgetMs = analysisBudgetMs;
    }
    async buildContext(request) {
        const result = { links: [], snippets: [], documentationQueries: [], diagnostics: [], providers: [], hovers: [] };
        const deadline = Date.now() + this.analysisBudgetMs;
        let supplementalReady = true;
        const staleFiles = new Set();
        const candidates = [...new Set(request.selected.filter((item) => /\.(xbsl|ya?ml)$/i.test(item.path)).map((item) => item.path))];
        const explicitFiles = candidates.filter(file => containsIdentifier(request.query, path.posix.basename(file).replace(/\.(xbsl|ya?ml)$/i, "")));
        const seeds = [];
        for (const file of explicitFiles.length ? explicitFiles : candidates) {
            // A YAML/XBSL pair is one seed, so comparing two elements cannot spend both slots on the first pair.
            if (seeds.some(seed => isCompanion(seed, file)))
                continue;
            seeds.push(file);
            if (seeds.length === 2)
                break;
        }
        const selectedFiles = new Set(seeds);
        for (const seed of selectedFiles) {
            for (const file of request.files) {
                if (isCompanion(seed, file.path) && selectedFiles.size < 6)
                    selectedFiles.add(file.path);
            }
        }
        const sources = new Map();
        const structures = new Map();
        const symbols = new Map();
        const trees = new Map();
        const docs = new Set();
        const attemptedFiles = new Set();
        const inspectedPositions = new Map();
        const intent = contextIntent(request.query);
        result.selection = { intent, maxDepth: MAX_DEPTH, budgetChars: CONTEXT_CHARS, omittedRanges: 0 };
        const loadFile = async (filePath, focus = []) => {
            if (attemptedFiles.has(filePath))
                return;
            if (attemptedFiles.size >= MAX_FILES) {
                result.diagnostics.push(`${filePath}: достигнут лимит связанных файлов; используйте project.readFile для продолжения.`);
                return;
            }
            attemptedFiles.add(filePath);
            try {
                const source = await withinDeadline(() => request.readFile(filePath), deadline);
                if (!source) {
                    result.diagnostics.push("Бюджет ожидания дополнительного контекста исчерпан; оставшиеся файлы не анализировались.");
                    return;
                }
                if (source.truncated) {
                    result.diagnostics.push(`${filePath}: файл превышает лимит полного разбора; AST не построен.`);
                    return;
                }
                sources.set(filePath, source);
                const structure = (0, projectStructure_1.analyzeProjectStructure)(filePath, source.text);
                structures.set(filePath, structure);
                result.diagnostics.push(...structure.errors.slice(0, 3).map((error) => `${filePath}: ${error}`));
                symbols.set(filePath, structure.symbols.map((symbol) => ({ symbol, source: /\.xbsl$/i.test(filePath) ? "lexical" : "yaml",
                    scope: lexicalScope(symbol, source.text) })));
                const isXbsl = /\.xbsl$/i.test(filePath);
                const controller = new AbortController();
                const ast = isXbsl ? await withinDeadline(() => this.ast.parse(source.text, { signal: controller.signal }), deadline, () => controller.abort()) : undefined;
                const provider = { path: filePath, ast: isXbsl ? ast?.status ?? "budget-exhausted" : "not-applicable", lsp: "unavailable", parserVersion: ast?.parserVersion };
                result.providers.push(provider);
                if (ast?.root) {
                    trees.set(filePath, ast.root);
                    const declarations = declarationsFromAst(ast.root, source.text, structure.symbols);
                    symbols.set(filePath, declarations);
                }
                if (isXbsl && ast?.status !== "ready")
                    result.diagnostics.push(`${filePath}: штатный AST ${provider.ast}; ${ast?.reason ?? "используется структурный индекс"}`);
                if (ast?.diagnostics?.length)
                    result.diagnostics.push(`${filePath}: синтаксические замечания штатного парсера (${ast.diagnostics.length}); дерево может быть неполным.`);
                const refs = structure.references.filter((reference) => reference.kind !== "id")
                    .sort((a, b) => Number(containsIdentifier(request.query, b.name)) - Number(containsIdentifier(request.query, a.name)));
                const named = (symbols.get(filePath) ?? []).filter(entry => containsIdentifier(request.query, entry.symbol.name));
                const focusRanges = focus.length ? focus : named.length ? named.map(entry => entry.symbol)
                    : request.selected.filter(item => item.path === filePath).slice(0, 2);
                const positions = ast?.root ? positionsFromAst(ast.root, source.text, request.query, focusRanges) : [];
                for (const reference of refs) {
                    if (positions.length >= 3)
                        break;
                    const line = source.text.split(/\r?\n/)[reference.startLine - 1] ?? "";
                    const character = line.indexOf(reference.name);
                    if (character >= 0)
                        positions.push({ line: reference.startLine - 1, character });
                }
                const language = await withinDeadline(() => this.language.inspect(vscode.Uri.file(path.join(request.workspaceRoot, filePath)), positions), deadline);
                inspectedPositions.set(filePath, new Set(positions.map(position => `${position.line}:${position.character}`)));
                if (!language) {
                    provider.lsp = "budget-exhausted";
                    return;
                }
                provider.lsp = language.status;
                if (language.sourceHash && language.sourceHash !== (0, crypto_1.createHash)("sha256").update(source.text).digest("hex")) {
                    result.diagnostics.push(`${filePath}: документ изменился во время анализа; ответ LSP не использован.`);
                    staleFiles.add(filePath);
                    sources.delete(filePath);
                    structures.delete(filePath);
                    symbols.delete(filePath);
                    trees.delete(filePath);
                    return;
                }
                // LSP is authoritative only for returned facts, never for absence of a result.
                symbols.set(filePath, mergeLanguageSymbols(symbols.get(filePath) ?? [], language.symbols, !!ast?.root));
                // Provider-specific definitions/hover are attached below after normalization.
                this.addLanguageFacts(result, language, filePath, request, source.text, docs);
            }
            catch (error) {
                result.diagnostics.push(`${filePath}: дополнительный контекст недоступен.`);
                this.logger.warn(`Project semantic context: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        for (const filePath of selectedFiles)
            await loadFile(filePath);
        for (const [filePath, structure] of structures) {
            if (!/\.ya?ml$/i.test(filePath))
                continue;
            const references = relevantYamlReferences(structure, request.query, request.selected.filter(item => item.path === filePath));
            for (const reference of references) {
                if (result.links.length >= 48)
                    break;
                if (reference.kind !== "handler" && reference.kind !== "expression" && reference.kind !== "type")
                    continue;
                if (reference.kind === "type")
                    addDocumentationTerms(docs, reference.name);
                const targets = [];
                for (const [candidatePath, candidates] of symbols) {
                    if (!isCompanion(filePath, candidatePath) || !/\.xbsl$/i.test(candidatePath))
                        continue;
                    for (const candidate of candidates) {
                        if (candidate.scope === "module" && candidate.symbol.name === reference.name && isMethodKind(candidate.symbol.kind)) {
                            targets.push({ path: candidatePath, startLine: candidate.symbol.startLine, endLine: candidate.symbol.endLine });
                        }
                    }
                }
                if (reference.kind === "type") {
                    for (const candidate of request.files) {
                        if (!staleFiles.has(candidate.path) && candidate.structure?.element?.name === reference.name && sameProject(filePath, candidate.path, request.files)) {
                            targets.push({ path: candidate.path, startLine: 1, endLine: 20 });
                        }
                    }
                }
                const unique = uniqueTargets(targets);
                result.links.push({ from: { path: filePath, startLine: reference.startLine, endLine: reference.endLine },
                    name: reference.name, kind: reference.kind,
                    confidence: unique.length > 1 ? "ambiguous" : unique.length === 1 ? (reference.kind === "type" ? "candidate" : "structural") : "unresolved",
                    targets: unique.slice(0, 6) });
            }
        }
        const requests = [];
        const queued = new Set();
        const enqueue = (range) => {
            const key = `${range.path}:${range.startLine}:${range.endLine}:${range.purpose}`;
            if (queued.has(key))
                return;
            queued.add(key);
            requests.push(range);
        };
        for (const [filePath, entries] of symbols) {
            const named = entries.filter(entry => containsIdentifier(request.query, entry.symbol.name));
            for (const { symbol, source } of entries) {
                if (!containsIdentifier(request.query, symbol.name))
                    continue;
                const focusedYaml = source === "yaml" && symbol.kind === "yaml-element"
                    && structures.get(filePath)?.references.some(reference => reference.kind !== "type" && containsIdentifier(request.query, reference.name));
                enqueue({ path: filePath, ...symbol, endLine: focusedYaml ? Math.min(symbol.endLine, symbol.startLine + 10) : symbol.endLine, source,
                    purpose: source === "yaml" ? "evidence" : intent, priority: source === "yaml" ? 75 : 110, depth: 0,
                    reason: focusedYaml ? "Идентичность элемента YAML; обработчики показаны отдельно" : "Объявление названо в запросе" });
            }
            if (!named.length && /\.xbsl$/i.test(filePath)) {
                const selected = request.selected.filter(item => item.path === filePath).slice(0, 2);
                for (const selection of selected) {
                    const candidates = entries.filter(entry => overlaps(entry.symbol, selection))
                        .sort((a, b) => Number(selection.symbols.includes(b.symbol.name)) - Number(selection.symbols.includes(a.symbol.name))
                        || a.symbol.startLine - b.symbol.startLine).slice(0, 2);
                    for (const entry of candidates)
                        enqueue({ path: filePath, ...entry.symbol, source: entry.source,
                            purpose: intent, priority: 65, depth: 0, reason: "Объявление в найденном участке кода" });
                }
            }
        }
        for (const link of result.links) {
            if (link.kind === "definition")
                continue; // Follow provider facts only from the focused declarations below.
            enqueue({ ...link.from, startLine: Math.max(1, link.from.startLine - 2), endLine: link.from.endLine + 2,
                source: "yaml", purpose: "evidence", priority: 85, depth: 0, reason: `YAML: ${link.kind} ${link.name}` });
            for (const target of link.targets.slice(0, 2)) {
                const matched = symbols.get(target.path)?.find((entry) => entry.symbol.startLine === target.startLine);
                enqueue({ ...target, source: matched?.source ?? "yaml", purpose: /\.xbsl$/i.test(target.path) ? intent : "evidence",
                    priority: 90, depth: 0, reason: `Цель YAML-ссылки ${link.name} [${link.confidence}]` });
            }
        }
        for (const selected of request.selected.slice(0, 3)) {
            if (!sources.has(selected.path))
                continue;
            if (/\.ya?ml$/i.test(selected.path)) {
                const structure = structures.get(selected.path);
                const named = structure.symbols.filter(symbol => containsIdentifier(request.query, symbol.name));
                const local = named.filter(symbol => symbol.kind !== "yaml-element");
                const ranges = local.length ? local : [{ startLine: selected.startLine, endLine: Math.min(selected.endLine, selected.startLine + 45) }];
                for (const range of ranges)
                    enqueue({ path: selected.path, ...range, source: "yaml", purpose: "evidence",
                        priority: 60, depth: 0, reason: "Контекст элемента YAML" });
            }
            else if (!requests.some(item => item.path === selected.path))
                enqueue({ ...selected, source: "lexical", purpose: "evidence",
                    priority: 50, depth: 0, reason: "Поисковое совпадение без полного объявления" });
        }
        const expanded = new Set();
        const resolvedRanges = [];
        let additionalInspections = 0;
        // Breadth first: preserve the requested bodies before spending budget on their dependencies.
        for (let cursor = 0; cursor < requests.length && cursor < 64; cursor++) {
            const selection = requests[cursor];
            if (staleFiles.has(selection.path))
                continue;
            await loadFile(selection.path, [selection]);
            const source = sources.get(selection.path);
            if (!source || staleFiles.has(selection.path))
                continue;
            const entries = symbols.get(selection.path) ?? [];
            const entry = enclosingDeclaration(entries, selection);
            const range = entry && /\.xbsl$/i.test(selection.path) ? { ...selection, ...entry.symbol, source: entry.source } : selection;
            if (range.purpose === "declaration" && entry && isMethodKind(entry.symbol.kind)) {
                range.endLine = declarationEndLine(entry, source.text);
            }
            resolvedRanges.push(range);
            const expansionKey = `${selection.path}:${entry?.symbol.startLine ?? selection.startLine}`;
            if (expanded.has(expansionKey))
                continue;
            expanded.add(expansionKey);
            if (entry?.astNode)
                collectAstDocumentation(entry.astNode, source.text, docs, range.purpose === "declaration");
            if (/\.xbsl$/i.test(selection.path)) {
                for (const reference of structures.get(selection.path)?.references ?? []) {
                    if (reference.kind === "import")
                        enqueue({ path: selection.path, startLine: reference.startLine, endLine: reference.endLine,
                            source: entry?.source ?? "lexical", purpose: "evidence", priority: 80, depth: range.depth, reason: "Импорт пространства имён" });
                }
            }
            if (range.depth >= MAX_DEPTH || range.purpose === "declaration")
                continue;
            const root = trees.get(selection.path);
            if (root && Date.now() < deadline && additionalInspections < 6) {
                const seen = inspectedPositions.get(selection.path) ?? new Set();
                const positions = positionsFromAst(root, source.text, request.query, [range], 24)
                    .filter(position => !seen.has(`${position.line}:${position.character}`)).slice(0, 4);
                if (positions.length) {
                    additionalInspections++;
                    positions.forEach(position => seen.add(`${position.line}:${position.character}`));
                    inspectedPositions.set(selection.path, seen);
                    try {
                        const language = await withinDeadline(() => this.language.inspect(vscode.Uri.file(path.join(request.workspaceRoot, selection.path)), positions), deadline);
                        if (language?.sourceHash && language.sourceHash !== (0, crypto_1.createHash)("sha256").update(source.text).digest("hex")) {
                            staleFiles.add(selection.path);
                            continue;
                        }
                        if (language)
                            this.addLanguageFacts(result, language, selection.path, request, source.text, docs);
                        if (language?.status !== "ready" || language.truncated)
                            supplementalReady = false;
                    }
                    catch {
                        supplementalReady = false;
                        result.diagnostics.push(`${selection.path}: не удалось дополнить определения Language Server.`);
                    }
                }
            }
            const definitions = result.links.filter(link => link.kind === "definition" && link.from.path === selection.path && overlaps(link.from, range));
            for (const link of definitions) {
                for (const target of link.targets.slice(0, 2))
                    enqueue({ ...target, source: "lsp", purpose: "implementation",
                        priority: 88 - range.depth * 5, depth: range.depth + 1, reason: `Определение ${link.name} из Language Server` });
            }
            const method = entry?.astNode;
            if (entry?.scope !== "module" || method?.kind !== "Method")
                continue;
            const calls = [];
            walkTree(method, node => { if (/MethodInvocation$/.test(node.kind))
                calls.push(node); }, node => node !== method && (isAstDeclaration(node.kind) || node.kind === "Lambda"));
            for (const call of calls.sort((a, b) => a.startOffset - b.startOffset).slice(0, 12)) {
                const nameNode = invocationName(call);
                const name = nameNode?.attributes.name;
                if (typeof name !== "string")
                    continue;
                const offset = identifierOffset(nameNode, source.text);
                const position = offset === undefined ? undefined : positionAtOffset(source.text, offset);
                const from = position
                    ? { path: selection.path, startLine: position.line + 1, endLine: position.line + 1,
                        startCharacter: position.character, endCharacter: position.character + name.length }
                    : { path: selection.path, startLine: call.startLine, endLine: call.endLine };
                if (position && definitions.some(link => link.name === name && link.from.startLine === from.startLine
                    && link.from.startCharacter === from.startCharacter))
                    continue;
                let candidateFiles = [selection.path];
                let kind = "native-call";
                if (call.kind !== "StaticMethodInvocation" || hasNamespace(nameNode)) {
                    // Only an explicit shared-module receiver is a structural candidate. Object dispatch needs LSP.
                    const receiver = call.children.find(node => node.role === "prefix")?.children.find(node => node.role === "source");
                    const moduleName = receiver?.kind === "StaticVariableAccess" ? receiver.attributes.name : undefined;
                    if (typeof moduleName !== "string" || hasNamespace(receiver) || shadowsName(method, moduleName)) {
                        result.links.push({ from,
                            kind: "dynamic-call", name, confidence: "unresolved", targets: [] });
                        continue;
                    }
                    const modules = request.files.filter(file => sameProject(selection.path, file.path, request.files)
                        && file.structure?.element?.name === moduleName && /^(ОбщийМодуль|CommonModule)$/i.test(file.structure.element.kind ?? ""));
                    const verifiedModules = [];
                    for (const module of modules.slice(0, 3)) {
                        await loadFile(module.path);
                        const element = structures.get(module.path)?.element;
                        if (element?.name !== moduleName || !/^(ОбщийМодуль|CommonModule)$/i.test(element.kind ?? "") || staleFiles.has(module.path))
                            continue;
                        verifiedModules.push(module.path);
                        enqueue({ path: module.path, startLine: 1, endLine: 12, source: "yaml", purpose: "evidence",
                            priority: 70, depth: range.depth + 1, reason: "Идентичность и окружение общего модуля" });
                    }
                    candidateFiles = request.files.filter(file => /\.xbsl$/i.test(file.path) && verifiedModules.some(module => isCompanion(module, file.path)))
                        .map(file => file.path);
                    kind = "module-call";
                    if (!candidateFiles.length) {
                        result.links.push({ from,
                            kind: "dynamic-call", name, confidence: "unresolved", targets: [] });
                        continue;
                    }
                }
                if (kind === "native-call" && shadowsName(method, name))
                    continue;
                const targets = [];
                for (const candidate of candidateFiles.slice(0, 3)) {
                    await loadFile(candidate);
                    for (const target of symbols.get(candidate) ?? []) {
                        if (target.scope === "module" && target.symbol.name === name && isMethodKind(target.symbol.kind)) {
                            targets.push({ path: candidate, startLine: target.symbol.startLine, endLine: target.symbol.endLine });
                        }
                    }
                }
                const unique = uniqueTargets(targets);
                const link = { from, kind, name,
                    confidence: unique.length > 1 || candidateFiles.length > 1 ? "ambiguous" : unique.length ? "candidate" : "unresolved", targets: unique };
                if (!result.links.some(existing => linkKey(existing) === linkKey(link)))
                    result.links.push(link);
                for (const target of unique.slice(0, 2))
                    enqueue({ ...target, source: "native-ast", purpose: "implementation",
                        priority: 85 - range.depth * 5, depth: range.depth + 1, reason: `${kind}: ${name} [${link.confidence}]` });
            }
        }
        result.selection.omittedRanges += Math.max(0, requests.length - 64);
        const selections = mergeContextRanges(resolvedRanges).sort((a, b) => b.priority - a.priority || a.depth - b.depth);
        let remaining = CONTEXT_CHARS;
        for (const selection of selections) {
            if (remaining < 500 || result.snippets.length >= MAX_SNIPPETS) {
                result.selection.omittedRanges++;
                continue;
            }
            if (staleFiles.has(selection.path))
                continue;
            const source = sources.get(selection.path);
            const lines = source.text.split(/\r?\n/);
            const endLine = Math.min(lines.length, selection.endLine);
            if (selection.startLine > endLine)
                continue;
            const content = lines.slice(selection.startLine - 1, endLine).join("\n");
            const limit = Math.min(remaining, 24000);
            const truncated = source.truncated || content.length > limit;
            const text = truncated ? `${content.slice(0, limit)}\n[Фрагмент обрезан: метод показан не целиком]` : content;
            remaining -= text.length;
            result.snippets.push({ ...selection, endLine, text, hash: (0, crypto_1.createHash)("sha256").update(source.text).digest("hex"),
                fromOpenDocument: source.fromOpenDocument, truncated });
        }
        if (result.selection.omittedRanges)
            result.diagnostics.push(`Не включено связанных участков: ${result.selection.omittedRanges}; продолжите через project.readFile. Отсутствие в контексте не означает отсутствия зависимости.`);
        result.links = [...new Map(result.links.map(link => [linkKey(link), link])).values()];
        // A one-line definition points at a declaration; publish the complete resolved range for navigation.
        for (const link of result.links)
            link.targets = link.targets.map(target => {
                const declaration = enclosingDeclaration(symbols.get(target.path) ?? [], target);
                return declaration ? { path: target.path, startLine: declaration.symbol.startLine, endLine: declaration.symbol.endLine } : target;
            });
        const projectNames = new Set(request.files.map((file) => file.structure?.element?.name).filter(Boolean));
        result.documentationQueries = [...docs].filter((name) => !projectNames.has(name)).slice(0, 6);
        // Do not combine ranges from an earlier revision with the current editor buffer.
        // Reserve one bounded validation window, even if optional analysis used its budget.
        const validationDeadline = Date.now() + Math.min(1000, this.analysisBudgetMs);
        for (const [filePath, snapshot] of sources) {
            try {
                const current = await withinDeadline(() => request.readFile(filePath), validationDeadline);
                if (!current || current.text !== snapshot.text || current.truncated !== snapshot.truncated)
                    staleFiles.add(filePath);
            }
            catch {
                staleFiles.add(filePath);
            }
        }
        if (staleFiles.size) {
            result.links = result.links.filter((link) => !staleFiles.has(link.from.path) && !link.targets.some((target) => staleFiles.has(target.path)));
            result.snippets = result.snippets.filter((snippet) => !staleFiles.has(snippet.path));
            result.hovers = result.hovers.filter((hover) => !staleFiles.has(hover.path));
            result.documentationQueries = [];
            result.diagnostics.push(`Актуальность документов не подтверждена; связанные фрагменты исключены: ${[...staleFiles].join(", ")}.`);
        }
        result.cacheable = supplementalReady && !staleFiles.size && !result.diagnostics.length
            && result.snippets.length > 0 && result.snippets.every(snippet => !snippet.truncated)
            && !result.selection.omittedRanges && result.providers.length > 0
            && result.providers.every(provider => provider.lsp === "ready" && ["ready", "not-applicable"].includes(provider.ast));
        return result;
    }
    addLanguageFacts(result, language, filePath, request, text, docs) {
        const lines = text.split(/\r?\n/);
        for (const query of language.queries) {
            const line = lines[query.position.line] ?? "";
            const identifier = line.slice(query.position.character).match(/^[\p{L}_][\p{L}\p{N}_]*/u)?.[0];
            const name = identifier ?? "символ";
            if (query.hover) {
                result.hovers.push({ path: filePath, line: query.position.line + 1, text: query.hover.slice(0, 1200) });
                if (name !== "символ")
                    docs.add(name);
            }
            const targets = [];
            for (const definition of query.definitions) {
                let uri;
                try {
                    uri = vscode.Uri.parse(definition.uri);
                }
                catch {
                    continue;
                }
                if (uri.scheme !== "file")
                    continue;
                const indexedPath = indexedDefinitionPath(request, uri.fsPath);
                if (!indexedPath)
                    continue;
                const range = definition.selectionRange ?? definition;
                targets.push({ path: indexedPath, startLine: range.startLine, endLine: inclusiveEndLine(range) });
            }
            const unique = uniqueTargets(targets);
            if (unique.length)
                result.links.push({ from: { path: filePath, startLine: query.position.line + 1, endLine: query.position.line + 1,
                        startCharacter: query.position.character, endCharacter: query.position.character + (identifier?.length ?? 0) },
                    name, kind: "definition", confidence: unique.length > 1 ? "ambiguous" : "lsp", targets: unique });
        }
    }
}
exports.ProjectSemanticService = ProjectSemanticService;
function indexedDefinitionPath(request, fsPath) {
    const relative = path.relative(request.workspaceRoot, fsPath).split(path.sep).join("/");
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith("../"))
        return undefined;
    // Only Windows paths admit casing differences; retain the indexed spelling for reads and hashes.
    // Ambiguous identities fail closed, and readFile still rechecks realpath against the workspace.
    const matches = request.files.filter(file => path.sep === "\\"
        ? file.path.toLowerCase() === relative.toLowerCase() : file.path === relative);
    return matches.length === 1 ? matches[0].path : undefined;
}
function inclusiveEndLine(range) {
    return range.endCharacter === 0 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
}
function isCompanion(left, right) {
    if (left === right || path.posix.dirname(left) !== path.posix.dirname(right))
        return false;
    const yaml = /\.ya?ml$/i.test(left) ? left : /\.ya?ml$/i.test(right) ? right : undefined;
    const xbsl = /\.xbsl$/i.test(left) ? left : /\.xbsl$/i.test(right) ? right : undefined;
    if (!yaml || !xbsl)
        return false;
    const base = yaml.replace(/\.ya?ml$/i, "");
    const code = xbsl.replace(/\.xbsl$/i, "");
    return code === base || code.startsWith(`${base}.`);
}
function isMethodKind(kind) {
    return /^(?:5|11|method|abstractmethod|function|lexical-(?:abstract-)?(?:method|function)(?:-partial)?)$/i.test(kind);
}
async function withinDeadline(run, deadline, cancel) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        return undefined;
    let timer;
    try {
        return await Promise.race([
            run(),
            new Promise((resolve) => { timer = setTimeout(() => { cancel?.(); resolve(undefined); }, remaining); })
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function sameProject(left, right, files) {
    const rootOf = (file) => files.filter((entry) => /(^|\/)(project|проект)\.ya?ml$/i.test(entry.path))
        .map((entry) => path.posix.dirname(entry.path)).filter((dir) => dir === "." || file.startsWith(`${dir}/`))
        .sort((a, b) => b.length - a.length)[0];
    const leftRoot = rootOf(left);
    return leftRoot ? leftRoot === rootOf(right) : path.posix.dirname(left) === path.posix.dirname(right);
}
function uniqueTargets(targets) {
    return [...new Map(targets.map((target) => [`${target.path}:${target.startLine}:${target.endLine}`, target])).values()];
}
function walkTree(root, visit, skip) {
    const pending = [{ node: root }];
    while (pending.length) {
        const { node, parent } = pending.pop();
        if (skip?.(node))
            continue;
        visit(node, parent);
        for (const child of node.children)
            pending.push({ node: child, parent: node });
    }
}
function isAstDeclaration(kind) {
    return /^(?:Bsl)?(?:Method|AbstractMethod|Type|Object|Enum|Const|Constant|Structure|Class|Interface)(?:Declaration)?$/.test(kind);
}
function declarationsFromAst(root, text, lexical) {
    const symbols = [];
    const lines = text.split(/\r?\n/);
    walkTree(root, (node, parent) => {
        const name = node.attributes.name;
        if (typeof name !== "string" || !isAstDeclaration(node.kind) || node.startLine < 1)
            return;
        const declaration = lexical.find((symbol) => symbol.name === name && isMethodKind(symbol.kind) === isMethodKind(node.kind)
            && symbol.selectionLine >= node.startLine && symbol.selectionLine <= node.endLine);
        const selectionLine = declaration?.selectionLine ?? node.startLine;
        const line = lines[selectionLine - 1] ?? "";
        symbols.push({ symbol: { name, kind: node.kind, startLine: node.startLine, endLine: node.endLine,
                selectionLine, selectionCharacter: declaration?.selectionCharacter ?? Math.max(0, line.indexOf(name)) },
            source: "native-ast", scope: !parent || parent.kind === "Module" ? "module" : "nested", astNode: node });
    });
    return symbols;
}
function lexicalScope(symbol, text) {
    const rawLine = text.split(/\r?\n/)[symbol.selectionLine - 1];
    const line = symbol.selectionLine === 1 ? rawLine?.replace(/^\uFEFF/, "") : rawLine;
    return !line ? "unknown" : /^\s/.test(line) ? "nested" : "module";
}
function mergeLanguageSymbols(current, incoming, hasAst) {
    const merged = [...current];
    for (const symbol of incoming) {
        const location = symbol.selectionRange ?? symbol;
        const matches = merged.filter((entry) => entry.symbol.name === symbol.name && isMethodKind(entry.symbol.kind) === isMethodKind(String(symbol.kind))
            && location.startLine >= entry.symbol.startLine && location.startLine <= entry.symbol.endLine);
        const precise = matches.filter((entry) => entry.symbol.selectionLine === location.startLine
            && (location.startCharacter === undefined || entry.symbol.selectionCharacter === location.startCharacter));
        const match = precise.length === 1 ? precise[0] : matches.length === 1 ? matches[0] : undefined;
        // The parser range includes annotations and owns scope. An LSP selection inside it is the same declaration.
        if (match?.source === "native-ast")
            continue;
        const scope = lspScope(symbol, incoming);
        const entry = { symbol: {
                name: symbol.name, kind: String(symbol.kind), startLine: symbol.startLine, endLine: inclusiveEndLine(symbol),
                selectionLine: location.startLine, selectionCharacter: location.startCharacter ?? 0
            }, source: "lsp", scope: hasAst ? "unknown" : scope === "nested" || match?.scope === "nested" ? "nested" : scope };
        if (match)
            merged[merged.indexOf(match)] = entry;
        else
            merged.push(entry);
    }
    return merged;
}
function lspScope(symbol, symbols) {
    const endLine = inclusiveEndLine(symbol);
    const containers = symbols.filter((candidate) => candidate !== symbol && candidate.startLine <= symbol.startLine && inclusiveEndLine(candidate) >= endLine
        && (candidate.startLine < symbol.startLine || inclusiveEndLine(candidate) > endLine));
    // File/Module wrappers do not introduce a class/method scope; all other containers do.
    if (containers.some((container) => container.kind !== 0 && container.kind !== 1))
        return "nested";
    if (symbol.containerName) {
        return containers.some((container) => container.name === symbol.containerName && (container.kind === 0 || container.kind === 1)) ? "module" : "nested";
    }
    return "module";
}
function containsIdentifier(text, name) {
    return (text.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []).some((word) => word.toLowerCase() === name.toLowerCase());
}
function collectAstDocumentation(root, text, docs, declarationOnly = false) {
    walkTree(root, (node) => {
        if (/TypeName/.test(node.kind) && node.endOffset > node.startOffset) {
            addDocumentationTerms(docs, text.slice(node.startOffset, node.endOffset));
        }
    }, node => declarationOnly && node.role === "statements");
}
function positionsFromAst(root, text, query, focus = [], limit = 3) {
    const candidates = [];
    walkTree(root, (node) => {
        const invocation = /MethodInvocation$/.test(node.kind);
        const prefix = invocation ? node.children.find((child) => child.role === "prefix") : undefined;
        const named = invocation ? prefix?.children.find((child) => child.role === "name") ?? prefix : node.kind === "TypeName" ? node : undefined;
        const offset = identifierOffset(named, text);
        if (offset === undefined || typeof named?.attributes.name !== "string")
            return;
        if (focus.length && !focus.some(range => overlaps(node, range)) && !containsIdentifier(query, named.attributes.name))
            return;
        candidates.push({ offset, score: containsIdentifier(query, named.attributes.name) ? 2 : invocation ? 1 : 0 });
    });
    const offsets = [...new Set(candidates.sort((a, b) => b.score - a.score || a.offset - b.offset).map((item) => item.offset))].slice(0, limit);
    return offsets.map(offset => positionAtOffset(text, offset));
}
function identifierOffset(node, text) {
    if (!node || typeof node.attributes.name !== "string" || node.startOffset < 0 || node.endOffset <= node.startOffset)
        return undefined;
    // Use the native name node, not the start of a receiver or a whole generic type.
    const identifiers = [...text.slice(node.startOffset, node.endOffset).matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)];
    const identifier = identifiers.reverse().find(match => match[0] === node.attributes.name);
    return identifier ? node.startOffset + identifier.index : undefined;
}
function positionAtOffset(text, offset) {
    const prefix = text.slice(0, offset);
    return { line: (prefix.match(/\n/g) ?? []).length, character: offset - prefix.lastIndexOf("\n") - 1 };
}
function contextIntent(query) {
    // Omitting implementation requires an explicit opt-in; mixed or unclear requests keep bodies.
    if (!/(?:сигнатур|\bsignatures?\b)/iu.test(query))
        return "implementation";
    const withoutBody = /(?:тело\s+(?:метода\s+)?не\s+(?:нужно|нужен|требуется|показывай)|без\s+тела(?:\s+метода)?|(?:do\s+not|don['’]t)\s+(?:show|include)\s+(?:the\s+)?(?:method\s+)?body|without\s+(?:the\s+)?(?:method\s+)?body)/giu;
    const request = query.replace(withoutBody, "");
    if (/(?<![\p{L}\p{N}_])(?:не|not|never|don['’]t)(?![\p{L}\p{N}_])/iu.test(request))
        return "implementation";
    if (/(?:почему|как\s+работает|исправ|измен|ошиб|провер|реализац|тело|логик|алгоритм|поведени|\b(?:why|fix|implement\w*|algorithm\w*|behavio\w*|body|explain)\b)/iu.test(request))
        return "implementation";
    // Signature facets can be listed together; other additional requests need implementation.
    const signatureFacet = /^(?:(?:его|е[её]|их|the|its|their)\s+)?(?:параметр[\p{L}]*|аргумент[\p{L}]*|значени[\p{L}]*\s+по\s+умолчанию|возвращаем[\p{L}]*\s+тип[\p{L}]*|тип[\p{L}]*|return\s+types?|parameters?|arguments?|default\s+values?)(?![\p{L}\p{N}_])/iu;
    for (const conjunction of request.matchAll(/(?<![\p{L}\p{N}_])(?:и|также|плюс|and|also)(?![\p{L}\p{N}_])\s*/giu)) {
        if (!signatureFacet.test(request.slice(conjunction.index + conjunction[0].length)))
            return "implementation";
    }
    const onlySignature = /(?:(?:только|лишь|исключительно)\s+сигнатур|\b(?:only|just)\s+(?:[\p{L}\p{N}_'’]+\s+){0,3}signatures?\b|\bsignatures?\s+only\b)/iu.test(request);
    return onlySignature || request !== query ? "declaration" : "implementation";
}
function overlaps(left, right) {
    return left.startLine <= right.endLine && right.startLine <= left.endLine;
}
function enclosingDeclaration(entries, range) {
    return entries.filter(entry => entry.symbol.startLine <= range.startLine && entry.symbol.endLine >= range.endLine)
        .sort((a, b) => (a.symbol.endLine - a.symbol.startLine) - (b.symbol.endLine - b.symbol.startLine))[0];
}
function declarationEndLine(entry, text) {
    const statements = entry.astNode?.children.filter(node => node.role === "statements") ?? [];
    if (statements.length)
        return Math.max(entry.symbol.selectionLine, Math.min(...statements.map(node => node.startLine)) - 1);
    // A lexical range does not distinguish a multiline signature from a body. Keep it rather than guess.
    return entry.symbol.endLine;
}
function invocationName(call) {
    const prefix = call.children.find(node => node.role === "prefix");
    return prefix?.children.find(node => node.role === "name") ?? prefix;
}
function hasNamespace(node) {
    return Array.isArray(node?.attributes.namespace) && node.attributes.namespace.length > 0;
}
function shadowsName(method, name) {
    let found = false;
    walkTree(method, node => {
        if (/^(Parameter|Variable|VariableDeclaration|DeclareVariableStatement|Const|Constant)$/.test(node.kind) && node.attributes.name === name)
            found = true;
    });
    return found;
}
function linkKey(link) {
    return JSON.stringify([link.from, link.kind, link.name, link.confidence, link.targets]);
}
function relevantYamlReferences(structure, query, selected) {
    const references = structure.references.filter(reference => ["handler", "expression", "type"].includes(reference.kind));
    const direct = references.filter(reference => containsIdentifier(query, reference.name));
    const containers = structure.symbols.filter(symbol => symbol.kind === "yaml-name" && containsIdentifier(query, symbol.name));
    const parents = new Set(direct.map(reference => reference.yamlPath?.replace(/\.[^.]+$/, "")).filter(Boolean));
    const focused = references.filter(reference => direct.includes(reference)
        || containers.some(container => container.startLine <= reference.startLine && container.endLine >= reference.endLine)
        || (reference.yamlPath && parents.has(reference.yamlPath.replace(/\.[^.]+$/, ""))));
    const candidates = focused.length ? focused : references.filter(reference => !selected.length || selected.some(range => overlaps(reference, range)));
    const baseTypes = references.filter(reference => reference.kind === "type" && (reference.yamlPath?.split(".").length ?? 0) <= 3).slice(0, 4);
    return [...new Set([...candidates, ...baseTypes])].sort((a, b) => Number(direct.includes(b)) - Number(direct.includes(a)) || a.startLine - b.startLine).slice(0, 14);
}
function mergeContextRanges(ranges) {
    const merged = [];
    for (const range of [...ranges].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || b.endLine - a.endLine)) {
        const previous = merged[merged.length - 1];
        if (previous?.path === range.path && overlaps(previous, range)) {
            previous.endLine = Math.max(previous.endLine, range.endLine);
            previous.priority = Math.max(previous.priority, range.priority);
            previous.depth = Math.min(previous.depth, range.depth);
            if (range.purpose === "implementation")
                previous.purpose = "implementation";
            if (range.source === "native-ast" || (range.source === "lsp" && previous.source !== "native-ast"))
                previous.source = range.source;
            previous.reason = [...new Set([previous.reason, range.reason])].join("; ");
        }
        else
            merged.push({ ...range });
    }
    return merged;
}
function addDocumentationTerms(terms, type) {
    for (const term of type.match(/[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*/gu) ?? []) {
        if (term.length >= 3 && terms.size < 30)
            terms.add(term);
    }
}
function formatSemanticContext(context, maxChars = Number.POSITIVE_INFINITY) {
    const header = [
        "[PROJECT STRUCTURE: YAML + XBSL + LSP + native AST]",
        "Связи structural подтверждают совпадение YAML-ссылки и объявления в парном модуле, но не семантическое связывание компилятора. candidate/ambiguous требуют проверки. AST не доказывает корректность типов. Правила проекта остаются отдельными требованиями.",
        ...(context.selection ? [`Подбор: ${context.selection.intent === "declaration" ? "сигнатуры; тела намеренно не включены" : "реализация и зависимости"}; глубина до ${context.selection.maxDepth}; пропущено участков: ${context.selection.omittedRanges}. Это ограниченное окружение задачи, не полный граф проекта.`] : []),
        ...context.diagnostics.slice(0, 3).map(diagnostic => `Замечание: ${diagnostic.length > 240 ? `${diagnostic.slice(0, 239)}…` : diagnostic}`),
    ].join("\n");
    const parts = [header.slice(0, Math.max(0, maxChars - 180))];
    let size = parts[0].length;
    let omitted = 0;
    const append = (text, reserve = 180) => {
        if (size + text.length + 1 > maxChars - reserve)
            return false;
        parts.push(text);
        size += text.length + 1;
        return true;
    };
    // The final tool envelope has a smaller budget than retrieval. Never cut a complete method in half here.
    for (const snippet of context.snippets) {
        const text = `\nФайл ${snippet.path}:${snippet.startLine}-${snippet.endLine}; источник=${snippet.source}; revision=${snippet.hash}; ${snippet.fromOpenDocument ? "буфер редактора" : "диск"}${snippet.purpose === "declaration" ? "; ОБЪЯВЛЕНИЕ (тело не запрошено)" : ""}${snippet.truncated ? "; НЕПОЛНЫЙ ФРАГМЕНТ" : ""}${snippet.reason ? `; ${snippet.reason}` : ""}\n${snippet.text}`;
        if (!append(text))
            omitted++;
    }
    for (const text of [
        ...context.providers.map((provider) => `${provider.path}: AST=${provider.ast}, LSP=${provider.lsp}, parser=${provider.parserVersion ?? "недоступен"}`),
        ...context.links.slice(0, 48).map((link) => `${link.from.path}:${link.from.startLine}${link.from.startCharacter === undefined ? "" : `:${link.from.startCharacter + 1}`} ${link.kind} ${link.name} [${link.confidence}] -> ${link.targets.map((target) => `${target.path}:${target.startLine}-${target.endLine}`).join(", ") || "не разрешено"}`),
        ...context.hovers.slice(0, 3).map((hover) => `LSP hover ${hover.path}:${hover.line}: ${hover.text.slice(0, 800)}`),
        ...context.diagnostics.slice(3, 8).map((diagnostic) => `Замечание: ${diagnostic}`)
    ])
        append(text);
    if (omitted)
        append(`Не включено в лимит вывода целых участков: ${omitted}. При необходимости продолжите через project.readFile; отсутствие фрагмента не означает отсутствия зависимости.`, 0);
    return parts.join("\n");
}
//# sourceMappingURL=projectSemanticService.js.map
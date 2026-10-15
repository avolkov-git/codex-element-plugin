import * as path from "path";
import { createHash } from "crypto";
import * as vscode from "vscode";
import { Logger } from "./logger";
import { analyzeProjectStructure, ProjectStructure, StructureSymbol } from "./projectStructure";
import { NativeXbslAstService } from "./nativeXbslAstService";
import { ElementLanguageService, ElementLanguageResult, ElementLanguageSymbol, ElementLanguageRange } from "./elementLanguageService";
import { collectAstReferences } from "./projectAstReferences";
import { isCompanion } from "./projectModulePaths";
export { isCompanion, isElementModuleCompanion } from "./projectModulePaths";

interface SourceFile { path: string; hash: string; structure?: ProjectStructure }
interface SourceText { text: string; truncated: boolean; fromOpenDocument: boolean; startLine: number; endLine: number }
interface SelectedRange { path: string; startLine: number; endLine: number; symbols: readonly string[] }
interface SemanticSymbolEntry {
  symbol: StructureSymbol;
  source: SemanticSnippet["source"];
  scope: "module" | "nested" | "unknown";
  astNode?: TreeNode;
}
interface SemanticRequest {
  workspaceRoot: string;
  query: string;
  files: readonly SourceFile[];
  selected: readonly SelectedRange[];
  readFile: (filePath: string, startLine?: number, endLine?: number) => Promise<SourceText>;
}
export interface SemanticLink {
  from: {
    path: string; startLine: number; endLine: number;
    /** Zero-based UTF-16 columns, end exclusive; omitted for line-only structural evidence. */
    startCharacter?: number; endCharacter?: number;
  };
  name: string;
  kind: string;
  confidence: "lsp" | "structural" | "candidate" | "ambiguous" | "unresolved";
  targets: { path: string; startLine: number; endLine: number }[];
}
export interface SemanticSnippet {
  path: string; startLine: number; endLine: number; text: string;
  source: "native-ast" | "lsp" | "yaml" | "lexical";
  hash: string; fromOpenDocument: boolean; truncated: boolean;
  purpose?: "implementation" | "declaration" | "evidence";
  reason?: string;
  depth?: number;
}
export interface SemanticContextResult {
  links: SemanticLink[];
  snippets: SemanticSnippet[];
  documentationQueries: string[];
  diagnostics: string[];
  hovers: { path: string; line: number; text: string }[];
  providers: { path: string; ast: string; lsp: string; parserVersion?: string }[];
  /** A named YAML control restricts code selection; lexical previews must not widen it again. */
  focusedFiles?: string[];
  selection?: { intent: "implementation" | "declaration"; maxDepth: number; budgetChars: number; omittedRanges: number; omittedComponents?: string[] };
  /** All consulted providers completed; excludes errors/partial readiness from result-cache reuse. */
  cacheable?: boolean;
}

interface ContextRange {
  path: string; startLine: number; endLine: number;
  source: SemanticSnippet["source"];
  purpose: NonNullable<SemanticSnippet["purpose"]>;
  reason: string; depth: number; priority: number;
}

const MAX_FILES = 10;
const MAX_DEPTH = 2;
const CONTEXT_CHARS = 32_000;
const MAX_SNIPPETS = 20;

/** Query-local semantic neighbourhood, not a speculative global call graph. */
export class ProjectSemanticService {
  constructor(
    private readonly ast: NativeXbslAstService,
    private readonly language: ElementLanguageService,
    private readonly logger: Logger,
    private readonly analysisBudgetMs = 8000
  ) {}

  async buildContext(request: SemanticRequest): Promise<SemanticContextResult> {
    const result: SemanticContextResult = { links: [], snippets: [], documentationQueries: [], diagnostics: [], providers: [], hovers: [] };
    const deadline = Date.now() + this.analysisBudgetMs;
    let supplementalReady = true;
    const staleFiles = new Set<string>();
    const candidates = [...new Set(request.selected.filter((item) => /\.(xbsl|ya?ml)$/i.test(item.path)).map((item) => item.path))];
    const explicitFiles = request.files.filter(file => /\.(xbsl|ya?ml)$/i.test(file.path)
      && (containsIdentifier(request.query, path.posix.basename(file.path).replace(/\.(xbsl|ya?ml)$/i, ""))
        || !!file.structure?.element?.name && containsIdentifier(request.query, file.structure.element.name))).map(file => file.path);
    const coveredMethodNames = new Set(request.files.filter(file => explicitFiles.some(explicit => explicit === file.path || isCompanion(explicit, file.path)))
      .flatMap(file => (file.structure?.symbols ?? []).filter(symbol => isMethodKind(symbol.kind)).map(symbol => symbol.name.toLowerCase())));
    for (const file of candidates) {
      if (!explicitFiles.includes(file) && request.files.find(item => item.path === file)?.structure?.symbols
        .some(symbol => isMethodKind(symbol.kind) && !coveredMethodNames.has(symbol.name.toLowerCase())
          && containsIdentifier(request.query, symbol.name))) explicitFiles.push(file);
    }
    const selectedFiles = new Set<string>();
    let seedCount = 0;
    let omittedSeeds = 0;
    const omittedComponents: string[] = [];
    const considered = new Set<string>();
    for (const file of explicitFiles.length ? explicitFiles : candidates) {
      if (considered.has(file)) continue;
      const yaml = /\.ya?ml$/i.test(file) ? file : request.files.find(candidate => isCompanion(file, candidate.path))?.path;
      const group = [...new Set([file, ...(yaml ? [yaml] : []),
        ...request.files.filter(candidate => isCompanion(yaml ?? file, candidate.path)).map(candidate => candidate.path)])];
      group.forEach(member => considered.add(member));
      // Keep a component and its code together; explicit comparisons are not restricted to two seeds.
      if ((!explicitFiles.length && seedCount >= 2) || selectedFiles.size + group.filter(member => !selectedFiles.has(member)).length > MAX_FILES) {
        omittedSeeds++;
        if (omittedComponents.length < 64) omittedComponents.push(file);
        continue;
      }
      group.forEach(member => selectedFiles.add(member));
      seedCount++;
    }
    const sources = new Map<string, SourceText>();
    const structures = new Map<string, ProjectStructure>();
    const symbols = new Map<string, SemanticSymbolEntry[]>();
    const trees = new Map<string, TreeNode>();
    const docs = new Set<string>();
    const attemptedFiles = new Set<string>();
    const inspectedPositions = new Map<string, Set<string>>();
    const intent = contextIntent(request.query);
    result.selection = { intent, maxDepth: MAX_DEPTH, budgetChars: CONTEXT_CHARS, omittedRanges: omittedSeeds, omittedComponents };
    if (omittedSeeds) result.diagnostics.push(`Не включено компонентов: ${omittedSeeds}; лимит ${MAX_FILES} связанных файлов. Продолжите через project.readFile.`);
    for (const component of omittedComponents) result.diagnostics.push(`Не включен компонент ${component}: лимит начального набора связанных файлов.`);
    const loadFile = async (filePath: string, focus: readonly { startLine: number; endLine: number }[] = []): Promise<void> => {
      if (attemptedFiles.has(filePath)) return;
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
        const structure = analyzeProjectStructure(filePath, source.text);
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
        if (isXbsl && ast?.status !== "ready") result.diagnostics.push(`${filePath}: штатный AST ${provider.ast}; ${ast?.reason ?? "используется структурный индекс"}`);
        if (ast?.diagnostics?.length) result.diagnostics.push(`${filePath}: синтаксические замечания штатного парсера (${ast.diagnostics.length}); дерево может быть неполным.`);

        const refs = structure.references.filter((reference) => reference.kind !== "id")
          .sort((a, b) => Number(containsIdentifier(request.query, b.name)) - Number(containsIdentifier(request.query, a.name)));
        const named = (symbols.get(filePath) ?? []).filter(entry => containsIdentifier(request.query, entry.symbol.name));
        const focusRanges = focus.length ? focus : named.length ? named.map(entry => entry.symbol)
          : request.selected.filter(item => item.path === filePath).slice(0, 2);
        const positions = ast?.root ? positionsFromAst(ast.root, source.text, request.query, focusRanges) : [];
        for (const reference of refs) {
          if (positions.length >= 3) break;
          const line = source.text.split(/\r?\n/)[reference.startLine - 1] ?? "";
          const character = line.indexOf(reference.name);
          if (character >= 0) positions.push({ line: reference.startLine - 1, character });
        }
        const language = await withinDeadline(() => this.language.inspect(vscode.Uri.file(path.join(request.workspaceRoot, filePath)), positions), deadline);
        inspectedPositions.set(filePath, new Set(positions.map(position => `${position.line}:${position.character}`)));
        if (!language) { provider.lsp = "budget-exhausted"; return; }
        provider.lsp = language.status;
        if (language.sourceHash && language.sourceHash !== createHash("sha256").update(source.text).digest("hex")) {
          result.diagnostics.push(`${filePath}: документ изменился во время анализа; ответ LSP не использован.`);
          staleFiles.add(filePath);
          sources.delete(filePath); structures.delete(filePath); symbols.delete(filePath); trees.delete(filePath);
          return;
        }
        // LSP is authoritative only for returned facts, never for absence of a result.
        symbols.set(filePath, mergeLanguageSymbols(symbols.get(filePath) ?? [], language.symbols, !!ast?.root));
        // Provider-specific definitions/hover are attached below after normalization.
        this.addLanguageFacts(result, language, filePath, request, source.text, docs);
      } catch (error) {
        result.diagnostics.push(`${filePath}: дополнительный контекст недоступен.`);
        this.logger.warn(`Project semantic context: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const filePath of selectedFiles) await loadFile(filePath);

    const focusedFiles = new Set<string>();
    for (const [filePath, structure] of structures) {
      if (!/\.ya?ml$/i.test(filePath)) continue;
      if (hasYamlFocus(structure, request.query)) {
        focusedFiles.add(filePath);
        for (const candidate of sources.keys()) if (isCompanion(filePath, candidate)) focusedFiles.add(candidate);
      }
      const references = relevantYamlReferences(structure, request.query, request.selected.filter(item => item.path === filePath));
      const selectedReferences = references.slice(0, 48);
      result.selection.omittedRanges += references.length - selectedReferences.length;
      for (const reference of selectedReferences) {
        if (reference.kind !== "handler" && reference.kind !== "expression" && reference.kind !== "type") continue;
        if (reference.kind === "type") addDocumentationTerms(docs, reference.name);
        const targets: SemanticLink["targets"] = [];
        for (const [candidatePath, candidates] of symbols) {
          if (!isCompanion(filePath, candidatePath) || !/\.xbsl$/i.test(candidatePath)) continue;
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
    result.focusedFiles = [...focusedFiles];

    const requests: ContextRange[] = [];
    const queued = new Set<string>();
    const enqueue = (range: ContextRange): void => {
      const key = `${range.path}:${range.startLine}:${range.endLine}:${range.purpose}`;
      if (queued.has(key)) return;
      queued.add(key);
      requests.push(range);
    };
    for (const [filePath, entries] of symbols) {
      const named = entries.filter(entry => containsIdentifier(request.query, entry.symbol.name));
      for (const { symbol, source } of entries) {
        if (!containsIdentifier(request.query, symbol.name)) continue;
        const focusedYaml = source === "yaml" && symbol.kind === "yaml-element" && focusedFiles.has(filePath);
        enqueue({ path: filePath, ...symbol, startLine: focusedYaml ? symbol.selectionLine : symbol.startLine,
          endLine: focusedYaml ? symbol.selectionLine : symbol.endLine, source,
          purpose: source === "yaml" ? "evidence" : intent, priority: source === "yaml" ? 75 : 110, depth: 0,
          reason: focusedYaml ? `Идентичность элемента YAML (${structures.get(filePath)?.element?.kind ?? "элемент"}); обработчики показаны отдельно` : "Объявление названо в запросе" });
      }
      if (!named.length && /\.xbsl$/i.test(filePath) && !focusedFiles.has(filePath)) {
        const selected = request.selected.filter(item => item.path === filePath).slice(0, 2);
        for (const selection of selected) {
          const candidates = entries.filter(entry => overlaps(entry.symbol, selection))
            .sort((a, b) => Number(selection.symbols.includes(b.symbol.name)) - Number(selection.symbols.includes(a.symbol.name))
              || a.symbol.startLine - b.symbol.startLine).slice(0, 2);
          for (const entry of candidates) enqueue({ path: filePath, ...entry.symbol, source: entry.source,
            purpose: intent, priority: 65, depth: 0, reason: "Объявление в найденном участке кода" });
        }
      }
    }
    for (const link of result.links) {
      if (link.kind === "definition") continue; // Follow provider facts only from the focused declarations below.
      let yamlRange = { startLine: Math.max(1, link.from.startLine - 2), endLine: link.from.endLine + 2 };
      if (focusedFiles.has(link.from.path)) {
        const structure = structures.get(link.from.path);
        const reference = structure?.references.find(item => item.name === link.name
          && item.startLine === link.from.startLine && item.endLine === link.from.endLine);
        // An inherited base type can contain the entire UI; only a focused handler/expression needs its mapping.
        yamlRange = link.kind === "type" ? link.from : reference?.contextRange
          ?? structure?.symbols.filter(symbol => symbol.kind === "yaml-name"
            && symbol.startLine <= link.from.startLine && symbol.endLine >= link.from.endLine)
            .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] ?? link.from;
      }
      enqueue({ ...link.from, startLine: yamlRange.startLine, endLine: yamlRange.endLine,
        source: "yaml", purpose: "evidence", priority: 85, depth: 0, reason: `YAML: ${link.kind} ${link.name}` });
      for (const target of link.targets.slice(0, 2)) {
        const matched = symbols.get(target.path)?.find((entry) => entry.symbol.startLine === target.startLine);
        enqueue({ ...target, source: matched?.source ?? "yaml", purpose: /\.xbsl$/i.test(target.path) ? intent : "evidence",
          priority: 90, depth: 0, reason: `Цель YAML-ссылки ${link.name} [${link.confidence}]` });
      }
    }
    for (const selected of request.selected.slice(0, 3)) {
      if (!sources.has(selected.path)) continue;
      if (/\.ya?ml$/i.test(selected.path)) {
        const structure = structures.get(selected.path)!;
        const named = structure.symbols.filter(symbol => containsIdentifier(request.query, symbol.name));
        const local = named.filter(symbol => symbol.kind !== "yaml-element");
        const ranges = local.length ? local : focusedFiles.has(selected.path) ? []
          : [{ startLine: selected.startLine, endLine: Math.min(selected.endLine, selected.startLine + 45) }];
        for (const range of ranges) enqueue({ path: selected.path, ...range, source: "yaml", purpose: "evidence",
          priority: 60, depth: 0, reason: "Контекст элемента YAML" });
      } else if (!focusedFiles.has(selected.path) && !requests.some(item => item.path === selected.path)) enqueue({ ...selected, source: "lexical", purpose: "evidence",
        priority: 50, depth: 0, reason: "Поисковое совпадение без полного объявления" });
    }

    const expanded = new Set<string>();
    const resolvedRanges: ContextRange[] = [];
    let additionalInspections = 0;
    // Breadth first: preserve the requested bodies before spending budget on their dependencies.
    for (let cursor = 0; cursor < requests.length && cursor < 64; cursor++) {
      const selection = requests[cursor];
      if (staleFiles.has(selection.path)) continue;
      await loadFile(selection.path, [selection]);
      const source = sources.get(selection.path);
      if (!source || staleFiles.has(selection.path)) continue;
      const entries = symbols.get(selection.path) ?? [];
      const entry = enclosingDeclaration(entries, selection);
      const range = entry && /\.xbsl$/i.test(selection.path) ? { ...selection, ...entry.symbol, source: entry.source } : selection;
      if (range.purpose === "declaration" && entry && isMethodKind(entry.symbol.kind)) {
        range.endLine = declarationEndLine(entry, source.text);
      }
      resolvedRanges.push(range);
      const expansionKey = `${selection.path}:${entry?.symbol.startLine ?? selection.startLine}`;
      if (expanded.has(expansionKey)) continue;
      expanded.add(expansionKey);
      if (entry?.astNode) collectAstDocumentation(entry.astNode, source.text, docs, range.purpose === "declaration");
      if (/\.xbsl$/i.test(selection.path)) {
        for (const reference of structures.get(selection.path)?.references ?? []) {
          if (reference.kind === "import") enqueue({ path: selection.path, startLine: reference.startLine, endLine: reference.endLine,
            source: entry?.source ?? "lexical", purpose: "evidence", priority: 80, depth: range.depth, reason: "Импорт пространства имён" });
        }
      }
      if (range.depth >= MAX_DEPTH || range.purpose === "declaration") continue;

      const root = trees.get(selection.path);
      if (root && Date.now() < deadline && additionalInspections < 6) {
        const seen = inspectedPositions.get(selection.path) ?? new Set<string>();
        const positions = positionsFromAst(root, source.text, request.query, [range], 24)
          .filter(position => !seen.has(`${position.line}:${position.character}`)).slice(0, 4);
        if (positions.length) {
          additionalInspections++;
          positions.forEach(position => seen.add(`${position.line}:${position.character}`));
          inspectedPositions.set(selection.path, seen);
          try {
            const language = await withinDeadline(() => this.language.inspect(vscode.Uri.file(path.join(request.workspaceRoot, selection.path)), positions), deadline);
            if (language?.sourceHash && language.sourceHash !== createHash("sha256").update(source.text).digest("hex")) {
              staleFiles.add(selection.path); continue;
            }
            if (language) this.addLanguageFacts(result, language, selection.path, request, source.text, docs);
            if (language?.status !== "ready" || language.truncated) supplementalReady = false;
          } catch { supplementalReady = false; result.diagnostics.push(`${selection.path}: не удалось дополнить определения Language Server.`); }
        }
      }
      const definitions = result.links.filter(link => link.kind === "definition" && link.from.path === selection.path && overlaps(link.from, range));
      for (const link of definitions) {
        for (const target of link.targets.slice(0, 2)) enqueue({ ...target, source: "lsp", purpose: "implementation",
          priority: (containsIdentifier(request.query, link.name) ? 105 : 88) - range.depth * 5,
          depth: range.depth + 1, reason: `Определение ${link.name} из Language Server` });
      }
      const method = entry?.astNode;
      if (entry?.scope !== "module" || method?.kind !== "Method") continue;
      const calls: TreeNode[] = [];
      walkTree(method, node => { if (/MethodInvocation$/.test(node.kind)) calls.push(node); },
        node => node !== method && (isAstDeclaration(node.kind) || node.kind === "Lambda"));
      calls.push(...collectAstReferences(method, source.text, { skipNestedScopes: true })
        .filter(reference => reference.kind === "method-reference").map(reference => reference.node));
      const selectedCalls = selectCalls(calls, source.text, request.query);
      result.selection.omittedRanges += selectedCalls.omitted;
      if (selectedCalls.omitted) result.diagnostics.push(`${selection.path}:${method.startLine}: лимит обхода вызовов; не включено ${selectedCalls.omitted}. Явно запрошенные зависимости имеют приоритет.`);
      for (const call of selectedCalls.nodes) {
        const nameNode = invocationName(call);
        const name = nameNode?.attributes.name;
        if (typeof name !== "string") continue;
        const offset = identifierOffset(nameNode, source.text);
        const position = offset === undefined ? undefined : positionAtOffset(source.text, offset);
        const from: SemanticLink["from"] = position
          ? { path: selection.path, startLine: position.line + 1, endLine: position.line + 1,
            startCharacter: position.character, endCharacter: position.character + name.length }
          : { path: selection.path, startLine: call.startLine, endLine: call.endLine };
        if (position && definitions.some(link => link.name === name && link.from.startLine === from.startLine
          && link.from.startCharacter === from.startCharacter)) continue;
        let candidateFiles = [selection.path];
        const methodReference = call.kind === "MethodRef";
        let kind = methodReference ? "native-method-reference" : "native-call";
        if (methodReference && (hasNamespace(nameNode) || call.attributes.explicitObjectCtx === true
          || call.attributes.explicitGlobalCtx === true || call.children.some(node => node.role === "segments"))) {
          result.links.push({ from, kind: "method-reference", name, confidence: "unresolved", targets: [] });
          continue;
        }
        if (!methodReference && (call.kind !== "StaticMethodInvocation" || hasNamespace(nameNode))) {
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
          const verifiedModules: string[] = [];
          for (const module of modules.slice(0, 3)) {
            await loadFile(module.path);
            const element = structures.get(module.path)?.element;
            if (element?.name !== moduleName || !/^(ОбщийМодуль|CommonModule)$/i.test(element.kind ?? "") || staleFiles.has(module.path)) continue;
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
        if ((kind === "native-call" || kind === "native-method-reference") && shadowsName(method, name)) {
          if (methodReference) result.links.push({ from, kind: "method-reference", name, confidence: "unresolved", targets: [] });
          continue;
        }
        const targets: SemanticLink["targets"] = [];
        for (const candidate of candidateFiles.slice(0, 3)) {
          await loadFile(candidate);
          for (const target of symbols.get(candidate) ?? []) {
            if (target.scope === "module" && target.symbol.name === name && isMethodKind(target.symbol.kind)) {
              targets.push({ path: candidate, startLine: target.symbol.startLine, endLine: target.symbol.endLine });
            }
          }
        }
        const unique = uniqueTargets(targets);
        const link: SemanticLink = { from, kind, name,
          confidence: unique.length > 1 || candidateFiles.length > 1 ? "ambiguous" : unique.length ? "candidate" : "unresolved", targets: unique };
        if (!result.links.some(existing => linkKey(existing) === linkKey(link))) result.links.push(link);
        for (const target of unique.slice(0, 2)) enqueue({ ...target, source: "native-ast", purpose: "implementation",
          priority: (containsIdentifier(request.query, name) ? 105 : 85) - range.depth * 5,
          depth: range.depth + 1, reason: `${kind}: ${name} [${link.confidence}]` });
      }
    }
    result.selection.omittedRanges += Math.max(0, requests.length - 64);
    const selections = mergeContextRanges(resolvedRanges).sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    let remaining = CONTEXT_CHARS;
    for (const selection of selections) {
      if (remaining < 500 || result.snippets.length >= MAX_SNIPPETS) { result.selection.omittedRanges++; continue; }
      if (staleFiles.has(selection.path)) continue;
      const source = sources.get(selection.path)!;
      const lines = source.text.split(/\r?\n/);
      const endLine = Math.min(lines.length, selection.endLine);
      if (selection.startLine > endLine) continue;
      const content = lines.slice(selection.startLine - 1, endLine).join("\n");
      const limit = Math.min(remaining, 24_000);
      const truncated = source.truncated || content.length > limit;
      const text = truncated ? `${content.slice(0, limit)}\n[Фрагмент обрезан: метод показан не целиком]` : content;
      remaining -= text.length;
      result.snippets.push({ ...selection, endLine, text, hash: createHash("sha256").update(source.text).digest("hex"),
        fromOpenDocument: source.fromOpenDocument, truncated });
    }
    if (result.selection.omittedRanges) result.diagnostics.push(`Не включено связанных участков: ${result.selection.omittedRanges}; продолжите через project.readFile. Отсутствие в контексте не означает отсутствия зависимости.`);
    result.links = [...new Map(result.links.map(link => [linkKey(link), link])).values()];
    // A one-line definition points at a declaration; publish the complete resolved range for navigation.
    for (const link of result.links) link.targets = link.targets.map(target => {
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
        if (!current || current.text !== snapshot.text || current.truncated !== snapshot.truncated) staleFiles.add(filePath);
      } catch { staleFiles.add(filePath); }
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

  private addLanguageFacts(result: SemanticContextResult, language: ElementLanguageResult, filePath: string, request: SemanticRequest, text: string, docs: Set<string>): void {
    const lines = text.split(/\r?\n/);
    for (const query of language.queries) {
      const line = lines[query.position.line] ?? "";
      const identifier = line.slice(query.position.character).match(/^[\p{L}_][\p{L}\p{N}_]*/u)?.[0];
      const name = identifier ?? "символ";
      if (query.hover) {
        result.hovers.push({ path: filePath, line: query.position.line + 1, text: query.hover.slice(0, 1200) });
        if (name !== "символ") docs.add(name);
      }
      const targets: SemanticLink["targets"] = [];
      for (const definition of query.definitions) {
        let uri: vscode.Uri;
        try { uri = vscode.Uri.parse(definition.uri); } catch { continue; }
        if (uri.scheme !== "file") continue;
        const indexedPath = indexedDefinitionPath(request, uri.fsPath);
        if (!indexedPath) continue;
        const range = definition.selectionRange ?? definition;
        targets.push({ path: indexedPath, startLine: range.startLine, endLine: inclusiveEndLine(range) });
      }
      const unique = uniqueTargets(targets);
      if (unique.length) result.links.push({ from: { path: filePath, startLine: query.position.line + 1, endLine: query.position.line + 1,
        startCharacter: query.position.character, endCharacter: query.position.character + (identifier?.length ?? 0) },
        name, kind: "definition", confidence: unique.length > 1 ? "ambiguous" : "lsp", targets: unique });
    }
  }
}

function indexedDefinitionPath(request: SemanticRequest, fsPath: string): string | undefined {
  const relative = path.relative(request.workspaceRoot, fsPath).split(path.sep).join("/");
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) return undefined;
  // Only Windows paths admit casing differences; retain the indexed spelling for reads and hashes.
  // Ambiguous identities fail closed, and readFile still rechecks realpath against the workspace.
  const matches = request.files.filter(file => path.sep === "\\"
    ? file.path.toLowerCase() === relative.toLowerCase() : file.path === relative);
  return matches.length === 1 ? matches[0].path : undefined;
}

function inclusiveEndLine(range: ElementLanguageRange): number {
  return range.endCharacter === 0 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
}

function isMethodKind(kind: string): boolean {
  return /^(?:5|11|method|abstractmethod|function|lexical-(?:abstract-)?(?:method|function)(?:-partial)?)$/i.test(kind);
}

async function withinDeadline<T>(run: () => Promise<T>, deadline: number, cancel?: () => void): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { cancel?.(); resolve(undefined); }, remaining); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function sameProject(left: string, right: string, files: readonly SourceFile[]): boolean {
  const rootOf = (file: string) => files.filter((entry) => /(^|\/)(project|проект)\.ya?ml$/i.test(entry.path))
    .map((entry) => path.posix.dirname(entry.path)).filter((dir) => dir === "." || file.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)[0];
  const leftRoot = rootOf(left);
  return leftRoot ? leftRoot === rootOf(right) : path.posix.dirname(left) === path.posix.dirname(right);
}

function uniqueTargets(targets: SemanticLink["targets"]): SemanticLink["targets"] {
  return [...new Map(targets.map((target) => [`${target.path}:${target.startLine}:${target.endLine}`, target])).values()];
}

interface TreeNode {
  kind: string; startLine: number; endLine: number; startOffset: number; endOffset: number;
  attributes: Record<string, unknown>; children: readonly TreeNode[];
  role?: string;
}

function walkTree(root: TreeNode, visit: (node: TreeNode, parent?: TreeNode) => void, skip?: (node: TreeNode) => boolean): void {
  const pending: { node: TreeNode; parent?: TreeNode }[] = [{ node: root }];
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    if (skip?.(node)) continue;
    visit(node, parent);
    for (const child of node.children) pending.push({ node: child, parent: node });
  }
}

function isAstDeclaration(kind: string): boolean {
  return /^(?:Bsl)?(?:Method|AbstractMethod|Type|Object|Enum|Const|Constant|Structure|Class|Interface)(?:Declaration)?$/.test(kind);
}

function declarationsFromAst(root: TreeNode, text: string, lexical: readonly StructureSymbol[]): SemanticSymbolEntry[] {
  const symbols: SemanticSymbolEntry[] = [];
  const lines = text.split(/\r?\n/);
  walkTree(root, (node, parent) => {
    const name = node.attributes.name;
    if (typeof name !== "string" || !isAstDeclaration(node.kind) || node.startLine < 1) return;
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

function lexicalScope(symbol: StructureSymbol, text: string): SemanticSymbolEntry["scope"] {
  const rawLine = text.split(/\r?\n/)[symbol.selectionLine - 1];
  const line = symbol.selectionLine === 1 ? rawLine?.replace(/^\uFEFF/, "") : rawLine;
  return !line ? "unknown" : /^\s/.test(line) ? "nested" : "module";
}

function mergeLanguageSymbols(current: SemanticSymbolEntry[], incoming: readonly ElementLanguageSymbol[], hasAst: boolean): SemanticSymbolEntry[] {
  const merged = [...current];
  for (const symbol of incoming) {
    const location = symbol.selectionRange ?? symbol;
    const matches = merged.filter((entry) => entry.symbol.name === symbol.name && isMethodKind(entry.symbol.kind) === isMethodKind(String(symbol.kind))
      && location.startLine >= entry.symbol.startLine && location.startLine <= entry.symbol.endLine);
    const precise = matches.filter((entry) => entry.symbol.selectionLine === location.startLine
      && (location.startCharacter === undefined || entry.symbol.selectionCharacter === location.startCharacter));
    const match = precise.length === 1 ? precise[0] : matches.length === 1 ? matches[0] : undefined;
    // The parser range includes annotations and owns scope. An LSP selection inside it is the same declaration.
    if (match?.source === "native-ast") continue;
    const scope = lspScope(symbol, incoming);
    const entry: SemanticSymbolEntry = { symbol: {
      name: symbol.name, kind: String(symbol.kind), startLine: symbol.startLine, endLine: inclusiveEndLine(symbol),
      selectionLine: location.startLine, selectionCharacter: location.startCharacter ?? 0
    }, source: "lsp", scope: hasAst ? "unknown" : scope === "nested" || match?.scope === "nested" ? "nested" : scope };
    if (match) merged[merged.indexOf(match)] = entry; else merged.push(entry);
  }
  return merged;
}

function lspScope(symbol: ElementLanguageSymbol, symbols: readonly ElementLanguageSymbol[]): SemanticSymbolEntry["scope"] {
  const endLine = inclusiveEndLine(symbol);
  const containers = symbols.filter((candidate) => candidate !== symbol && candidate.startLine <= symbol.startLine && inclusiveEndLine(candidate) >= endLine
    && (candidate.startLine < symbol.startLine || inclusiveEndLine(candidate) > endLine));
  // File/Module wrappers do not introduce a class/method scope; all other containers do.
  if (containers.some((container) => container.kind !== 0 && container.kind !== 1)) return "nested";
  if (symbol.containerName) {
    return containers.some((container) => container.name === symbol.containerName && (container.kind === 0 || container.kind === 1)) ? "module" : "nested";
  }
  return "module";
}

function containsIdentifier(text: string, name: string): boolean {
  return (text.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []).some((word) => word.toLowerCase() === name.toLowerCase());
}

function collectAstDocumentation(root: TreeNode, text: string, docs: Set<string>, declarationOnly = false): void {
  walkTree(root, (node) => {
    if (/TypeName/.test(node.kind) && node.endOffset > node.startOffset) {
      addDocumentationTerms(docs, text.slice(node.startOffset, node.endOffset));
    }
  }, node => declarationOnly && node.role === "statements");
}

function positionsFromAst(root: TreeNode, text: string, query: string, focus: readonly { startLine: number; endLine: number }[] = [], limit = 3): { line: number; character: number }[] {
  return collectAstReferences(root, text)
    .filter(reference => !focus.length || focus.some(range => overlaps(reference.node, range)) || containsIdentifier(query, reference.name))
    .map(reference => ({ ...reference, score: containsIdentifier(query, reference.name) ? 2 : reference.kind === "type" ? 0 : 1 }))
    .sort((a, b) => b.score - a.score || a.position.line - b.position.line || a.position.character - b.position.character)
    .slice(0, limit).map(reference => reference.position);
}

function identifierOffset(node: TreeNode | undefined, text: string): number | undefined {
  if (!node || typeof node.attributes.name !== "string" || node.startOffset < 0 || node.endOffset <= node.startOffset) return undefined;
  // Use the native name node, not the start of a receiver or a whole generic type.
  const identifiers = [...text.slice(node.startOffset, node.endOffset).matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)];
  const identifier = identifiers.reverse().find(match => match[0] === node.attributes.name);
  return identifier ? node.startOffset + identifier.index! : undefined;
}

function positionAtOffset(text: string, offset: number): { line: number; character: number } {
  const prefix = text.slice(0, offset);
  return { line: (prefix.match(/\n/g) ?? []).length, character: offset - prefix.lastIndexOf("\n") - 1 };
}

function contextIntent(query: string): "implementation" | "declaration" {
  // Omitting implementation requires an explicit opt-in; mixed or unclear requests keep bodies.
  if (!/(?:сигнатур|\bsignatures?\b)/iu.test(query)) return "implementation";
  const withoutBody = /(?:тело\s+(?:метода\s+)?не\s+(?:нужно|нужен|требуется|показывай)|без\s+тела(?:\s+метода)?|(?:do\s+not|don['’]t)\s+(?:show|include)\s+(?:the\s+)?(?:method\s+)?body|without\s+(?:the\s+)?(?:method\s+)?body)/giu;
  const request = query.replace(withoutBody, "");
  if (/(?<![\p{L}\p{N}_])(?:не|not|never|don['’]t)(?![\p{L}\p{N}_])/iu.test(request)) return "implementation";
  if (/(?:почему|как\s+работает|исправ|измен|ошиб|провер|реализац|тело|логик|алгоритм|поведени|\b(?:why|fix|implement\w*|algorithm\w*|behavio\w*|body|explain)\b)/iu.test(request)) return "implementation";
  // Signature facets can be listed together; other additional requests need implementation.
  const signatureFacet = /^(?:(?:его|е[её]|их|the|its|their)\s+)?(?:параметр[\p{L}]*|аргумент[\p{L}]*|значени[\p{L}]*\s+по\s+умолчанию|возвращаем[\p{L}]*\s+тип[\p{L}]*|тип[\p{L}]*|return\s+types?|parameters?|arguments?|default\s+values?)(?![\p{L}\p{N}_])/iu;
  for (const conjunction of request.matchAll(/(?<![\p{L}\p{N}_])(?:и|также|плюс|and|also)(?![\p{L}\p{N}_])\s*/giu)) {
    if (!signatureFacet.test(request.slice(conjunction.index! + conjunction[0].length))) return "implementation";
  }
  const onlySignature = /(?:(?:только|лишь|исключительно)\s+сигнатур|\b(?:only|just)\s+(?:[\p{L}\p{N}_'’]+\s+){0,3}signatures?\b|\bsignatures?\s+only\b)/iu.test(request);
  return onlySignature || request !== query ? "declaration" : "implementation";
}

function overlaps(left: { startLine: number; endLine: number }, right: { startLine: number; endLine: number }): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function enclosingDeclaration(entries: readonly SemanticSymbolEntry[], range: { startLine: number; endLine: number }): SemanticSymbolEntry | undefined {
  return entries.filter(entry => entry.symbol.startLine <= range.startLine && entry.symbol.endLine >= range.endLine)
    .sort((a, b) => (a.symbol.endLine - a.symbol.startLine) - (b.symbol.endLine - b.symbol.startLine))[0];
}

function declarationEndLine(entry: SemanticSymbolEntry, text: string): number {
  const statements = entry.astNode?.children.filter(node => node.role === "statements") ?? [];
  if (statements.length) return Math.max(entry.symbol.selectionLine, Math.min(...statements.map(node => node.startLine)) - 1);
  // A lexical range does not distinguish a multiline signature from a body. Keep it rather than guess.
  return entry.symbol.endLine;
}

function invocationName(call: TreeNode): TreeNode | undefined {
  if (call.kind === "MethodRef") {
    const segments = call.children.filter(node => node.role === "segments");
    return segments.length ? segments[segments.length - 1] : call.children.find(node => node.role === "first");
  }
  const prefix = call.children.find(node => node.role === "prefix");
  return prefix?.children.find(node => node.role === "name") ?? prefix;
}

function selectCalls(calls: readonly TreeNode[], text: string, query: string): { nodes: TreeNode[]; omitted: number } {
  const groups = new Map<string, { nodes: TreeNode[]; explicit: boolean }>();
  for (const call of [...calls].sort((a, b) => a.startOffset - b.startOffset)) {
    const prefix = call.children.find(node => node.role === "prefix")
      ?? (call.kind === "MethodRef" ? { ...call, endOffset: invocationName(call)?.endOffset ?? call.endOffset } : undefined);
    const name = invocationName(call)?.attributes.name;
    if (typeof name !== "string") continue;
    // Repeated calls share a traversal slot, but retain each occurrence for LSP evidence.
    // Receivers/namespaces remain distinct; a same-name object call is not a local call.
    const key = `${call.kind}:${name}:${prefix ? text.slice(prefix.startOffset, prefix.endOffset) : ""}`;
    const explicit = containsIdentifier(query, name)
      || !!prefix && (text.slice(prefix.startOffset, prefix.endOffset).match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []).some(word => containsIdentifier(query, word));
    const group = groups.get(key);
    if (group) group.nodes.push(call); else groups.set(key, { nodes: [call], explicit });
  }
  const ordered = [...groups.values()].sort((a, b) => Number(b.explicit) - Number(a.explicit));
  const selected = ordered.slice(0, 12);
  const nodes: TreeNode[] = [];
  // Reserve an occurrence for every selected dependency before spending slots on repeats.
  for (let occurrence = 0; nodes.length < 96; occurrence++) {
    const before = nodes.length;
    for (const group of selected) {
      if (group.nodes[occurrence]) nodes.push(group.nodes[occurrence]);
      if (nodes.length === 96) break;
    }
    if (nodes.length === before) break;
  }
  return { nodes, omitted: Math.max(0, ordered.length - 12) + selected.reduce((sum, group) => sum + group.nodes.length, 0) - nodes.length };
}

function hasNamespace(node: TreeNode | undefined): boolean {
  return Array.isArray(node?.attributes.namespace) && node.attributes.namespace.length > 0;
}

function shadowsName(method: TreeNode, name: string): boolean {
  let found = false;
  walkTree(method, node => {
    if (/^(Parameter|Variable|VariableDeclaration|DeclareVariableStatement|Const|Constant)$/.test(node.kind) && node.attributes.name === name) found = true;
  }, node => node !== method && (node.kind === "Lambda" || node.kind === "ObjectConstructor"
    || isAstDeclaration(node.kind) && !/^(Const|Constant)$/.test(node.kind)));
  return found;
}

function linkKey(link: SemanticLink): string {
  return JSON.stringify([link.from, link.kind, link.name, link.confidence, link.targets]);
}

function relevantYamlReferences(structure: ProjectStructure, query: string, selected: readonly SelectedRange[]): ProjectStructure["references"] {
  const references = structure.references.filter(reference => ["handler", "expression", "type"].includes(reference.kind));
  const direct = references.filter(reference => containsIdentifier(query, reference.name));
  const containers = structure.symbols.filter(symbol => symbol.kind === "yaml-name" && containsIdentifier(query, symbol.name));
  const parents = new Set(direct.map(reference => reference.yamlPath?.replace(/\.[^.]+$/, "")).filter(Boolean));
  const focused = references.filter(reference => direct.includes(reference)
    || containers.some(container => container.startLine <= reference.startLine && container.endLine >= reference.endLine)
    || (reference.yamlPath && parents.has(reference.yamlPath.replace(/\.[^.]+$/, ""))));
  const wholeComponent = !!structure.element?.name && containsIdentifier(query, structure.element.name) && !hasYamlFocus(structure, query);
  const candidates = hasYamlFocus(structure, query) ? focused : references.filter(reference => wholeComponent || !selected.length || selected.some(range => overlaps(reference, range)));
  const baseTypes = references.filter(reference => reference.kind === "type" && (reference.yamlPath?.split(".").length ?? 0) <= 3).slice(0, 4);
  return [...new Set([...candidates, ...baseTypes])].sort((a, b) => Number(direct.includes(b)) - Number(direct.includes(a)) || a.startLine - b.startLine);
}

function hasYamlFocus(structure: ProjectStructure, query: string): boolean {
  return structure.symbols.some(symbol => symbol.kind === "yaml-name" && containsIdentifier(query, symbol.name))
    || structure.references.some(reference => ["handler", "expression"].includes(reference.kind) && containsIdentifier(query, reference.name));
}

function mergeContextRanges(ranges: readonly ContextRange[]): ContextRange[] {
  const merged: ContextRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || b.endLine - a.endLine)) {
    const previous = merged[merged.length - 1];
    if (previous?.path === range.path && overlaps(previous, range)) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
      previous.priority = Math.max(previous.priority, range.priority);
      previous.depth = Math.min(previous.depth, range.depth);
      if (range.purpose === "implementation") previous.purpose = "implementation";
      if (range.source === "native-ast" || (range.source === "lsp" && previous.source !== "native-ast")) previous.source = range.source;
      previous.reason = [...new Set([previous.reason, range.reason])].join("; ");
    } else merged.push({ ...range });
  }
  return merged;
}

function addDocumentationTerms(terms: Set<string>, type: string): void {
  for (const term of type.match(/[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*/gu) ?? []) {
    if (term.length >= 3 && terms.size < 30) terms.add(term);
  }
}

export function formatSemanticContext(context: SemanticContextResult, maxChars = Number.POSITIVE_INFINITY): string {
  const header = [
    "[PROJECT STRUCTURE: YAML + XBSL + LSP + native AST]",
    "Связи structural подтверждают совпадение YAML-ссылки и объявления в парном модуле, но не семантическое связывание компилятора. candidate/ambiguous требуют проверки. AST не доказывает корректность типов. Правила проекта остаются отдельными требованиями.",
    ...(context.selection ? [`Подбор: ${context.selection.intent === "declaration" ? "сигнатуры; тела намеренно не включены" : "реализация и зависимости"}; глубина до ${context.selection.maxDepth}; пропущено участков: ${context.selection.omittedRanges}. Это ограниченное окружение задачи, не полный граф проекта.`] : []),
    ...context.diagnostics.slice(0, 3).map(diagnostic => `Замечание: ${diagnostic.length > 240 ? `${diagnostic.slice(0, 239)}…` : diagnostic}`),
  ].join("\n");
  const parts = [header.slice(0, Math.max(0, maxChars - 180))];
  let size = parts[0].length;
  let omitted = 0;
  const append = (text: string, reserve = 180): boolean => {
    if (size + text.length + 1 > maxChars - reserve) return false;
    parts.push(text); size += text.length + 1; return true;
  };
  // The final tool envelope has a smaller budget than retrieval. Never cut a complete method in half here.
  for (const snippet of context.snippets) {
    const text = `\nФайл ${snippet.path}:${snippet.startLine}-${snippet.endLine}; источник=${snippet.source}; revision=${snippet.hash}; ${snippet.fromOpenDocument ? "буфер редактора" : "диск"}${snippet.purpose === "declaration" ? "; ОБЪЯВЛЕНИЕ (тело не запрошено)" : ""}${snippet.truncated ? "; НЕПОЛНЫЙ ФРАГМЕНТ" : ""}${snippet.reason ? `; ${snippet.reason}` : ""}\n${snippet.text}`;
    if (!append(text)) omitted++;
  }
  for (const text of [
    ...context.providers.map((provider) => `${provider.path}: AST=${provider.ast}, LSP=${provider.lsp}, parser=${provider.parserVersion ?? "недоступен"}`),
    ...context.links.slice(0, 48).map((link) => `${link.from.path}:${link.from.startLine}${link.from.startCharacter === undefined ? "" : `:${link.from.startCharacter + 1}`} ${link.kind} ${link.name} [${link.confidence}] -> ${link.targets.map((target) => `${target.path}:${target.startLine}-${target.endLine}`).join(", ") || "не разрешено"}`),
    ...context.hovers.slice(0, 3).map((hover) => `LSP hover ${hover.path}:${hover.line}: ${hover.text.slice(0, 800)}`),
    ...context.diagnostics.slice(3, 8).map((diagnostic) => `Замечание: ${diagnostic}`)
  ]) append(text);
  if (omitted) append(`Не включено в лимит вывода целых участков: ${omitted}. При необходимости продолжите через project.readFile; отсутствие фрагмента не означает отсутствия зависимости.`, 0);
  return parts.join("\n");
}

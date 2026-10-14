import { createHash } from "crypto";
import * as path from "path";
import { fileURLToPath } from "url";
import { analyzeProjectStructure } from "./projectStructure";
import type { ProjectStructure, StructureReference } from "./projectStructure";
import { collectAstReferences } from "./projectAstReferences";
import type { AstNode, AstReferenceOccurrence } from "./projectAstReferences";
import type { NativeAstResult } from "./nativeXbslAstService";
import type { ElementLanguagePosition, ElementLanguageResult } from "./elementLanguageService";

export interface ChangeFile { path: string; hash: string; structure?: ProjectStructure }
export interface ChangeSnapshot { workspaceRoot: string; files: readonly ChangeFile[] }
export interface ProjectChangeFinding {
  kind: "syntax" | "yaml-handler" | "impact";
  path: string;
  /** One-based source line. */
  line: number;
  message: string;
  evidence: "ast" | "yaml" | "structural" | "candidate" | "lsp";
  name?: string;
  /** Exact source spelling, including the receiver/namespace; never a resolved identity. */
  occurrence?: string;
  occurrenceKind?: "call" | "method-reference";
  resolution?: "structural" | "unresolved" | "ambiguous" | "lsp";
  candidatePaths?: string[];
  /** Only positive, unambiguous provider definitions, checked against current source hashes. */
  targets?: Array<{ path: string; line: number }>;
}
export interface ProjectChangeReport {
  /** Added, hash-changed or no longer readable/indexed, NOT a filesystem deletion assertion. */
  changedPaths: string[];
  changes: Array<{ path: string; kind: "added" | "changed" | "removed-from-index" }>;
  findings: ProjectChangeFinding[];
  /** Files on which a check ran and whose source was revalidated, not proof of correctness. */
  checkedPaths: string[];
  limitations: string[];
  elementTargets: Array<{ path: string; elementKind?: string; availability?: "indexed" | "removed-from-index" }>;
  status: "checked" | "partial" | "unchanged" | "stale";
  counts: { filesRead: number; readCalls: number; sourceBytes: number; verifiedBytes: number; parses: number; inspections: number };
  omittedLimitations: number;
}
export interface ProjectChangeOptions {
  before: ChangeSnapshot;
  after: ChangeSnapshot;
  readFile: (path: string) => Promise<{ text: string; hash: string }>;
  parse: (text: string, signal?: AbortSignal) => Promise<NativeAstResult>;
  inspect?: (path: string, positions: ElementLanguagePosition[]) => Promise<ElementLanguageResult>;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
}

/** Reserve 2 MiB and the final two seconds for verification; at most 400 distinct sources / 800 reads. */
export const PROJECT_CHANGE_LIMITS = Object.freeze({
  files: 400, sourceBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, fileBytes: 512 * 1024,
  parses: 40, deadlineMs: 10_000, validationMs: 2000, callMs: 1200, parseMs: 4000,
  indexFiles: 20_000, names: 2000, structureItems: 20_000, findings: 400, limitations: 100,
  astNodes: 25_000, totalAstNodes: 200_000, astDepth: 256, inspections: 20, positions: 4,
});

interface Entry { path: string; readPath: string; hash: string; structure?: ProjectStructure }
interface Source { entry: Entry; text: string; structure?: ProjectStructure; ast?: AstSummary; astAttempted?: boolean }
interface AstSummary { methods: Array<{ name: string; line: number }>; references: AstReferenceOccurrence[]; complete: boolean }
interface PendingFinding { finding: ProjectChangeFinding; position: ElementLanguagePosition }
const isXbsl = (name: string): boolean => /\.xbsl$/i.test(name);
const isYaml = (name: string): boolean => /\.ya?ml$/i.test(name);
const isManifest = (name: string): boolean => /^(?:project|\u043f\u0440\u043e\u0435\u043a\u0442)\.ya?ml$/i.test(path.posix.basename(name));
const identifier = /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u;
const identifiers = /[\p{L}_][\p{L}\p{N}\p{M}_]*/gu;
const methodKind = /^(?:method|abstractmethod|lexical-(?:abstract-)?method(?:-partial)?)$/i;
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** No filesystem, edits, repairs, compilation or provider activation; all IO is caller-owned. */
export async function analyzeProjectChanges(options: ProjectChangeOptions): Promise<ProjectChangeReport> {
  return new ChangeAnalysis(options).run();
}

class ChangeAnalysis {
  private readonly report: ProjectChangeReport = {
    changedPaths: [], changes: [], findings: [], checkedPaths: [], elementTargets: [], status: "partial",
    limitations: [
      "Ограниченная проверка только для чтения, не заключение о корректности и не автоматическое исправление. Пустая диагностика не доказывает корректность.",
      "Синтаксическая диагностика относится только к текущему исходнику. В снимках нет прежней AST-диагностики, поэтому нельзя утверждать, что проблему внесло изменение.",
      "AST подтверждает вхождения, но не их цели. Структурные совпадения имён не разрешают наследование, встроенные методы, объекты-получатели и пространства имён.",
      "Сравниваются хеши файлов, не тела отдельных методов. Кандидаты могут ссылаться на неизменённые методы изменённого модуля.",
      "Имена прежних объявлений берутся только из структурного индекса: он может пропускать объявления, в том числе с аннотацией на той же строке. Прежний AST по текущему исходнику не восстанавливается.",
    ],
    counts: { filesRead: 0, readCalls: 0, sourceBytes: 0, verifiedBytes: 0, parses: 0, inspections: 0 },
    omittedLimitations: 0,
  };
  private readonly deadline = Date.now() + PROJECT_CHANGE_LIMITS.deadlineMs;
  private readonly sources = new Map<string, Source>();
  private readonly attempted = new Set<string>();
  private readonly checked = new Set<string>();
  private readonly disabled = new Set<string>();
  private readonly notes = new Set<string>();
  private readonly seeds = new Map<string, Map<string, Set<string>>>();
  private readonly manifests = new Map<string, Set<string>>();
  private readonly affected = new Set<string>();
  private before = new Map<string, Entry>();
  private after = new Map<string, Entry>();
  private workspace = "";
  private partial = false;
  private stale = false;
  private nodeCount = 0;
  private seedCount = 0;
  private structureCount = 0;

  constructor(private readonly options: ProjectChangeOptions) {}

  async run(): Promise<ProjectChangeReport> {
    if (!path.isAbsolute(this.options.before.workspaceRoot) || !path.isAbsolute(this.options.after.workspaceRoot)
      || path.resolve(this.options.before.workspaceRoot) !== path.resolve(this.options.after.workspaceRoot)) {
      this.invalidate("Снимки относятся к разным или некорректным корням рабочего каталога.");
      return this.finish();
    }
    this.workspace = path.resolve(this.options.after.workspaceRoot);
    if (this.options.before.files.length > PROJECT_CHANGE_LIMITS.indexFiles || this.options.after.files.length > PROJECT_CHANGE_LIMITS.indexFiles) {
      this.note(`Индекс снимка превышает ${PROJECT_CHANGE_LIMITS.indexFiles} записей; сравнение пропущено, исчезновение путей по усечённому индексу не определяется.`);
      return this.finish();
    }
    this.before = this.index(this.options.before);
    this.after = this.index(this.options.after);
    for (const entry of [...this.before.values(), ...this.after.values()]) {
      if (!isManifest(entry.path)) continue;
      const directory = path.posix.dirname(entry.path);
      if (!this.manifests.has(directory)) this.manifests.set(directory, new Set());
      this.manifests.get(directory)!.add(entry.path);
    }
    for (const [name, entry] of this.after) {
      const previous = this.before.get(name);
      if (!previous || previous.hash !== entry.hash) this.report.changes.push({ path: name, kind: previous ? "changed" : "added" });
    }
    for (const name of this.before.keys()) {
      if (!this.after.has(name)) this.report.changes.push({ path: name, kind: "removed-from-index" });
    }
    this.report.changes.sort((a, b) => a.path.localeCompare(b.path));
    this.report.changedPaths = this.report.changes.map(change => change.path);
    if (!this.active()) return this.finish();
    if (!this.report.changes.length) {
      this.report.status = this.partial ? "partial" : "unchanged";
      return this.report;
    }

    // Copy name seeds before the first await. Snapshot structures are hints, never current diagnostics.
    for (const change of this.report.changes) {
      this.affected.add(change.path);
      const old = this.before.get(change.path);
      const next = this.after.get(change.path);
      if (isXbsl(change.path)) {
        if (old && !old.structure) this.note(`${change.path}: прежняя структура недоступна; удалённые или переименованные имена могут быть пропущены.`);
        this.addSeeds(change.path, old?.structure);
        this.addSeeds(change.path, next?.structure);
      }
      if (isYaml(change.path)) {
        this.addHandlerSeeds(change.path, old?.structure);
        this.addHandlerSeeds(change.path, next?.structure);
      }
      if (isManifest(change.path)) this.note(`${change.path}: последствия изменения конфигурации проекта не определяются синтаксическим анализом и поиском имён.`);
      if (change.kind === "removed-from-index") {
        this.note(`${change.path}: путь перестал читаться в индексе; нельзя отличить удаление, переименование, пустой или слишком большой файл и пропуск при индексации.`);
        if (isYaml(change.path) && old?.structure?.element) this.report.elementTargets.push({ path: change.path,
          elementKind: old.structure.element.kind, availability: "removed-from-index" });
      }
    }

    for (const change of this.report.changes) {
      if (!this.active()) break;
      await this.verifyProject(change.path);
      const source = await this.load(change.path);
      if (!source) continue;
      if (isYaml(change.path)) this.addHandlerSeeds(change.path, this.yaml(source));
      else {
        const structure = this.structure(source);
        this.addSeeds(change.path, structure);
        const ast = await this.ast(source, true);
        if (ast) this.addSeeds(change.path, { symbols: ast.methods.map(method => ({ name: method.name, kind: "method",
          startLine: method.line, endLine: method.line, selectionLine: method.line, selectionCharacter: 0 })), references: [], errors: [] });
      }
    }

    const families = new Set(this.report.changedPaths.map(family));
    const relevantYaml = [...this.after.values()].filter(entry => isYaml(entry.path) && families.has(family(entry.path)) && !isManifest(entry.path));
    for (const entry of relevantYaml) {
      if (!this.active()) break;
      const source = await this.load(entry.path);
      if (source) await this.handlers(source);
    }
    for (const entry of this.after.values()) {
      if (families.has(family(entry.path))) this.affected.add(entry.path);
    }

    // Cheap source token filtering precedes native parsing; there is no project-wide AST pass.
    for (const entry of this.after.values()) {
      if (!this.active()) break;
      const names = this.seeds.get(this.project(entry.path));
      if (!isXbsl(entry.path) || !names?.size) continue;
      if (!await this.verifyProject(entry.path)) continue;
      const source = await this.load(entry.path);
      if (!source) continue;
      const hits = new Set<string>();
      for (const match of source.text.matchAll(identifiers)) if (names.has(match[0])) hits.add(match[0]);
      if (!hits.size) continue;
      const ast = await this.ast(source, this.report.changedPaths.includes(entry.path));
      if (!ast) {
        this.finding({ kind: "impact", path: entry.path, line: 1, evidence: "candidate", resolution: "unresolved",
          message: "В исходнике встречаются имена изменённых объявлений, но AST недоступен; вызовы, ссылки на методы и их цели не подтверждены." });
        continue;
      }
      const pending: PendingFinding[] = [];
      for (const reference of ast.references) {
        if (reference.kind === "type" || !hits.has(reference.name)) continue;
        const prefix = reference.node.kind === "MethodRef" ? reference.node
          : reference.node.children.find(child => child.role === "prefix") ?? reference.nameNode;
        const spelling = source.text.slice(Math.max(0, prefix.startOffset), reference.nameNode.endOffset);
        if (spelling.length > 1000) this.note(`${entry.path}: текст отдельного вхождения ограничен 1000 символами.`);
        const occurrence = spelling.slice(0, 1000);
        const candidatePaths = [...names.get(reference.name)!];
        if (candidatePaths.length > 20) this.note(`${entry.path}: пути кандидатов для имени ${reference.name} ограничены 20 записями.`);
        const finding: ProjectChangeFinding = { kind: "impact", path: entry.path, line: reference.position.line + 1,
          name: reference.name, occurrence, occurrenceKind: reference.kind, evidence: "ast", resolution: "unresolved",
          candidatePaths: candidatePaths.slice(0, 20),
          message: `Потенциально затронут${reference.kind === "call" ? " вызов" : "а ссылка на метод"}: ${occurrence}. AST подтверждает только вхождение, но не цель и не наличие ошибки.` };
        if (this.finding(finding)) pending.push({ finding, position: reference.position });
      }
      await this.resolve(source, pending);
    }

    await this.revalidate();
    return this.finish();
  }

  private index(snapshot: ChangeSnapshot): Map<string, Entry> {
    const result = new Map<string, Entry>();
    for (const file of snapshot.files) {
      const name = this.relative(file.path);
      if (!name || typeof file.hash !== "string" || !file.hash) { this.note("Пропущена некорректная запись снимка или путь за пределами рабочего каталога."); continue; }
      if (!isXbsl(name) && !isYaml(name)) continue;
      if (result.has(name)) { this.invalidate(`${name}: повторяющийся путь в снимке; сравнение неоднозначно.`); continue; }
      result.set(name, { path: name, readPath: file.path, hash: file.hash, structure: file.structure });
    }
    return result;
  }

  private relative(value: string): string | undefined {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return undefined;
    // POSIX resolve() treats foreign drive paths as relative and would place them inside the workspace.
    if (path.sep === "/" && (/^[A-Za-z]:/.test(value) || value.startsWith("\\") || value.startsWith("//"))) return undefined;
    const normalized = value.replace(/\\/g, "/");
    const absolute = path.resolve(this.workspace, normalized);
    const relative = path.relative(this.workspace, absolute).split(path.sep).join("/");
    return relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : undefined;
  }

  private project(name: string): string {
    let directory = path.posix.dirname(name);
    for (;;) {
      if (this.manifests.has(directory)) return directory;
      if (directory === ".") return `unconfirmed:${path.posix.dirname(name)}`;
      directory = path.posix.dirname(directory);
    }
  }

  private async verifyProject(name: string): Promise<boolean> {
    const project = this.project(name);
    const manifests = this.manifests.get(project);
    if (!manifests) {
      this.note("Для части файлов не найден ближайший project.yaml; проверка частичная, поиск кандидатов ограничен тем же каталогом, а не всем рабочим пространством.");
      return true;
    }
    for (const manifest of manifests) {
      if (!this.after.has(manifest)) {
        this.note(`${manifest}: граница проекта сохранена по прежнему снимку; текущий манифест не читается в индексе.`);
        return false;
      }
      if (!await this.load(manifest)) return false;
    }
    return true;
  }

  private addSeeds(name: string, structure?: ProjectStructure): void {
    if (!structure) return;
    const project = this.project(name);
    if (!this.seeds.has(project)) this.seeds.set(project, new Map());
    const names = this.seeds.get(project)!;
    for (const symbol of structure.symbols) {
      if (++this.structureCount > PROJECT_CHANGE_LIMITS.structureItems) {
        this.note(`Обход исходного структурного индекса ограничен ${PROJECT_CHANGE_LIMITS.structureItems} записями; остальные имена пропущены.`); break;
      }
      if (!methodKind.test(symbol.kind)) continue;
      if (!identifier.test(symbol.name) || symbol.name.length > 500) {
        this.note(`${name}: нестандартное или слишком длинное имя объявления не включено в поиск последствий.`); continue;
      }
      if (!names.has(symbol.name)) {
        if (this.seedCount >= PROJECT_CHANGE_LIMITS.names) { this.note(`Достигнут лимит изменённых имён: ${PROJECT_CHANGE_LIMITS.names}.`); break; }
        names.set(symbol.name, new Set()); this.seedCount++;
      }
      names.get(symbol.name)!.add(name);
    }
  }

  private addHandlerSeeds(name: string, structure?: ProjectStructure): void {
    if (!structure) return;
    const references = structure.references.slice(0, 100);
    if (structure.references.length > 100) this.note(`${name}: исходные ссылки YAML ограничены 100 записями.`);
    this.addSeeds(name, { symbols: references.filter(reference => reference.kind === "handler" && identifier.test(reference.name))
      .map(reference => ({ name: reference.name, kind: "method", startLine: reference.startLine, endLine: reference.endLine,
        selectionLine: reference.startLine, selectionCharacter: 0 })), references: [], errors: [] });
  }

  private structure(source: Source): ProjectStructure {
    return source.structure ??= analyzeProjectStructure(source.entry.path, source.text);
  }

  private yaml(source: Source): ProjectStructure {
    if (source.structure) return source.structure;
    const structure = this.structure(source);
    this.checked.add(source.entry.path);
    for (const error of structure.errors.slice(0, 50)) {
      // Walker limits/cyclic aliases are not parser syntax diagnostics.
      if (error.startsWith("YAML:")) { this.note(`${source.entry.path}: ${error}`); continue; }
      if (error.length > 2000) this.note(`${source.entry.path}: текст отдельной диагностики YAML ограничен 2000 символами.`);
      const line = Number(/(?:at|in) line (\d+)/i.exec(error)?.[1] ?? 1);
      this.finding({ kind: "syntax", path: source.entry.path, line, message: `Диагностика текущего YAML (текст парсера): ${error.slice(0, 2000)}`, evidence: "yaml" });
    }
    if (structure.errors.length > 50) this.note(`${source.entry.path}: диагностика YAML ограничена 50 сообщениями.`);
    if (structure.element && !this.report.elementTargets.some(target => target.path === source.entry.path)) {
      this.report.elementTargets.push({ path: source.entry.path, elementKind: structure.element.kind, availability: "indexed" });
    }
    return structure;
  }

  private async load(name: string): Promise<Source | undefined> {
    if (this.sources.has(name)) return this.sources.get(name);
    const entry = this.after.get(name);
    if (!entry || this.attempted.has(name) || !this.active()) return undefined;
    if (this.attempted.size >= PROJECT_CHANGE_LIMITS.files || this.report.counts.sourceBytes >= PROJECT_CHANGE_LIMITS.sourceBytes) {
      this.note(`Просмотр исходников ограничен ${PROJECT_CHANGE_LIMITS.files} файлами и ${PROJECT_CHANGE_LIMITS.sourceBytes} байтами; остальные файлы пропущены.`);
      return undefined;
    }
    this.attempted.add(name);
    this.report.counts.readCalls++;
    const response = await this.call("read", () => this.options.readFile(entry.readPath));
    if (!response || typeof response.text !== "string" || typeof response.hash !== "string") {
      this.note(`${name}: исходник недоступен или ответ чтения некорректен; проверки не выполнены.`);
      return undefined;
    }
    const bytes = Buffer.byteLength(response.text, "utf8");
    if (response.hash !== entry.hash) {
      this.invalidate(`${name}: хеш ответа чтения не совпадает со снимком.`); return undefined;
    }
    if (bytes > PROJECT_CHANGE_LIMITS.fileBytes || bytes + this.report.counts.sourceBytes > PROJECT_CHANGE_LIMITS.sourceBytes) {
      this.note(`${name}: превышен лимит размера файла или оставшийся бюджет байтов; текст и его хеш не проверены, файл не использован в доказательствах.`); return undefined;
    }
    if (response.hash !== entry.hash || digest(response.text) !== entry.hash) {
      this.invalidate(`${name}: хеш исходника не совпадает со снимком либо с возвращённым текстом.`); return undefined;
    }
    this.report.counts.sourceBytes += bytes;
    this.report.counts.filesRead++;
    const source = { entry, text: response.text };
    this.sources.set(name, source);
    return source;
  }

  private async ast(source: Source, syntax: boolean): Promise<AstSummary | undefined> {
    if (source.astAttempted) return source.ast;
    if (!this.active()) return undefined;
    source.astAttempted = true;
    if (this.report.counts.parses >= PROJECT_CHANGE_LIMITS.parses) {
      this.note(`Достигнут лимит штатного AST: ${PROJECT_CHANGE_LIMITS.parses} разборов; дальнейшие синтаксис и вхождения не проверены.`); return undefined;
    }
    this.report.counts.parses++;
    const response = await this.call("parse", signal => this.options.parse(source.text, signal));
    if (!response) return undefined;
    if (response.sourceHash !== source.entry.hash) {
      this.invalidate(`${source.entry.path}: хеш исходника в ответе AST не совпадает со снимком.`); return undefined;
    }
    if (response.status !== "ready" || !Array.isArray(response.diagnostics)) {
      this.note(`${source.entry.path}: штатная синтаксическая проверка недоступна (${response.code ?? response.status}); отсутствие ошибок не подтверждено.`); return undefined;
    }
    this.checked.add(source.entry.path);
    if (syntax) {
      for (const diagnostic of response.diagnostics.slice(0, 50)) {
        if (typeof diagnostic?.message !== "string" || !Number.isInteger(diagnostic.line) || diagnostic.line < 1) {
          this.note(`${source.entry.path}: некорректная запись диагностики AST пропущена.`); continue;
        }
        if (diagnostic.message.length > 2000) this.note(`${source.entry.path}: текст отдельной диагностики AST ограничен 2000 символами.`);
        this.finding({ kind: "syntax", path: source.entry.path, line: diagnostic.line,
          message: `Штатная диагностика текущего исходника: ${diagnostic.message.slice(0, 2000)}`, evidence: "ast" });
      }
    }
    if (response.diagnostics.length > 50) this.note(`${source.entry.path}: штатная диагностика ограничена 50 сообщениями.`);
    if (response.partial || response.diagnostics.length) this.note(`${source.entry.path}: восстановление AST после ошибок или диагностика ограничивают полноту объявлений и вхождений.`);
    const root = this.tree(response.root, source.text.length);
    if (!root) { this.note(`${source.entry.path}: дерево AST недоступно, некорректно, циклично или превышает лимит обхода.`); return undefined; }
    const methods = (root.kind === "Module" ? root.children : [root])
      .filter(node => /^(?:Method|AbstractMethod)$/.test(node.kind) && typeof node.attributes.name === "string" && node.startLine > 0)
      .map(node => ({ name: node.attributes.name as string, line: node.startLine }));
    source.ast = { methods, references: collectAstReferences(root, source.text), complete: !response.partial && !response.diagnostics.length };
    return source.ast;
  }

  /** Copy a bounded tree before handing it to the shared traversal (which assumes acyclic containment). */
  private tree(value: unknown, textLength: number): AstNode | undefined {
    const seen = new Set<unknown>();
    const pending: Array<{ value: unknown; depth: number; parent?: AstNode }> = [{ value, depth: 0 }];
    let root: AstNode | undefined;
    while (pending.length) {
      if (!this.active() || seen.size >= PROJECT_CHANGE_LIMITS.astNodes || this.nodeCount >= PROJECT_CHANGE_LIMITS.totalAstNodes) return undefined;
      const item = pending.pop()!;
      if (!item.value || typeof item.value !== "object" || seen.has(item.value) || item.depth > PROJECT_CHANGE_LIMITS.astDepth) return undefined;
      seen.add(item.value); this.nodeCount++;
      const node = item.value as AstNode;
      if (typeof node.kind !== "string" || !Array.isArray(node.children) || !node.attributes || typeof node.attributes !== "object"
        || ![node.startOffset, node.endOffset, node.startLine, node.endLine].every(Number.isInteger)
        || node.endOffset > textLength || node.children.length + pending.length + seen.size > PROJECT_CHANGE_LIMITS.astNodes) return undefined;
      const children: AstNode[] = [];
      const attributes: Record<string, unknown> = { name: typeof node.attributes.name === "string" ? node.attributes.name : undefined, ctor: node.attributes.ctor === true };
      const copy: AstNode = { kind: node.kind, startOffset: node.startOffset, endOffset: node.endOffset,
        startLine: node.startLine, endLine: node.endLine, role: typeof node.role === "string" ? node.role : undefined, attributes, children };
      if (item.parent) (item.parent.children as AstNode[]).push(copy); else root = copy;
      for (let index = node.children.length - 1; index >= 0; index--) pending.push({ value: node.children[index], parent: copy, depth: item.depth + 1 });
    }
    return root;
  }

  private async handlers(source: Source): Promise<void> {
    const structure = this.yaml(source);
    if (!await this.verifyProject(source.entry.path)) return;
    const references = structure.references.filter(reference => reference.kind === "handler");
    if (references.length > 100) this.note(`${source.entry.path}: проверка обработчиков YAML ограничена 100 записями.`);
    const companions = [...this.after.values()].filter(entry => isXbsl(entry.path) && family(entry.path) === family(source.entry.path)
      && this.project(entry.path) === this.project(source.entry.path));
    const candidates = new Map<string, Array<{ path: string; line: number }>>();
    const simpleNames = new Set(references.slice(0, 100).filter(reference => identifier.test(reference.name)).map(reference => reference.name));
    for (const companion of companions) {
      const code = await this.load(companion.path);
      if (!code) continue;
      const hasName = [...code.text.matchAll(identifiers)].some(match => simpleNames.has(match[0]));
      if (!hasName) continue;
      const ast = await this.ast(code, this.report.changedPaths.includes(companion.path));
      if (!ast?.complete) continue;
      for (const method of ast.methods) {
        if (!simpleNames.has(method.name)) continue;
        if (!candidates.has(method.name)) candidates.set(method.name, []);
        candidates.get(method.name)!.push({ path: companion.path, line: method.line });
      }
    }
    const pending: PendingFinding[] = [];
    const yamlPeers = [...this.after.keys()].filter(name => isYaml(name) && family(name) === family(source.entry.path));
    for (const reference of references.slice(0, 100)) {
      const matches = candidates.get(reference.name) ?? [];
      const qualified = !identifier.test(reference.name);
      const ambiguous = matches.length > 1 || yamlPeers.length > 1;
      const structural = !qualified && matches.length === 1 && yamlPeers.length === 1;
      const message = structural
        ? `Обработчик ${reference.name} совпадает с объявлением уровня модуля в ${matches[0].path}; это структурное соответствие, а не разрешённая связь.`
        : `Обработчик ${reference.name}: ${qualified ? "квалифицированное имя" : ambiguous || yamlPeers.length > 1 ? "неоднозначные локальные объявления или пары YAML" : "локальное объявление не подтверждено"}. Возможны наследование, встроенный обработчик, нечитаемый парный файл или переименование; отсутствие обработчика не доказано.`;
      const finding: ProjectChangeFinding = { kind: "yaml-handler", path: source.entry.path, line: reference.startLine,
        name: reference.name, evidence: structural ? "structural" : "candidate", resolution: structural ? "structural" : ambiguous ? "ambiguous" : "unresolved",
        message, candidatePaths: [...new Set(matches.map(match => match.path))] };
      if (!structural) this.note(`${source.entry.path}:${reference.startLine}: связь обработчика требует семантического подтверждения.`);
      const position = handlerPosition(source.text, reference);
      if (this.finding(finding) && position) pending.push({ finding, position });
      else if (!position) this.note(`${source.entry.path}:${reference.startLine}: точная позиция обработчика недоступна; запрос LSP пропущен.`);
    }
    await this.resolve(source, pending);
  }

  private async resolve(source: Source, pending: PendingFinding[]): Promise<void> {
    if (!pending.length) return;
    if (!this.options.inspect) { this.note("Разрешение целей через LSP недоступно; цели AST-вхождений и структурных кандидатов не подтверждены."); return; }
    if (pending.length > PROJECT_CHANGE_LIMITS.positions) this.note(`${source.entry.path}: позиции LSP ограничены ${PROJECT_CHANGE_LIMITS.positions}; остальные цели не разрешены.`);
    if (this.report.counts.inspections >= PROJECT_CHANGE_LIMITS.inspections) {
      this.note(`Достигнут лимит обращений к LSP: ${PROJECT_CHANGE_LIMITS.inspections}; остальные цели не разрешены.`); return;
    }
    const selected = pending.slice(0, PROJECT_CHANGE_LIMITS.positions);
    // Do not give callbacks mutable report positions or trust the positions they return unconditionally.
    const requested = selected.map(item => ({ ...item.position }));
    this.report.counts.inspections++;
    const result = await this.call("inspect", () => this.options.inspect!(source.entry.readPath, requested));
    if (!result) return;
    if (result.sourceHash && result.sourceHash !== source.entry.hash) { this.invalidate(`${source.entry.path}: хеш исходника в ответе LSP не совпадает со снимком.`); return; }
    if (!result.sourceHash || result.status === "unavailable" || !Array.isArray(result.queries) || this.uriPath(result.uri) !== source.entry.path) {
      this.note(`${source.entry.path}: ответ LSP не подтверждает текущий исходник или не содержит запросов; цели не разрешены.`); return;
    }
    if (result.truncated || result.status !== "ready") this.note(`${source.entry.path}: ответ LSP частичный; пустой ответ не доказывает отсутствие цели.`);
    if (result.queries.length > PROJECT_CHANGE_LIMITS.positions) this.note(`${source.entry.path}: лишние или незапрошенные ответы LSP пропущены.`);
    for (const item of selected) {
      const queries = result.queries.slice(0, PROJECT_CHANGE_LIMITS.positions).filter(query => query?.position?.line === item.position.line
        && query.position.character === item.position.character);
      const query = queries.length === 1 ? queries[0] : undefined;
      if (!query || query.definitionState !== "responded" || !Array.isArray(query.definitions) || !query.definitions.length || query.definitions.length > 20) {
        this.note(`${source.entry.path}:${item.finding.line}: LSP не подтвердил единственную цель.`); continue;
      }
      const definitions = new Map<string, { path: string; line: number }>();
      let invalid = false;
      for (const definition of query.definitions) {
        const name = this.uriPath(definition?.uri);
        const line = definition?.selectionRange?.startLine ?? definition?.startLine;
        if (!name || !this.after.has(name) || this.project(name) !== this.project(source.entry.path) || !Number.isInteger(line) || line < 1) { invalid = true; continue; }
        definitions.set(`${name}:${line}`, { path: name, line });
      }
      if (invalid || definitions.size !== 1 || result.truncated) {
        this.note(`${source.entry.path}:${item.finding.line}: неоднозначные, усечённые определения, цели другого проекта или вне индекса не подтверждают связь.`); continue;
      }
      const target = [...definitions.values()][0];
      const targetSource = await this.load(target.path);
      if (!targetSource || target.line > targetSource.text.split(/\r\n|\r|\n/).length) {
        this.note(`${source.entry.path}:${item.finding.line}: исходник или диапазон цели LSP не удалось проверить.`); continue;
      }
      if (item.finding.kind === "impact" && !this.affected.has(target.path)) {
        this.report.findings = this.report.findings.filter(finding => finding !== item.finding);
        continue;
      }
      item.finding.evidence = "lsp";
      item.finding.resolution = "lsp";
      item.finding.targets = [target];
      item.finding.message = `${item.finding.kind === "impact" ? "Возможное последствие изменения" : "Обработчик YAML"}: LSP вернул цель ${target.path}:${target.line}. Подтверждена цель провайдера, но не регрессия и не актуальность серверного индекса.`;
    }
  }

  private uriPath(uri: string): string | undefined {
    try { return typeof uri === "string" && uri.startsWith("file:") ? this.relative(fileURLToPath(uri)) : undefined; }
    catch { return undefined; }
  }

  private async revalidate(): Promise<void> {
    for (const source of this.sources.values()) {
      if (!this.current() || !this.active(true)) { this.invalidate("Итоговая проверка исходников не завершена; все замечания исключены."); return; }
      this.report.counts.readCalls++;
      const response = await this.call("read", () => this.options.readFile(source.entry.readPath), true);
      if (!response || typeof response.text !== "string" || response.hash !== source.entry.hash
        || Buffer.byteLength(response.text, "utf8") > PROJECT_CHANGE_LIMITS.fileBytes || digest(response.text) !== source.entry.hash) {
        this.invalidate(`${source.entry.path}: итоговая проверка хеша не пройдена; все замечания исключены.`); return;
      }
      this.report.counts.verifiedBytes += Buffer.byteLength(response.text, "utf8");
    }
    if (!this.options.isCurrent) this.note("Проверка ревизии снимка не передана; итоговое чтение не атомарно, состав индекса невозможно перепроверить.");
    this.current();
  }

  private finish(): ProjectChangeReport {
    this.current();
    if (this.report.omittedLimitations) this.report.limitations.push(`Дополнительные сообщения об ограничениях свёрнуты: ${this.report.omittedLimitations}. Проверка остаётся частичной.`);
    if (this.stale) {
      this.report.status = "stale";
      this.report.findings = []; this.report.checkedPaths = []; this.report.elementTargets = [];
    } else {
      this.report.status = this.partial ? "partial" : "checked";
      this.report.checkedPaths = [...this.checked].sort();
    }
    return this.report;
  }

  private finding(finding: ProjectChangeFinding): boolean {
    if (this.report.findings.length >= PROJECT_CHANGE_LIMITS.findings) {
      this.note(`Замечания ограничены ${PROJECT_CHANGE_LIMITS.findings} записями; дополнительные вхождения и диагностика пропущены.`); return false;
    }
    this.report.findings.push(finding); return true;
  }

  private note(message: string): void {
    this.partial = true;
    if (this.notes.has(message)) return;
    if (this.report.limitations.length >= PROJECT_CHANGE_LIMITS.limitations - 1) { this.report.omittedLimitations++; return; }
    this.notes.add(message); this.report.limitations.push(message);
  }

  private invalidate(message: string): void { this.stale = true; this.note(message); }

  private current(): boolean {
    if (this.stale) return false;
    try {
      if (this.options.isCurrent && this.options.isCurrent() !== true) this.invalidate("Ревизия снимка или рабочего каталога уже не актуальна.");
    } catch { this.invalidate("Проверка ревизии снимка завершилась ошибкой; актуальность состояния не установлена."); }
    return !this.stale;
  }

  private active(validation = false): boolean {
    if (!this.current()) return false;
    if (this.options.signal?.aborted) { this.note("Анализ отменён; оставшиеся проверки пропущены."); return false; }
    if (Date.now() >= this.deadline - (validation ? 0 : PROJECT_CHANGE_LIMITS.validationMs)) {
      this.note("Исчерпан общий срок анализа; оставшиеся проверки пропущены. Для итоговой сверки предусмотрен отдельный резерв времени."); return false;
    }
    return true;
  }

  private async call<T>(kind: string, start: (signal: AbortSignal) => Promise<T>, validation = false): Promise<T | undefined> {
    if (!this.active(validation)) return undefined;
    const label = kind === "read" ? "Чтение исходника" : kind === "parse" ? "Разбор AST" : "Запрос LSP";
    if (this.disabled.has(kind)) { this.note(`${label}: повторные обращения пропущены после операции, не завершившейся в срок.`); return undefined; }
    const controller = new AbortController();
    const remaining = this.deadline - Date.now() - (validation ? 0 : PROJECT_CHANGE_LIMITS.validationMs);
    const timeout = Math.min(remaining, kind === "parse" ? PROJECT_CHANGE_LIMITS.parseMs : PROJECT_CHANGE_LIMITS.callMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await new Promise<T | undefined>(resolve => {
        let settled = false;
        const finish = (result?: T): void => { if (!settled) { settled = true; resolve(result); } };
        abort = () => { finish(); controller.abort(); };
        this.options.signal?.addEventListener("abort", abort, { once: true });
        if (this.options.signal?.aborted) { abort(); return; }
        timer = setTimeout(() => {
          this.disabled.add(kind); this.note(`${label}: превышено время ожидания; последующие операции этого вида пропущены.`);
          finish(); controller.abort();
        }, Math.max(1, timeout));
        // Promise wrapping catches synchronous throws; late rejections are consumed without mutating the report.
        void Promise.resolve().then(() => settled ? undefined : start(controller.signal)).then(value => finish(value), () => {
          if (!settled) {
            if (kind === "read") this.invalidate("Чтение индексированного исходника завершилось ошибкой; актуальность снимка и исходника не установлена.");
            else this.note(`${label}: операция завершилась ошибкой; проверка недоступна.`);
            finish();
          }
        });
      });
      return this.active(validation) ? value : undefined;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) this.options.signal?.removeEventListener("abort", abort);
    }
  }
}

function family(name: string): string {
  const base = name.replace(/\.(?:xbsl|ya?ml)$/i, "");
  return isXbsl(name) ? base.replace(/\.(?:\u041e\u0431\u044a\u0435\u043a\u0442|Object)$/, "") : base;
}

function handlerPosition(text: string, reference: StructureReference): ElementLanguagePosition | undefined {
  const line = text.split(/\r\n|\r|\n/)[reference.startLine - 1] ?? "";
  const start = line.indexOf(reference.name);
  if (start < 0 || line.indexOf(reference.name, start + 1) >= 0) return undefined;
  const terminal = reference.name.split(/::|\./).pop()!;
  return { line: reference.startLine - 1, character: start + reference.name.length - terminal.length };
}

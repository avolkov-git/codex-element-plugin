"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const ts = require("typescript");
const { root, logger } = require("../tests/service-test-utils.cjs");

const DEFAULT_PROJECT = "/tmp/codex-context-privet-dom-app";
const DEFAULT_BASELINE = "/tmp/codex-context-stage1.Cz0Mp4/src";
const DEFAULT_JAR = "/Users/aleksandrvolkov/pet-project/element-ai/theia-plugin-qc/artifacts/server 9.1.9-17/ide/theia/plugins/@1c-appengine-plugin/bin/appengine-lsp/repo/com.e1c.g5rt.lsp.server.appengine-9.1.9-1.jar";
const DEFAULT_REPORT = path.join(root, "docs/project-context-stage2-evaluation.json");
const SETTINGS = Object.freeze({ maxItems: 8, maxPreviewChars: 420, maxChars: 20000, managedMaxChars: 22000,
  productionMaxChars: 36000, analysisBudgetMs: 8000, repetitions: 3 });
const PERSONAL = "DOMRF/Start/СтандартноеПриложение/ПерсональныеНастройкиПользователя/ЗамещениеПользователяФорма";
const STRUCTURE = "DOMRF/Start/СтруктураПредприятия/";
const CALENDAR = "DOMRF/Start/КалендарьСотрудника/ВиджетКандидатыСписокСтрока";
const OFFICE = `${STRUCTURE}ВизуальныеКомпоненты/ОфисыПользовательскийСписокСтрока`;
const ORGANIZATION = `${STRUCTURE}ВизуальныеКомпоненты/ОрганизацииПользовательскийСписокСтрока`;
const API = `${STRUCTURE}ПерсональныеЗамещенияПрограммныйИнтерфейс.xbsl`;
const evidence = (kind, file, startLine, endLine, label) => ({ kind, path: file, startLine, endLine, label });

// These ranges were read by hand from the real fixture, before any benchmark output.
// Do not derive this oracle from either stage's AST, links, or retrieval results.
const CASES = [
  { id: "regression-button", query: "В ЗамещениеПользователяФорма проверь ПриНажатии Применить: какая проверка выполняется перед изменением замещения?", evidence: [
    evidence("method", `${PERSONAL}.xbsl`, 84, 103, "Применить"),
    evidence("method", `${PERSONAL}.xbsl`, 40, 53, "МожноПрименить"),
    evidence("yaml", `${PERSONAL}.yaml`, 63, 67, "Primary button, availability and handler"),
  ] },
  { id: "regression-availability", query: "В ЗамещениеПользователяФорма почему МожноПрименить не разрешает сохранить замещение с неправильным периодом?", evidence: [
    evidence("method", `${PERSONAL}.xbsl`, 40, 53, "МожноПрименить"),
    evidence("yaml", `${PERSONAL}.yaml`, 66, 66, "Availability expression"),
  ] },
  { id: "regression-validation", query: "В ЗамещениеПользователяФорма найди ПодсказкаПроверки: почему нельзя назначить самого себя замещающим?", evidence: [
    evidence("method", `${PERSONAL}.xbsl`, 56, 81, "ПодсказкаПроверки"),
    evidence("yaml", `${PERSONAL}.yaml`, 59, 60, "Validation label expression"),
  ] },
  { id: "calendar-dependency", query: "В ВиджетКандидатыСписокСтрока объясни ШрифтНадписиОписание и найди полное определение вызываемой проверки ширины устройства; покажи привязку шрифта в YAML.", evidence: [
    evidence("method", `${CALENDAR}.xbsl`, 49, 55, "ШрифтНадписиОписание"),
    evidence("method", "DOMRF/Start/УниверсальныеКомпоненты/ИнтерфейсныеКомпонентыОбщегоНазначения.xbsl", 7, 9, "КлиентскоеУстройствоМаленькойШирины"),
    evidence("yaml", `${CALENDAR}.yaml`, 68, 74, "Description label and font binding"),
  ] },
  { id: "office-model-type", query: "В модели Офисы какие типы у Город, ПринадлежностьОрганизации и ФактическийАдресЗначение? Может ли ПринадлежностьОрганизации быть пустой и какие значения определены в этом типе?", evidence: [
    evidence("yaml", `${STRUCTURE}Офисы.yaml`, 28, 29, "City string type"),
    evidence("yaml", `${STRUCTURE}Офисы.yaml`, 32, 33, "Nullable organization enum"),
    evidence("yaml", `${STRUCTURE}Офисы.yaml`, 41, 44, "Multiline JSON address string"),
    evidence("yaml", `${STRUCTURE}ПринадлежностьОрганизации.yaml`, 1, 4, "Enum identity"),
    evidence("yaml", `${STRUCTURE}ПринадлежностьОрганизации.yaml`, 8, 9, "Home enum value"),
    evidence("yaml", `${STRUCTURE}ПринадлежностьОрганизации.yaml`, 12, 13, "Bank enum value"),
  ] },
  { id: "signature-only", query: "Покажи только сигнатуру СоздатьЗамещениеНаСервере в ПерсональныеЗамещенияПрограммныйИнтерфейс: параметры, значение по умолчанию и возвращаемый тип. Тело метода не нужно.", evidence: [
    evidence("signature", API, 60, 61, "СоздатьЗамещениеНаСервере signature"),
  ], excludedBodies: [evidence("body", API, 62, 82, "Unrequested method body")] },
  { id: "duplicate-names", query: "Сравни ПредставлениеЗначенияФактическийАдрес в ОфисыПользовательскийСписокСтрока и ОрганизацииПользовательскийСписокСтрока: покажи оба полных определения и YAML-привязку каждого, не смешивая одноименные методы.", evidence: [
    evidence("method", `${OFFICE}.xbsl`, 8, 10, "Office address method"),
    evidence("method", `${ORGANIZATION}.xbsl`, 13, 15, "Organization address method"),
    evidence("yaml", `${OFFICE}.yaml`, 23, 25, "Office address binding"),
    evidence("yaml", `${ORGANIZATION}.yaml`, 28, 30, "Organization address binding"),
  ] },
  { id: "unknown-symbol", query: "БенчмаркНесуществующийМетод7429", evidence: [], expectAbstention: true },
];

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const lf = value => value.replace(/\r\n/g, "\n");
const git = (directory, ...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

function sourceSnapshot(directory) {
  const files = new Map();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.name.endsWith(".ts")) files.set(path.relative(directory, filename), fs.readFileSync(filename, "utf8"));
    }
  }
  walk(directory);
  const manifest = [...files].map(([name, content]) => ({ path: name, sha256: sha(content) })).sort((a, b) => a.path.localeCompare(b.path));
  return { directory, files, manifest, sha256: sha(JSON.stringify(manifest)) };
}

function fixtureManifest(project) {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: project, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const files = names.map(name => ({ path: name, sha256: sha(fs.readFileSync(path.join(project, name))) }));
  return { commit: git(project, "rev-parse", "HEAD"), sha256: sha(JSON.stringify(files)), files };
}

function lineRange(source, startLine, endLine) {
  const lines = lf(source).split("\n");
  assert.ok(startLine >= 1 && endLine >= startLine && endLine <= lines.length, "Invalid oracle line range");
  const start = lines.slice(0, startLine - 1).reduce((n, line) => n + line.length + 1, 0);
  return { start, end: start + lines.slice(startLine - 1, endLine).join("\n").length };
}

function freezeOracle(project, baseline) {
  const fixture = fixtureManifest(project);
  const sourceFiles = [...new Set(CASES.flatMap(item => [...item.evidence, ...(item.excludedBodies || [])].map(item => item.path)))];
  const files = sourceFiles.map(name => ({ path: name, sha256: sha(fs.readFileSync(path.join(project, name))) }));
  const resolveEvidence = item => {
    const source = lf(fs.readFileSync(path.join(project, item.path), "utf8"));
    const range = lineRange(source, item.startLine, item.endLine);
    const text = source.slice(range.start, range.end);
    assert.ok(text.length > 0);
    if (item.kind === "method") {
      assert.match(text, /^метод /u);
      assert.match(text, /\n;$/u);
    }
    return { ...item, ...range, text, sha256: sha(text) };
  };
  for (const item of CASES.filter(item => item.expectAbstention)) {
    for (const file of fixture.files.filter(file => /\.(xbsl|ya?ml)$/i.test(file.path))) {
      assert.ok(!fs.readFileSync(path.join(project, file.path), "utf8").includes(item.query), "Unknown symbol is present in fixture");
    }
  }
  return { frozenAt: new Date().toISOString(), method: "Manually read source ranges; no retrieval or AST output used to select evidence.",
    definitionsSha256: sha(JSON.stringify(CASES)), baselineSha256: baseline.sha256,
    fixture, sourceFiles: files, cases: CASES.map(item => ({ ...item,
      evidence: item.evidence.map(resolveEvidence), excludedBodies: (item.excludedBodies || []).map(resolveEvidence) })) };
}

function validateOracle(oracle, project, baseline) {
  assert.equal(oracle.definitionsSha256, sha(JSON.stringify(CASES)), "Oracle definitions changed; do not tune cases after retrieval");
  assert.equal(oracle.baselineSha256, baseline.sha256, "Frozen stage1 source changed");
  assert.equal(oracle.fixture.sha256, fixtureManifest(project).sha256, "Fixture changed since oracle freeze");
  for (const item of oracle.cases.flatMap(item => [...item.evidence, ...item.excludedBodies])) {
    const source = lf(fs.readFileSync(path.join(project, item.path), "utf8"));
    assert.equal(sha(source.slice(item.start, item.end)), item.sha256, `Oracle evidence drift: ${item.path}`);
  }
}

// All relative TS imports resolve inside one immutable in-memory snapshot. Resource
// paths and package resolution deliberately use the real plugin root, not /tmp.
function snapshotLoader(snapshot, mocks = {}) {
  const cache = new Map();
  function load(name) {
    name = path.normalize(name);
    if (cache.has(name)) return cache.get(name).exports;
    const source = snapshot.files.get(name);
    assert.equal(typeof source, "string", `Missing frozen source ${name}`);
    const filename = path.join(root, "src", name);
    const module = { exports: {} };
    cache.set(name, module);
    const localRequire = createRequire(filename);
    let output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
    } }).outputText;
    // Export the actual production formatter for size accounting; do not copy it.
    if (name === "projectToolsService.ts") output += "\nexports.__benchmarkFormatSearchBlock = formatSearchBlock;\n";
    vm.runInNewContext(output, { module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
      require: requested => {
        if (Object.hasOwn(mocks, requested)) return mocks[requested];
        if (requested.startsWith(".")) return load(path.join(path.dirname(name), `${requested}.ts`));
        return localRequire(requested);
      }, Buffer, URL, process, console, setTimeout, clearTimeout, Date, Error, AbortController,
    }, { filename: `${snapshot.directory}/${name}` });
    return module.exports;
  }
  return load;
}

function uri(file) { return { scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href }; }
function mockVscode(project) {
  const event = () => ({ dispose() {} });
  return { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) }, RelativePattern: class {},
    workspace: { workspaceFolders: [{ uri: uri(project) }], textDocuments: [], onDidChangeWorkspaceFolders: event,
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event, onDidCreate: event, onDidDelete: event }) } };
}

function makeStage(name, snapshot, project, temporary, parserJar) {
  const load = snapshotLoader(snapshot, { vscode: mockVscode(project) });
  const { NativeXbslAstService } = load("nativeXbslAstService.ts");
  const { ProjectSemanticService, formatSemanticContext } = load("projectSemanticService.ts");
  const { ProjectContextService } = load("projectContextService.ts");
  const { ProjectToolsService, __benchmarkFormatSearchBlock } = load("projectToolsService.ts");
  const native = new NativeXbslAstService(root, logger, { parserJarPath: parserJar });
  const astCalls = [];
  const ast = { parse: async (...args) => {
    const result = await native.parse(...args);
    astCalls.push({ status: result.status, partial: result.partial, diagnostics: result.diagnostics?.length || 0,
      sourceHash: result.sourceHash, cacheHit: result.cacheHit, parserVersion: result.parserVersion, reason: result.reason });
    return result;
  } };
  let lspCalls = 0;
  const language = { inspect: async () => { lspCalls++; return {
    status: "unavailable", reason: "Offline benchmark: no running IDE or live LSP", symbols: [], queries: [],
  }; } };
  const semantic = new ProjectSemanticService(ast, language, logger, SETTINGS.analysisBudgetMs);
  const context = new ProjectContextService({}, path.join(temporary, name), logger, semantic);
  return { name, snapshot, native, astCalls, getLspCalls: () => lspCalls, context, formatSemanticContext,
    formatSearch: __benchmarkFormatSearchBlock, ProjectToolsService,
    dispose() { context.dispose(); native.dispose(); } };
}

function unionLength(ranges) {
  let end = -1, length = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    length += Math.max(0, range.end - Math.max(end, range.start));
    end = Math.max(end, range.end);
  }
  return length;
}

function duplicateChars(segments) {
  const groups = new Map();
  for (const segment of segments) {
    const group = groups.get(segment.path) || [];
    group.push(segment); groups.set(segment.path, group);
  }
  let total = 0, unique = 0;
  for (const ranges of groups.values()) {
    total += ranges.reduce((n, range) => n + range.end - range.start, 0);
    unique += unionLength(ranges);
  }
  return { sourceChars: total, uniqueSourceChars: unique, duplicateSourceChars: total - unique };
}

// Map only actual displayed source prefixes, never the advertised endLine of a
// truncated snippet. Preview whitespace is collapsed by production trimText.
function mapSegment(item, source, text, preview = false) {
  source = lf(source); text = lf(text);
  const range = lineRange(source, item.startLine, Math.min(item.endLine, source.split("\n").length));
  const raw = source.slice(range.start, range.end);
  if (!preview) {
    let count = 0;
    while (count < raw.length && count < text.length && raw[count] === text[count]) count++;
    return { path: item.path, start: range.start, end: range.start + count, mappedTextChars: count };
  }
  const tokens = [...raw.matchAll(/\S+/gu)];
  let normalized = "", offsets = [];
  for (const token of tokens) {
    if (normalized) { normalized += " "; offsets.push(range.start + token.index); }
    for (let i = 0; i < token[0].length; i++) {
      normalized += token[0][i]; offsets.push(range.start + token.index + i + 1);
    }
  }
  let count = 0;
  while (count < normalized.length && count < text.length && normalized[count] === text[count]) count++;
  const start = range.start + (tokens[0]?.index || 0);
  return { path: item.path, start, end: count ? offsets[count - 1] : start, mappedTextChars: count };
}

function coverage(evidenceItems, segments) {
  const entries = evidenceItems.map(item => ({ label: item.label, path: item.path, startLine: item.startLine, endLine: item.endLine,
    // One contiguous displayed fragment is required. Disjoint snippets cannot
    // silently reconstruct a method, and identical text in another file fails.
    covered: segments.some(segment => segment.path === item.path && segment.start <= item.start && segment.end >= item.end) }));
  return { required: entries.length, covered: entries.filter(item => item.covered).length, entries };
}

function excludedBodyChars(excluded, segments) {
  return excluded.reduce((sum, body) => sum + unionLength(segments.filter(segment => segment.path === body.path)
    .map(segment => ({ start: Math.max(body.start, segment.start), end: Math.min(body.end, segment.end) }))
    .filter(range => range.end > range.start)), 0);
}

function scoreResult(item, raw, semanticText, promptText, fullText, sourceFor) {
  const snippets = raw.semantic?.snippets || [];
  const semantic = [], formattedSemantic = [], deliveredSemantic = [], previews = [], deliveredPreviews = [];
  let formattedPreviewChars = 0, deliveredPreviewChars = 0;
  for (const snippet of snippets) {
    const segment = mapSegment(snippet, sourceFor(snippet.path), snippet.text);
    semantic.push(segment);
    const header = `Файл ${snippet.path}:${snippet.startLine}-${snippet.endLine};`;
    const headerAt = fullText.indexOf(header);
    if (headerAt < 0) continue;
    const at = fullText.indexOf("\n", headerAt) + 1;
    assert.ok(at > headerAt, "Unrecognized semantic snippet envelope");
    let formattedChars = 0;
    while (formattedChars < snippet.text.length && fullText[at + formattedChars] === snippet.text[formattedChars]) formattedChars++;
    formattedSemantic.push(mapSegment(snippet, sourceFor(snippet.path), snippet.text.slice(0, formattedChars)));
    const visible = Math.max(0, Math.min(snippet.text.length, promptText.length - at - (promptText.endsWith("…") ? 1 : 0)));
    deliveredSemantic.push(mapSegment(snippet, sourceFor(snippet.path), snippet.text.slice(0, Math.min(visible, formattedChars))));
  }
  for (const [index, chunk] of raw.chunks.entries()) {
    const chunkHeader = `${index + 1}. ${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
    const headerAt = fullText.indexOf(chunkHeader);
    if (headerAt < 0) continue;
    const next = raw.chunks[index + 1];
    const nextAt = next ? fullText.indexOf(`${index + 2}. ${next.path}:${next.startLine}-${next.endLine}`, headerAt + chunkHeader.length) : -1;
    const marker = `   preview: ${chunk.preview}`;
    const at = fullText.indexOf(marker, headerAt + chunkHeader.length);
    if (at < 0 || (nextAt >= 0 && at >= nextAt)) continue;
    previews.push(mapSegment(chunk, sourceFor(chunk.path), chunk.preview, true));
    formattedPreviewChars += chunk.preview.length;
    const start = at + "   preview: ".length;
    const visible = Math.max(0, Math.min(chunk.preview.length, promptText.length - start - (promptText.endsWith("…") ? 1 : 0)));
    deliveredPreviewChars += visible;
    deliveredPreviews.push(mapSegment(chunk, sourceFor(chunk.path), chunk.preview.slice(0, visible), true));
  }
  const delivered = [...deliveredSemantic, ...deliveredPreviews];
  const metricsFor = (segments, exactSegments) => ({
    fullMethods: coverage(item.evidence.filter(item => item.kind === "method"), segments),
    exactYaml: coverage(item.evidence.filter(item => item.kind === "yaml"), exactSegments),
    signatures: coverage(item.evidence.filter(item => item.kind === "signature"), segments),
    excludedBodyChars: excludedBodyChars(item.excludedBodies, segments),
  });
  const semanticCoverage = metricsFor(semantic, semantic);
  // Flattened previews are not exact YAML evidence: indentation carries meaning.
  const promptCoverage = metricsFor(delivered, deliveredSemantic);
  const abstained = raw.chunks.length === 0 && snippets.length === 0 && !(raw.semantic?.links || []).some(link => link.targets.length);
  const passed = Object.values(promptCoverage).filter(value => value && typeof value === "object")
    .every(value => value.covered === value.required) && promptCoverage.excludedBodyChars === 0 && (!item.expectAbstention || abstained);
  return { passed, semanticCoverage, promptCoverage,
    bytes: { semanticText: Buffer.byteLength(semanticText, "utf8"), fullPromptBeforeCap: Buffer.byteLength(fullText, "utf8"),
      deliveredPrompt: Buffer.byteLength(promptText, "utf8") },
    chars: { semanticText: semanticText.length, semanticSnippetText: snippets.reduce((n, item) => n + item.text.length, 0),
      rawCandidatePreviewText: raw.chunks.reduce((n, item) => n + item.preview.length, 0),
      formattedPreviewText: formattedPreviewChars, deliveredPreviewText: deliveredPreviewChars, fullPromptBeforeCap: fullText.length,
      deliveredPrompt: promptText.length, removedByPromptCap: fullText.length - promptText.length },
    overlap: { semantic: duplicateChars(semantic), previews: duplicateChars(previews),
      fullPromptBeforeCap: duplicateChars([...formattedSemantic, ...previews]), deliveredPrompt: duplicateChars(delivered) },
    snippetDelivery: { retrieved: snippets.length, formatted: formattedSemantic.length,
      withDeliveredSource: deliveredSemantic.filter(segment => segment.end > segment.start).length,
      fullyDelivered: snippets.filter(snippet => {
        const expected = mapSegment(snippet, sourceFor(snippet.path), snippet.text);
        return expected.end > expected.start && deliveredSemantic.some(segment => segment.path === expected.path && segment.start <= expected.start && segment.end >= expected.end);
      }).length },
    abstention: item.expectAbstention ? { passed: abstained, returnedChunks: raw.chunks.length, returnedSnippets: snippets.length,
      note: "Returning unrelated fallback context fails abstention; it is not evidence of a fabricated symbol." } : undefined,
    chunks: raw.chunks.map(chunk => ({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, score: chunk.score })),
    snippets: snippets.map(({ text, ...snippet }) => ({ ...snippet, textChars: text.length })),
    links: raw.semantic?.links || [], providers: raw.semantic?.providers || [], diagnostics: raw.semantic?.diagnostics || [],
    documentationQueries: raw.semantic?.documentationQueries || [],
    selection: raw.semantic?.selection,
    textSha256: { semantic: sha(semanticText), deliveredPrompt: sha(promptText) } };
}

async function runQuery(stage, item, project) {
  const astStart = stage.astCalls.length, lspStart = stage.getLspCalls();
  let raw, retrievalMs;
  const production = new stage.ProjectToolsService({ searchTool: async (...args) => {
    assert.equal(args[1], item.query, "Production changed the frozen query");
    assert.equal(args[2].maxItems, SETTINGS.maxItems, "Stage search limits differ");
    assert.equal(args[2].maxPreviewChars, SETTINGS.maxPreviewChars, "Stage preview limits differ");
    const start = performance.now();
    raw = await stage.context.searchTool(...args);
    retrievalMs = performance.now() - start;
    return raw;
  } }, logger, () => "benchmark");
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const result = await production.search({ chatId: "benchmark", query: item.query, reason: "Frozen retrieval benchmark",
    limits: { maxItems: SETTINGS.maxItems, maxChars: SETTINGS.maxChars } });
  const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
  const cpu = process.cpuUsage(cpuStart);
  assert.ok(raw, `Search failed before retrieval: ${JSON.stringify(result)}`);
  const prompt = (result.blocks || result.partialBlocks || []).map(block => block.text).join("\n");
  const semanticText = raw.semantic ? stage.formatSemanticContext(raw.semantic) : "";
  const fullText = result.ok ? stage.formatSearch(raw, SETTINGS.maxChars) : prompt;
  assert.ok(fullText.startsWith(prompt.replace(/…$/u, "")), "Delivered prompt differs from production formatter");
  const score = scoreResult(item, raw, semanticText, prompt, fullText,
    filename => fs.readFileSync(path.join(project, filename), "utf8"));
  // Replay the identical retrieval result through the real managed-limit tool
  // formatter, so a second retrieval/cache state cannot confound budget coverage.
  const managedTool = new stage.ProjectToolsService({ searchTool: async (_profile, query, limits) => {
    assert.equal(query, item.query); assert.equal(limits.maxItems, SETTINGS.maxItems);
    assert.equal(limits.maxPreviewChars, SETTINGS.maxPreviewChars); return raw;
  } }, logger, () => "benchmark");
  async function replay(maxChars) {
    const replayStart = performance.now();
    const toolResult = await managedTool.search({ chatId: "benchmark", query: item.query, reason: "Frozen tool-budget replay",
      limits: { maxItems: SETTINGS.maxItems, maxChars } });
    const replayFormattingMs = Math.round((performance.now() - replayStart) * 100) / 100;
    const delivered = (toolResult.blocks || toolResult.partialBlocks || []).map(block => block.text).join("\n");
    const formatted = toolResult.ok ? stage.formatSearch(raw, maxChars) : delivered;
    assert.ok(formatted.startsWith(delivered.replace(/…$/u, "")));
    assert.ok(delivered.length <= maxChars, "Tool block exceeds requested limit");
    return { ...scoreResult(item, raw, semanticText, delivered, formatted,
      filename => fs.readFileSync(path.join(project, filename), "utf8")), requestedMaxChars: maxChars,
      toolOk: toolResult.ok, toolError: toolResult.error, replayFormattingMs,
      texts: { fullPromptBeforeCap: formatted, deliveredPrompt: delivered } };
  }
  const managed22k = await replay(SETTINGS.managedMaxChars);
  const production36k = stage.name === "stage2" ? await replay(SETTINGS.productionMaxChars) : undefined;
  const calls = stage.astCalls.slice(astStart);
  const runtime = { retrievalMs: Math.round(retrievalMs * 100) / 100,
    nodeCpuUserMs: cpu.user / 1000, nodeCpuSystemMs: cpu.system / 1000,
    astCalls: calls.length, astCacheHits: calls.filter(call => call.cacheHit).length,
    astProblems: calls.filter(call => call.status !== "ready" || call.partial || call.diagnostics).length,
    unavailableLspCalls: stage.getLspCalls() - lspStart };
  return { ...score, elapsedMs, retrievalMs: Math.round(retrievalMs * 100) / 100,
    managed22k, production36k, runtime,
    toolOk: result.ok, toolError: result.error, totalFiles: raw.totalFiles, totalChunks: raw.totalChunks,
    texts: { semantic: semanticText, fullPromptBeforeCap: fullText, deliveredPrompt: prompt },
    astCalls: calls, unavailableLspCalls: stage.getLspCalls() - lspStart };
}

function summarize(results) {
  const sum = get => results.reduce((n, item) => n + get(item), 0);
  const kinds = ["fullMethods", "exactYaml", "signatures"];
  return { passedCases: sum(item => Number(item.passed)), totalCases: results.length,
    semanticCoverage: Object.fromEntries(kinds.map(kind => [kind, { covered: sum(item => item.semanticCoverage[kind].covered), required: sum(item => item.semanticCoverage[kind].required) }])),
    promptCoverage: Object.fromEntries(kinds.map(kind => [kind, { covered: sum(item => item.promptCoverage[kind].covered), required: sum(item => item.promptCoverage[kind].required) }])),
    semanticChars: sum(item => item.chars.semanticText), deliveredPromptChars: sum(item => item.chars.deliveredPrompt),
    semanticDuplicateChars: sum(item => item.overlap.semantic.duplicateSourceChars),
    promptDuplicateChars: sum(item => item.overlap.deliveredPrompt.duplicateSourceChars),
    failedCases: results.filter(item => !item.passed).map(item => item.id) };
}

function compactCoverage(value) {
  if (!value) return value;
  return Object.fromEntries(Object.entries(value).map(([kind, metric]) => [kind,
    typeof metric === "number" ? metric : { required: metric.required, covered: metric.covered,
      missing: metric.missing || metric.entries.filter(entry => !entry.covered).map(({ covered, ...entry }) => entry) }]));
}

function compactResult(value, replay = false) {
  if (!value) return value;
  const result = { ...value };
  for (const key of ["texts", "astCalls", "links", "providers", "chunks", "snippets", "documentationQueries"]) delete result[key];
  result.semanticCoverage = replay ? undefined : compactCoverage(value.semanticCoverage);
  result.promptCoverage = compactCoverage(value.promptCoverage);
  if (!replay) {
    result.paths = value.paths || {
      candidates: [...new Set((value.chunks || []).map(item => item.path))],
      semantic: [...new Set((value.snippets || []).map(item => item.path))],
    };
    if (value.astCalls) result.nativeAst = {
      calls: value.astCalls.length, ready: value.astCalls.filter(item => item.status === "ready").length,
      cacheHits: value.astCalls.filter(item => item.cacheHit).length,
      partial: value.astCalls.filter(item => item.partial).length,
      diagnosticCount: value.astCalls.reduce((n, item) => n + item.diagnostics, 0),
      problems: value.astCalls.filter(item => item.status !== "ready" || item.partial || item.diagnostics),
    };
    result.managed22k = compactResult(value.managed22k, true);
    result.production36k = compactResult(value.production36k, true);
  } else {
    for (const key of ["paths", "selection", "diagnostics", "nativeAst", "abstention"]) delete result[key];
    if (value.abstention) result.abstention = value.abstention;
    result.chars = { ...result.chars };
    for (const key of ["semanticText", "semanticSnippetText", "rawCandidatePreviewText"]) delete result.chars[key];
    result.overlap = { ...result.overlap };
    delete result.overlap.semantic;
    result.textSha256 = { ...result.textSha256 };
    delete result.textSha256.semantic;
    if (result.bytes) { result.bytes = { ...result.bytes }; delete result.bytes.semanticText; }
  }
  if (value.repeatChecks) result.repeatChecks = value.repeatChecks.map(({ semanticSha256, ...check }) => check);
  return result;
}

function compactReport(report, dumpDirectory) {
  const oracle = { ...report.oracle };
  if (oracle.fixture.files) {
    oracle.originalSerializationSha256 = sha(JSON.stringify(report.oracle));
    oracle.fixture = { commit: oracle.fixture.commit, sha256: oracle.fixture.sha256, fileCount: oracle.fixture.files.length };
  }
  oracle.cases = oracle.cases.map(item => ({ ...item,
    evidence: item.evidence.map(({ text, ...range }) => range),
    excludedBodies: item.excludedBodies.map(({ text, ...range }) => range),
  }));
  const runs = report.runs.map((run, index) => {
    const result = { ...run };
    if (dumpDirectory && run.cases?.some(item => item.stage1?.texts || item.stage2?.texts)) {
      const content = `${JSON.stringify(run)}\n`;
      const filename = path.join(dumpDirectory, `run-${run.startedAt.replace(/[:.]/g, "-")}-${run.current.sha256.slice(0, 12)}.json`);
      fs.mkdirSync(dumpDirectory, { recursive: true });
      fs.writeFileSync(filename, content);
      result.debugDump = { path: filename, bytes: Buffer.byteLength(content), sha256: sha(content) };
    }
    for (const name of ["baseline", "current"]) {
      const snapshot = run[name];
      result[name] = { directory: snapshot.directory, sha256: snapshot.sha256, fileCount: snapshot.fileCount ?? snapshot.files?.length,
        retrievalFiles: snapshot.retrievalFiles || snapshot.files?.filter(item => /^(projectContextService|projectSemanticService|projectToolsService|projectStructure|nativeXbslAstService|contextTools|managedContextToolLoopService)\.ts$/.test(item.path)) };
    }
    if (index === report.runs.length - 1) {
      result.cases = run.cases?.map(item => ({ id: item.id, stage1: compactResult(item.stage1), stage2: compactResult(item.stage2) }));
    } else {
      // Historical totals retain comparisons; only the newest run needs per-case diagnostics.
      result.caseOutcomes = run.caseOutcomes || run.cases?.map(item => ({ id: item.id,
        ...Object.fromEntries(["stage1", "stage2"].filter(name => item[name]).map(name => [name, {
          passed: item[name].passed, methods: `${item[name].promptCoverage.fullMethods.covered}/${item[name].promptCoverage.fullMethods.required}`,
          yaml: `${item[name].promptCoverage.exactYaml.covered}/${item[name].promptCoverage.exactYaml.required}`,
          bodyChars: item[name].promptCoverage.excludedBodyChars,
          promptChars: item[name].chars.deliveredPrompt, latencyMs: item[name].latencyMs,
        }])) }));
      delete result.cases;
      delete result.baseline.retrievalFiles;
      delete result.current.retrievalFiles;
      delete result.resources;
      delete result.latencyProtocol;
      delete result.managedProtocol;
    }
    return result;
  });
  return { schemaVersion: 2, oracle, runs };
}

function saveReport(report, output, dumpDirectory) {
  if (dumpDirectory) {
    const relative = path.relative(root, dumpDirectory);
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Debug dumps must be outside the repository");
  }
  const compact = compactReport(report, dumpDirectory);
  const content = `${JSON.stringify(compact, null, 1)}\n`;
  fs.writeFileSync(output, content);
  console.error(`Summary: ${Buffer.byteLength(content)} bytes; full prompts ${dumpDirectory ? `saved under ${dumpDirectory}` : "not persisted (use --dump-dir outside the repo)"}`);
}

async function main() {
  const project = path.resolve(arg("--project") || DEFAULT_PROJECT);
  const baselinePath = path.resolve(arg("--baseline-src") || DEFAULT_BASELINE);
  const output = path.resolve(arg("--output") || DEFAULT_REPORT);
  const parserJar = path.resolve(arg("--parser-jar") || DEFAULT_JAR);
  const dumpDirectory = arg("--dump-dir") ? path.resolve(arg("--dump-dir")) : undefined;
  if (process.argv.includes("--compact-report")) {
    saveReport(JSON.parse(fs.readFileSync(output, "utf8")), output, dumpDirectory);
    return;
  }
  assert.ok(fs.existsSync(project), `Fixture missing: ${project}. Find an existing clone before cloning.`);
  const baseline = sourceSnapshot(baselinePath);
  if (process.argv.includes("--freeze-oracle")) {
    assert.ok(!fs.existsSync(output), "Refusing to replace an existing frozen oracle");
    const oracle = freezeOracle(project, baseline);
    fs.writeFileSync(output, `${JSON.stringify(compactReport({ oracle, runs: [] }), null, 2)}\n`, { flag: "wx" });
    console.log(`Oracle frozen before retrieval: ${output}; ${oracle.cases.length} cases; ${oracle.definitionsSha256}`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  validateOracle(report.oracle, project, baseline);
  const current = sourceSnapshot(path.join(root, "src"));
  const resources = [parserJar, path.join(root, "resources/context/ast/native-xbsl-ast.jar"), path.join(root, "resources/context/yaml.cjs")]
    .map(filename => ({ path: filename, sha256: sha(fs.readFileSync(filename)) }));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "context-stage2-eval-"));
  const stages = [];
  const run = { harnessRevision: 6, harnessSha256: sha(fs.readFileSync(__filename)),
    startedAt: new Date().toISOString(), phase: arg("--phase") || "preliminary", project,
    fixtureCommit: report.oracle.fixture.commit, oracleSha256: sha(JSON.stringify(report.oracle)), settings: SETTINGS,
    baseline: { directory: baseline.directory, sha256: baseline.sha256, files: baseline.manifest },
    current: { directory: current.directory, sha256: current.sha256, files: current.manifest },
    resources, nativeResourceRoot: root, liveLsp: false, simulatedLsp: false,
    runtimeEnvironment: { node: process.version, platform: process.platform, arch: process.arch,
      logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), loadAverageBefore: os.loadavg(),
      note: arg("--runtime-note") || "Unisolated local machine; concurrent processes can affect wall time.",
      cpuScope: "Node benchmark process during real 20000-character search only; excludes Java worker CPU, setup and replay/metric computation." },
    latencyProtocol: "Separate stage instances and indexes; index prebuilt with listSymbols; native worker prewarmed with identical tiny method. First pass then two repeated passes, alternating stage order. Wall time includes retrieval and real tool formatting, excludes setup and metric computation. No live LSP, model, network, or token measurement.",
    managedProtocol: "Primary comparison: both stages at limits.maxChars=22000. Production-budget comparison: the same stage2 raw result at limits.maxChars=36000. Retain 20000 default-tool results separately. All replays use real ProjectToolsService.search; chars and evidence come from actual result blocks. replayFormattingMs excludes retrieval and is not end-to-end latency. The old global 60000/new 128000-character docs/rules envelope is outside this benchmark. Equal tool budgets do not equalize version-specific internal snippet budgets.",
    setup: {}, cases: [] };
  try {
    stages.push(makeStage("stage1", baseline, project, temporary, parserJar));
    if (!process.argv.includes("--stage1-only")) stages.push(makeStage("stage2", current, project, temporary, parserJar));
    for (const stage of stages) {
      const start = performance.now();
      const probe = await stage.native.parse("метод ПроверкаБенчмарка()\n    возврат\n;\n");
      assert.equal(probe.status, "ready", `Native AST required: ${probe.reason}`);
      const parserStartupMs = Math.round(performance.now() - start);
      const indexStart = performance.now();
      await stage.context.listSymbolsTool("benchmark", { query: "__benchmark_index_warmup__" });
      run.setup[stage.name] = { parserStartupMs, parserVersion: probe.parserVersion, indexBuildMs: Math.round(performance.now() - indexStart) };
    }
    for (let iteration = 0; iteration < SETTINGS.repetitions; iteration++) {
      for (let index = 0; index < report.oracle.cases.length; index++) {
        const item = report.oracle.cases[index];
        const entry = run.cases[index] || (run.cases[index] = { id: item.id, query: item.query });
        const order = (iteration + index) % 2 ? [...stages].reverse() : stages;
        for (const stage of order) {
          const result = await runQuery(stage, item, project);
          if (iteration === 0) entry[stage.name] = { ...result, latencyMs: [result.elapsedMs], repeatChecks: [] };
          else {
            const first = entry[stage.name];
            first.latencyMs.push(result.elapsedMs);
            first.repeatChecks.push({ passed: result.passed, runtime: result.runtime, semanticSha256: result.textSha256.semantic,
              sameSemanticText: first.textSha256.semantic === result.textSha256.semantic,
              sameCoverage: JSON.stringify(first.promptCoverage) === JSON.stringify(result.promptCoverage),
              managed22k: { passed: result.managed22k.passed, replayFormattingMs: result.managed22k.replayFormattingMs,
                samePromptText: first.managed22k.textSha256.deliveredPrompt === result.managed22k.textSha256.deliveredPrompt,
                sameCoverage: JSON.stringify(first.managed22k.promptCoverage) === JSON.stringify(result.managed22k.promptCoverage) },
              production36k: result.production36k ? { passed: result.production36k.passed,
                replayFormattingMs: result.production36k.replayFormattingMs,
                samePromptText: first.production36k.textSha256.deliveredPrompt === result.production36k.textSha256.deliveredPrompt,
                sameCoverage: JSON.stringify(first.production36k.promptCoverage) === JSON.stringify(result.production36k.promptCoverage) } : undefined });
          }
          console.error(`${iteration + 1}/${SETTINGS.repetitions} ${stage.name} ${item.id}: ${result.passed ? "PASS" : "FAIL"}; methods ${result.promptCoverage.fullMethods.covered}/${result.promptCoverage.fullMethods.required}; YAML ${result.promptCoverage.exactYaml.covered}/${result.promptCoverage.exactYaml.required}; ${result.elapsedMs}ms`);
        }
      }
    }
    validateOracle(report.oracle, project, baseline);
    for (const resource of resources) assert.equal(sha(fs.readFileSync(resource.path)), resource.sha256, "Shared parser resources changed during run");
    const baselineAfter = sourceSnapshot(baselinePath).sha256;
    const currentAfter = sourceSnapshot(path.join(root, "src")).sha256;
    const oracleAfter = sha(JSON.stringify(JSON.parse(fs.readFileSync(output, "utf8")).oracle));
    assert.equal(baselineAfter, baseline.sha256, "Baseline source changed during run");
    assert.equal(oracleAfter, run.oracleSha256, "Oracle changed during run");
    run.currentSourceChangedDuringRun = current.sha256 !== currentAfter;
    run.integrity = { baselineBefore: baseline.sha256, baselineAfter, currentBefore: current.sha256, currentAfter,
      oracleBefore: run.oracleSha256, oracleAfter, fixtureSha256: report.oracle.fixture.sha256, resourcesUnchanged: true };
    run.runtimeEnvironment.loadAverageAfter = os.loadavg();
    run.summary = Object.fromEntries(stages.map(stage => [stage.name, summarize(run.cases.map(item => ({ id: item.id, ...item[stage.name] })))]));
    run.managed22kSummary = Object.fromEntries(stages.map(stage => [stage.name, summarize(run.cases.map(item => ({ id: item.id, ...item[stage.name].managed22k })))]));
    if (stages.some(stage => stage.name === "stage2")) run.production36kSummary = {
      stage2: summarize(run.cases.map(item => ({ id: item.id, ...item.stage2.production36k }))),
    };
    run.completedAt = new Date().toISOString();
    report.runs.push(run);
    saveReport(report, output, dumpDirectory);
    console.log(JSON.stringify(run.summary, null, 2));
    console.log("Managed 22000-character result blocks:");
    console.log(JSON.stringify(run.managed22kSummary, null, 2));
    if (run.production36kSummary) {
      console.log("Stage2 production 36000-character result blocks (same retrieval):");
      console.log(JSON.stringify(run.production36kSummary, null, 2));
    }
    if (process.argv.includes("--strict") && [...Object.values(run.summary), ...Object.values(run.managed22kSummary),
      ...Object.values(run.production36kSummary || {})].some(summary => summary.failedCases.length)) process.exitCode = 1;
  } finally {
    for (const stage of stages) stage.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { CASES, SETTINGS, sourceSnapshot, snapshotLoader, lineRange, mapSegment, duplicateChars, coverage, excludedBodyChars, scoreResult, compactReport };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

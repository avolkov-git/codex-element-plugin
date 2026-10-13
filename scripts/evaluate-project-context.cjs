"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const ts = require("typescript");
const { loadSource, logger, root } = require("../tests/service-test-utils.cjs");

function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const project = path.resolve(argument("--project") || ".");
const parserJar = argument("--parser-jar");
const baselineRef = argument("--baseline-ref") || "HEAD";
const uri = (file) => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
const event = () => ({ dispose() {} });
const vscode = {
  Uri: { file: uri, parse: (value) => uri(fileURLToPath(value)) }, RelativePattern: class {},
  workspace: { workspaceFolders: [{ uri: uri(project) }], textDocuments: [],
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event, onDidCreate: event, onDidDelete: event }) }
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "element-context-eval-"));
const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode });
const { ProjectSemanticService } = loadSource("src/projectSemanticService.ts", { vscode });
const { NativeXbslAstService, collectNativeAstSymbols } = loadSource("src/nativeXbslAstService.ts", { vscode });
const { formatSemanticContext } = loadSource("src/projectSemanticService.ts", { vscode });
const ast = new NativeXbslAstService(root, logger, parserJar ? { parserJarPath: parserJar } : {});
const language = { inspect: async () => ({ status: "unavailable", reason: "Offline evaluation: no running IDE", symbols: [], queries: [] }) };
const semantic = new ProjectSemanticService(ast, language, logger);
const current = new ProjectContextService({}, path.join(temporary, "new"), logger, semantic);

function baseline() {
  const source = execFileSync("git", ["show", `${baselineRef}:src/projectContextService.ts`], { cwd: root, encoding: "utf8" });
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { exports: module.exports, module, require: (name) => name === "vscode" ? vscode : require(name),
    Buffer, process, console, setTimeout, clearTimeout, Date, Error, URL });
  return new module.exports.ProjectContextService({}, path.join(temporary, "old"), logger);
}

async function scanNativeProject() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".xbsl")) files.push(file);
    }
  };
  walk(path.join(project, "DOMRF", "Start"));
  const started = performance.now();
  const result = { files: files.length, ready: 0, partial: 0, diagnostics: 0, nodes: 0, nodeKinds: 0, methods: 0, calls: 0, dynamicCalls: 0, elapsedMs: 0 };
  const kinds = new Set();
  for (const file of files.sort()) {
    const parsed = await ast.parse(fs.readFileSync(file, "utf8"));
    if (parsed.status !== "ready" || !parsed.root) throw new Error(`Native AST failed: ${path.relative(project, file)}: ${parsed.status}`);
    result.ready++; result.partial += Number(parsed.partial); result.diagnostics += parsed.diagnostics.length;
    const symbols = collectNativeAstSymbols(parsed);
    result.methods += symbols.filter(symbol => symbol.kind === "method").length;
    result.calls += symbols.filter(symbol => symbol.kind === "call").length;
    result.dynamicCalls += symbols.filter(symbol => symbol.nodeKind === "DynamicMethodInvocation").length;
    const pending = [parsed.root];
    while (pending.length) { const node = pending.pop(); result.nodes++; kinds.add(node.kind); pending.push(...node.children); }
  }
  result.nodeKinds = kinds.size; result.elapsedMs = Math.round(performance.now() - started);
  if (result.partial || result.diagnostics) throw new Error("The reference project no longer has a clean full native AST.");
  return result;
}

async function run() {
  const old = baseline();
  try {
    const formBase = "DOMRF/Start/СтандартноеПриложение/ПерсональныеНастройкиПользователя/ЗамещениеПользователяФорма";
    if (!fs.existsSync(path.join(project, `${formBase}.xbsl`))) throw new Error("This benchmark requires the supplied privet-dom-app fixture.");
    const source = fs.readFileSync(path.join(project, `${formBase}.xbsl`), "utf8");
    const parsed = await ast.parse(source);
    if (parsed.status !== "ready") throw new Error(`Native parser is required for this evaluation: ${parsed.status} ${parsed.reason || ""}`);
    const declarations = collectNativeAstSymbols(parsed).filter((item) => item.kind === "method");
    const cases = [
      { name: "Кнопка и обработчик", query: "В ЗамещениеПользователяФорма проверь ПриНажатии Применить: какая проверка выполняется перед изменением замещения?", methods: ["Применить", "МожноПрименить"], link: "Применить" },
      { name: "Условие доступности", query: "В ЗамещениеПользователяФорма почему МожноПрименить не разрешает сохранить замещение с неправильным периодом?", methods: ["МожноПрименить"], link: "МожноПрименить" },
      { name: "Текст ошибки", query: "В ЗамещениеПользователяФорма найди ПодсказкаПроверки: почему нельзя назначить самого себя замещающим?", methods: ["ПодсказкаПроверки"], link: "ПодсказкаПроверки" },
    ];
    const report = { projectCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(),
      baselineRef, baselineCommit: execFileSync("git", ["rev-parse", baselineRef], { cwd: root, encoding: "utf8" }).trim(),
      parser: parsed.parserVersion, nativeAstStatus: parsed.status,
      liveLsp: false, parserPrewarmed: true,
      note: "Deterministic retrieval comparison in one form, not an end-to-end model quality measurement. Before counts search previews; after counts bounded semantic context. Context size is not matched.", cases: [] };
    for (const item of cases) {
      const oldStart = performance.now();
      const before = await old.searchTool("eval", item.query);
      const oldMs = Math.round(performance.now() - oldStart);
      const newStart = performance.now();
      const after = await current.searchTool("eval", item.query);
      const newMs = Math.round(performance.now() - newStart);
      const oldText = before.chunks.map((chunk) => chunk.preview).join("\n");
      const newText = formatSemanticContext(after.semantic);
      const normalize = (value) => value.replace(/\s+/g, " ").trim();
      const complete = (text) => item.methods.filter((name) => {
        const method = declarations.find((declaration) => declaration.name === name);
        return method && normalize(text).includes(normalize(source.slice(method.startOffset, method.endOffset)));
      }).length;
      report.cases.push({ name: item.name, query: item.query,
        before: { elapsedMs: oldMs, completeMethods: complete(oldText), contextChars: oldText.length, paths: [...new Set(before.chunks.map((chunk) => chunk.path))] },
        after: { elapsedMs: newMs, completeMethods: complete(newText), contextChars: newText.length, paths: [...new Set(after.semantic.snippets.map((snippet) => snippet.path))],
          expectedLink: after.semantic.links.filter((link) => link.name === item.link), documentationQueries: after.semantic.documentationQueries,
          providers: after.semantic.providers, diagnostics: after.semantic.diagnostics }, expectedMethods: item.methods.length });
    }
    const warmStart = performance.now();
    await current.searchTool("eval", cases[0].query);
    report.warmQueryMs = Math.round(performance.now() - warmStart);
    if (process.argv.includes("--scan-all")) report.nativeScan = await scanNativeProject();
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const output = argument("--output");
    if (output) fs.writeFileSync(output, json);
    process.stdout.write(json);
    if (report.cases.some((item) => item.after.completeMethods !== item.expectedMethods || !item.after.expectedLink.some((link) => link.targets.length))) {
      throw new Error("Context retrieval regression: expected complete methods and YAML links were not found.");
    }
  } finally { old.dispose(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  current.dispose(); ast.dispose(); fs.rmSync(temporary, { recursive: true, force: true });
});

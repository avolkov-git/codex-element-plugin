"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { root, logger } = require("../tests/service-test-utils.cjs");
const { sourceSnapshot, snapshotLoader } = require("./evaluate-project-context-stage2.cjs");

const DEFAULT_PROJECT = "/tmp/codex-context-privet-dom-app";
const DEFAULT_JAR = "/Users/aleksandrvolkov/pet-project/element-ai/theia-plugin-qc/artifacts/server 9.1.9-17/ide/theia/plugins/@1c-appengine-plugin/bin/appengine-lsp/repo/com.e1c.g5rt.lsp.server.appengine-9.1.9-1.jar";
const EXPECTED_COMMIT = "5f3e72ed3afed7d04b9af8b700fe5094c847ee32";
const SYNC = "DOMRF/Start/СинхронизацияДанных/ОсновныеНастройкиСинхронизацииДанныхКомпонент";
const PAYROLL = "DOMRF/Start/КадровоеДелопроизводство/ЗарплатаИУправлениеПерсоналом";
const API = `${PAYROLL}/ЗарплатаИУправлениеПерсоналомПрограммныйИнтерфейс`;
const CALLER = `${PAYROLL}/РеализацияКонтрактов/ЗарплатаИУправлениеПерсоналомкЗапланированныеЗаданияСервис.xbsl`;
const HANDLER = "ВыполнитьПроверкуДоступности";
const DIRECT = "РазделительЗапланированныхЗаданий";
const METHOD_REF = "ПолнаяЗагрузкаОрганизаций";
const SUFFIX = "Stage3";
const RULE_DIRECTORY = ".local-codex/rules";
const GLOBAL_RULES = ".local-codex/rules.md";
const RULE_SYNC = `${RULE_DIRECTORY}/10-sync.md`;
const RULE_API = `${RULE_DIRECTORY}/20-payroll-api.md`;

// Read from the real checkout before invoking either AST or the change analyzer.
// Pins, source lines and expectations are independent of observed evaluation output.
const PINS = {
  [`${SYNC}.xbsl`]: "c0b6a75560d5b6cbbbe33a141cc2f0028cbd438d6553d579f569107a3a3cf208",
  [`${SYNC}.yaml`]: "fa1b871e3cd1fbe11466b3c84bddb6cf82e21959d8d2c0de0d5be1eabe754d4b",
  [`${API}.xbsl`]: "4b4de08c404857e12ebce5bafaf04066ba18aae6e1593c915b3a44bf1cdd77db",
  [CALLER]: "858e81ae3ce370742355fd6d086e4827a127f6a14c0c3c8e9ff1bc74e2f69335",
  [GLOBAL_RULES]: "21c77b782419552b39533c644915af36a56da75246e43a9b810489e47dd92eac",
};
const EVIDENCE = [
  { path: `${SYNC}.xbsl`, line: 10, contains: `метод ${HANDLER}(`, role: "handler declaration" },
  { path: `${SYNC}.yaml`, line: 40, contains: `ПриНажатии: ${HANDLER}`, role: "button binding" },
  { path: `${SYNC}.yaml`, line: 56, contains: "ПриНажатии: ВыполнитьПроверкуДоступностиПорта", role: "unchanged binding" },
  { path: `${SYNC}.yaml`, line: 66, contains: "ПриНажатии: ИдентификаторыВнешнихСистемКнопкаПриНажатии", role: "unchanged binding" },
  { path: `${API}.xbsl`, line: 13, contains: `метод ${DIRECT}()`, role: "common method declaration" },
  { path: `${API}.xbsl`, line: 40, contains: `метод ${METHOD_REF}()`, role: "common method declaration" },
  { path: CALLER, line: 56, contains: `ЗарплатаИУправлениеПерсоналомПрограммныйИнтерфейс.${DIRECT}()`, role: "direct inbound call" },
  { path: CALLER, line: 5, contains: `&ЗарплатаИУправлениеПерсоналомПрограммныйИнтерфейс.${METHOD_REF}`, role: "inbound method reference" },
];
const handlerEdit = { path: `${SYNC}.xbsl`, from: `метод ${HANDLER}(`, to: `метод ${HANDLER}${SUFFIX}(` };
const CASES = [
  { id: "handler-rename-without-yaml", edits: [handlerEdit], target: SYNC, rules: [RULE_SYNC],
    expected: { handler: { name: HANDLER, line: 40, evidence: "candidate", resolution: "unresolved" }, structuralHandlers: 2, syntax: false } },
  { id: "handler-consistent-rename", edits: [handlerEdit,
    { path: `${SYNC}.yaml`, from: `ПриНажатии: ${HANDLER}\n`, to: `ПриНажатии: ${HANDLER}${SUFFIX}\n` }], target: SYNC, rules: [RULE_SYNC],
    expected: { handler: { name: `${HANDLER}${SUFFIX}`, line: 40, evidence: "structural", resolution: "structural" }, structuralHandlers: 3, syntax: false } },
  { id: "introduced-syntax-error", edits: [{ path: `${SYNC}.xbsl`,
    from: `метод ${HANDLER}(Источник: Компонент, Событие: СобытиеКомпонента)`,
    to: `метод ${HANDLER}(Источник: Компонент, Событие: СобытиеКомпонента]` }], target: SYNC, rules: [RULE_SYNC],
    expected: { syntax: true, syntaxPath: `${SYNC}.xbsl` } },
  { id: "common-method-inbound-call", edits: [{ path: `${API}.xbsl`, from: `метод ${DIRECT}()`, to: `метод ${DIRECT}${SUFFIX}()` }], target: API, rules: [RULE_API],
    expected: { syntax: false, impact: { path: CALLER, line: 56, name: DIRECT, occurrenceKind: "call" } } },
  { id: "common-method-inbound-methodref", edits: [{ path: `${API}.xbsl`, from: `метод ${METHOD_REF}()`, to: `метод ${METHOD_REF}${SUFFIX}()` }], target: API, rules: [RULE_API],
    expected: { syntax: false, impact: { path: CALLER, line: 5, name: METHOD_REF, occurrenceKind: "method-reference" } } },
  { id: "unchanged", edits: [], rules: [], expected: { unchanged: true, syntax: false } },
];
const RULE_FIXTURES = [
  { path: RULE_SYNC, paths: ["DOMRF/Start/СинхронизацияДанных/**"], elementKinds: ["КомпонентИнтерфейса"],
    sourceText: "Строковые форматтеры держим рядом с компонентом:" },
  { path: RULE_API, paths: [`${PAYROLL}/**`], elementKinds: ["ОбщийМодуль"],
    sourceText: "Если общий модуль предполагает методы с аннотацией" },
  { path: `${RULE_DIRECTORY}/90-unrelated.md`, paths: ["DOMRF/Start/ФизическиеЛица/**"], elementKinds: ["Справочник"],
    sourceText: "В прикладных данных ссылки на пользователя" },
];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const ms = start => Math.round((performance.now() - start) * 100) / 100;
const stable = value => JSON.stringify(value);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const sorted = values => [...values].sort();
const same = (a, b) => stable(sorted(a)) === stable(sorted(b));
const size = text => ({ chars: text.length, bytes: Buffer.byteLength(text), sha256: sha(text) });

function options(argv) {
  const result = { project: DEFAULT_PROJECT, jar: DEFAULT_JAR, output: path.join(root, "docs/project-changes-evaluation.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help") return { help: true };
    const key = argv[i].replace(/^--/, "");
    assert.ok(["project", "jar", "output"].includes(key) && argv[i].startsWith("--"), `Unknown option: ${argv[i]}`);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith("--"), `Missing value: ${argv[i]}`);
    result[key] = path.resolve(argv[++i]);
  }
  return result;
}

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fixtureState(project) {
  const names = git(project, "ls-files", "-z").split("\0").filter(name => /\.(?:xbsl|ya?ml)$/i.test(name) || name === GLOBAL_RULES).sort();
  const files = names.map(name => {
    assert.ok(!fs.lstatSync(path.join(project, name)).isSymbolicLink(), `Symlink fixture refused: ${name}`);
    const content = fs.readFileSync(path.join(project, name));
    return { path: name, sha256: sha(content), bytes: content.length };
  });
  return { commit: git(project, "rev-parse", "HEAD").trim(), gitStatus: git(project, "status", "--porcelain=v1", "-z"),
    files, sha256: sha(stable(files)) };
}

function freezeOracle(project, fixture) {
  assert.equal(fixture.commit, EXPECTED_COMMIT, "Unexpected project commit; the source oracle must not be silently changed");
  for (const [name, expected] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(path.join(project, name))), expected, `Oracle drift: ${name}`);
  const evidence = EVIDENCE.map(item => {
    const text = fs.readFileSync(path.join(project, item.path), "utf8").split(/\r?\n/)[item.line - 1];
    assert.ok(text?.includes(item.contains), `Independent source evidence missing: ${item.path}:${item.line}`);
    return { ...item, textSha256: sha(text) };
  });
  return { method: "Manually read real source before AST/analyzer execution; pinned hashes and line evidence, never learned from findings.",
    definitionsSha256: sha(stable({ PINS, EVIDENCE, CASES, RULE_FIXTURES })), pins: PINS, evidence, cases: CASES,
    rules: { kind: "Synthetic selectors in temporary copies; bodies are verbatim applicable lines from real global rules", fixtures: RULE_FIXTURES },
    semantics: "Matched YAML handlers are structural observations, not errors. Missing local declarations are unresolved candidates, not proof of missing inherited handlers. AST occurrences are not resolved targets. Syntax expected only on the modified file; baseline native diagnostics are separately checked." };
}

function mockVscode(project) {
  const event = () => ({ dispose() {} });
  const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => pathToFileURL(file).href });
  return { Uri: { file: uri, parse: value => uri(fileURLToPath(value)) }, RelativePattern: class {},
    workspace: { workspaceFolders: [{ uri: uri(project) }], textDocuments: [], onDidChangeWorkspaceFolders: event,
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event, onDidCreate: event, onDidDelete: event }) } };
}

function copyFixture(project, destination, files) {
  for (const file of files) {
    const to = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(project, file.path), to);
    assert.equal(sha(fs.readFileSync(to)), file.sha256, `Copy drift: ${file.path}`);
  }
  const rules = fs.readFileSync(path.join(destination, GLOBAL_RULES), "utf8");
  for (const rule of RULE_FIXTURES) {
    const lines = rules.split(/\r?\n/).filter(line => line.includes(rule.sourceText));
    assert.equal(lines.length, 1, `Rule source must be unique: ${rule.sourceText}`);
    const text = `---\npaths:\n${rule.paths.map(value => `  - ${JSON.stringify(value)}`).join("\n")}\nelementKinds:\n${rule.elementKinds.map(value => `  - ${JSON.stringify(value)}`).join("\n")}\n---\n${lines[0]}\n`;
    fs.mkdirSync(path.dirname(path.join(destination, rule.path)), { recursive: true });
    fs.writeFileSync(path.join(destination, rule.path), text, { flag: "wx" });
  }
}

function temporaryDigest(directory) {
  const entries = [];
  function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) walk(file);
      else entries.push([path.relative(directory, file), sha(fs.readFileSync(file))]);
    }
  }
  walk(directory);
  return sha(stable(entries));
}

function mutate(directory, edits) {
  for (const edit of edits) {
    const filename = path.join(directory, edit.path);
    const source = fs.readFileSync(filename, "utf8");
    const from = source.includes("\r\n") ? edit.from.replace(/\n/g, "\r\n") : edit.from;
    const to = source.includes("\r\n") ? edit.to.replace(/\n/g, "\r\n") : edit.to;
    assert.equal(source.split(from).length - 1, 1, `Mutation anchor must occur once: ${edit.path}: ${edit.from}`);
    fs.writeFileSync(filename, source.replace(from, to));
  }
}

function astSummary(result) {
  return { status: result.status, sourceHash: result.sourceHash, partial: result.partial, cacheHit: Boolean(result.cacheHit),
    parserVersion: result.parserVersion, parserFingerprint: result.parserFingerprint, semanticBound: result.semanticBound,
    nodeCount: result.nodeCount, diagnostics: result.diagnostics, code: result.code, reason: result.reason };
}

function summarizeRules(result) {
  return { status: result.status.status, globalMatches: result.matchCount, scopedMatches: result.scopedMatchCount,
    scopedPaths: result.scopedPaths, globalText: size(result.text || ""), scopedText: size(result.scopedText || ""), warnings: result.warnings || [] };
}

async function runCase(item, environment) {
  const start = performance.now();
  const directory = path.join(environment.temporary, item.id, "project");
  const timing = {};
  let mark = performance.now();
  copyFixture(environment.project, directory, environment.fixture.files);
  timing.copyMs = ms(mark);
  const load = snapshotLoader(environment.source, { vscode: mockVscode(directory) });
  const { ProjectContextService } = load("projectContextService.ts");
  const { RulesContextService } = load("rulesContextService.ts");
  const { analyzeProjectChanges, PROJECT_CHANGE_LIMITS } = load("projectChangeAnalysis.ts");
  const { formatChangeReview } = load("projectChangeReviewService.ts");
  const context = new ProjectContextService({}, path.join(environment.temporary, item.id, "index"), logger);
  const rules = new RulesContextService(logger);
  const nativeCalls = [], inspections = [], reads = [];
  const checks = [];
  const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details === undefined ? {} : { details }) });
  try {
    mark = performance.now();
    const before = await context.captureChangeSnapshot("stage3-evaluation", true);
    timing.beforeSnapshotMs = ms(mark);
    const target = item.target ? before.files.find(file => file.path === `${item.target}.yaml`) : undefined;
    check("target-indexed-with-element-kind", !item.target || Boolean(target?.structure?.element?.kind));
    mark = performance.now();
    const rulesBefore = await rules.buildContext("project", true, target ? [{ path: target.path, elementKind: target.structure?.element?.kind }] : []);
    timing.rulesBeforeMs = ms(mark);
    check("scoped-rules-before-exact", same(rulesBefore.scopedPaths || [], item.rules));
    check("global-rules-preserved-before", rulesBefore.matchCount === 1);
    check("no-rules-warnings-before", !rulesBefore.warnings?.length);
    mark = performance.now();
    mutate(directory, item.edits);
    timing.mutationMs = ms(mark);
    mark = performance.now();
    const after = await context.captureChangeSnapshot("stage3-evaluation", true);
    timing.afterSnapshotMs = ms(mark);
    const readOnlyBefore = temporaryDigest(directory);
    const cpuBefore = process.cpuUsage();
    mark = performance.now();
    const report = await analyzeProjectChanges({ before, after,
      readFile: async file => {
        const readStart = performance.now();
        const result = await after.readFile(file);
        reads.push({ path: file, bytes: Buffer.byteLength(result.text), elapsedMs: ms(readStart) });
        return result;
      },
      parse: async (text, signal) => {
        const parseStart = performance.now();
        const result = await environment.native.parse(text, { signal });
        nativeCalls.push({ ...astSummary(result), elapsedMs: ms(parseStart) });
        return result;
      },
      inspect: async (file, positions) => {
        inspections.push({ path: file, positions });
        return { status: "unavailable", reason: "Offline evaluation: no IDE or live LSP; no fabricated provider definitions", symbols: [], queries: [] };
      },
      isCurrent: () => before.isCurrent() && after.isContentCurrent(),
    });
    timing.analysisMs = ms(mark);
    const cpu = process.cpuUsage(cpuBefore);
    timing.analysisNodeCpuMs = { user: cpu.user / 1000, system: cpu.system / 1000, excludesJava: true };
    mark = performance.now();
    const rulesAfter = await rules.buildContext("project", true, report.elementTargets);
    timing.rulesAfterMs = ms(mark);
    const formatted = formatChangeReview({ report, diagnostics: [], text: "" });
    const readOnlyAfter = temporaryDigest(directory);
    check("analysis-and-rule-selection-read-only", readOnlyBefore === readOnlyAfter);
    const expectedChanged = [...new Set(item.edits.map(edit => edit.path))];
    check("exact-changed-paths", same(report.changedPaths, expectedChanged), { expected: expectedChanged, actual: report.changedPaths });
    check("not-stale", report.status !== "stale");
    check("no-fabricated-lsp-targets", report.findings.every(finding => finding.evidence !== "lsp" && finding.resolution !== "lsp" && !finding.targets?.length));
    check("scoped-rules-after-exact", same(rulesAfter.scopedPaths || [], item.rules));
    check("global-rules-preserved-after", rulesAfter.matchCount === 1);
    check("no-rules-warnings-after", !rulesAfter.warnings?.length);
    check("within-count-and-byte-bounds", report.counts.parses <= PROJECT_CHANGE_LIMITS.parses
      && report.counts.filesRead <= PROJECT_CHANGE_LIMITS.files && report.counts.inspections <= PROJECT_CHANGE_LIMITS.inspections
      && report.counts.sourceBytes <= PROJECT_CHANGE_LIMITS.sourceBytes
      && report.counts.sourceBytes + report.counts.verifiedBytes <= PROJECT_CHANGE_LIMITS.totalBytes
      && report.findings.length <= PROJECT_CHANGE_LIMITS.findings);
    check("within-wall-time-bound-with-scheduler-slack", timing.analysisMs <= PROJECT_CHANGE_LIMITS.deadlineMs + 2000);
    check("formatted-report-bounded", formatted.length <= 16000);
    check("native-calls-not-faked", nativeCalls.every(call => call.status === "ready" && call.parserVersion && call.semanticBound === false));
    check("native-call-accounting", report.counts.parses === nativeCalls.length);
    const syntax = report.findings.filter(finding => finding.kind === "syntax");
    check("syntax-expectation", item.expected.syntax ? syntax.some(finding => finding.path === item.expected.syntaxPath && finding.evidence === "ast") : syntax.length === 0);
    if (item.expected.handler) {
      const expected = item.expected.handler;
      check("yaml-handler-evidence", report.findings.some(finding => finding.kind === "yaml-handler" && finding.path === `${SYNC}.yaml`
        && Object.entries(expected).every(([key, value]) => finding[key] === value)));
      check("exact-three-yaml-handlers", report.findings.filter(finding => finding.kind === "yaml-handler").length === 3);
      check("structurally-matched-handler-count", report.findings.filter(finding => finding.kind === "yaml-handler" && finding.resolution === "structural").length === item.expected.structuralHandlers);
    }
    if (item.expected.impact) {
      check("exact-inbound-ast-occurrence", report.findings.some(finding => finding.kind === "impact" && finding.evidence === "ast"
        && finding.resolution === "unresolved" && finding.candidatePaths?.includes(`${API}.xbsl`)
        && Object.entries(item.expected.impact).every(([key, value]) => finding[key] === value)));
    }
    if (item.expected.unchanged) {
      check("unchanged-no-findings-no-io", report.status === "unchanged" && report.findings.length === 0
        && report.checkedPaths.length === 0 && reads.length === 0 && nativeCalls.length === 0 && inspections.length === 0);
    } else {
      check("changed-files-checked", expectedChanged.every(file => report.checkedPaths.includes(file)));
      check("real-native-ast-used", nativeCalls.length > 0);
      check("offline-lsp-fallback-exercised", inspections.length > 0);
    }
    const expectedEvidence = report.findings.filter(finding => finding.kind === "syntax" || finding.kind === "yaml-handler"
      || (item.expected.impact && Object.entries(item.expected.impact).every(([key, value]) => finding[key] === value)));
    check("oracle-evidence-survives-report-formatting", expectedEvidence.every(finding =>
      formatted.includes(`- ${finding.path}:${finding.line} [${finding.evidence}; ${finding.kind}] ${finding.message}`)));
    timing.totalMs = ms(start);
    return { id: item.id, passed: checks.every(entry => entry.passed), checks, timing,
      snapshot: { implementation: "ProjectContextService.captureChangeSnapshot(profile, true)", beforeFiles: before.files.length,
        afterFiles: after.files.length, coverage: after.coverage,
        beforeSha256: sha(stable(before.files.map(file => [file.path, file.hash]))), afterSha256: sha(stable(after.files.map(file => [file.path, file.hash]))) },
      rules: { before: summarizeRules(rulesBefore), after: summarizeRules(rulesAfter) },
      report: { status: report.status, changedPaths: report.changedPaths, changes: report.changes, checkedPaths: report.checkedPaths,
        elementTargets: report.elementTargets, counts: report.counts, findingCount: report.findings.length,
        findingCounts: Object.fromEntries(["syntax", "yaml-handler", "impact"].map(kind => [kind, report.findings.filter(finding => finding.kind === kind).length])),
        findingPaths: sorted(new Set(report.findings.map(finding => finding.path))),
        oracleFindings: expectedEvidence, otherFindingCount: report.findings.length - expectedEvidence.length,
        limitations: report.limitations, omittedLimitations: report.omittedLimitations, json: size(stable(report)), formatted: size(formatted),
        formattedOracleEvidence: expectedEvidence.map(finding => ({ path: finding.path, line: finding.line,
          included: formatted.includes(`- ${finding.path}:${finding.line} [${finding.evidence}; ${finding.kind}] ${finding.message}`) })) },
      nativeAst: { calls: nativeCalls.length, ready: nativeCalls.filter(call => call.status === "ready").length,
        cacheHits: nativeCalls.filter(call => call.cacheHit).length, partial: nativeCalls.filter(call => call.partial).length,
        nodes: nativeCalls.reduce((sum, call) => sum + call.nodeCount, 0),
        diagnostics: nativeCalls.reduce((sum, call) => sum + call.diagnostics.length, 0),
        elapsedMs: nativeCalls.reduce((sum, call) => sum + call.elapsedMs, 0),
        problems: nativeCalls.filter(call => call.status !== "ready" || call.partial || call.diagnostics.length) },
      lsp: { live: false, fakeDefinitions: false, unavailableCalls: inspections.length, requestedPositions: inspections.reduce((sum, call) => sum + call.positions.length, 0) },
      reads: { calls: reads.length, uniquePaths: new Set(reads.map(read => read.path)).size,
        bytesIncludingRevalidation: reads.reduce((sum, read) => sum + read.bytes, 0),
        elapsedMs: reads.reduce((sum, read) => sum + read.elapsedMs, 0) },
      readOnly: { beforeSha256: readOnlyBefore, afterSha256: readOnlyAfter, unchanged: readOnlyBefore === readOnlyAfter } };
  } finally { context.dispose(); }
}

function save(report, output) {
  report.artifactBytes = 0;
  let text;
  for (;;) {
    text = `${JSON.stringify(report, null, 2)}\n`;
    const bytes = Buffer.byteLength(text);
    if (bytes === report.artifactBytes) break;
    report.artifactBytes = bytes;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text);
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args.help) {
    console.log("Usage: node scripts/evaluate-project-changes.cjs [--project PATH] [--jar PATH] [--output PATH]\nSix fixed real-project mutation scenarios. Requires the pinned checkout, Java and native parser JAR.\nOnly temporary source copies are mutated. Failing expectations return exit code 1 and remain in the JSON report.");
    return;
  }
  const started = performance.now();
  const project = fs.realpathSync(args.project);
  assert.ok(!inside(project, path.resolve(args.output)) && !inside(path.resolve(args.project), path.resolve(args.output)),
    "Report output must not be inside the read-only fixture");
  let existingParent = path.dirname(args.output);
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  const resolvedOutput = path.resolve(fs.realpathSync(existingParent), path.relative(existingParent, args.output));
  assert.ok(!inside(project, resolvedOutput), "Report output must not reach the fixture through a symlink");
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const output = path.join(fs.realpathSync(path.dirname(args.output)), path.basename(args.output));
  assert.ok(!inside(project, output), "Report output must not be inside the read-only fixture");
  assert.ok(!fs.existsSync(output) || !fs.lstatSync(output).isSymbolicLink(), "Refusing symlink output");
  const fixture = fixtureState(project);
  const oracle = freezeOracle(project, fixture);
  const source = sourceSnapshot(path.join(root, "src"));
  const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : undefined;
  if (previous) assert.equal(previous.oracle?.definitionsSha256, oracle.definitionsSha256, "Refusing to overwrite a different oracle; do not tune it after observing failures");
  const resources = [args.jar, path.join(root, "resources/context/ast/native-xbsl-ast.jar"), path.join(root, "resources/context/yaml.cjs")]
    .map(file => ({ path: file, sha256: sha(fs.readFileSync(file)) }));
  const baselineFile = path.join(root, "docs/project-context-stage2-evaluation.json");
  const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  const baselineRun = baseline.runs.at(-1);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-changes-evaluation-")));
  const load = snapshotLoader(source, { vscode: mockVscode(temporary) });
  const { NativeXbslAstService } = load("nativeXbslAstService.ts");
  const { PROJECT_CHANGE_LIMITS } = load("projectChangeAnalysis.ts");
  const native = new NativeXbslAstService(root, logger, { parserJarPath: args.jar });
  const report = { schemaVersion: 1, oracle,
    limitations: [
      "No live IDE, LSP, provider diagnostics, server index, semantic binding, compilation, application execution, model or model-quality evaluation.",
      "Only the unavailable-LSP branch is exercised. Empty mocked provider data is never evidence of successful LSP validation.",
      "Copies include tracked XBSL/YAML plus real global rules, not binaries, docs, user-data, untracked files or the complete deployable application.",
      "Scoped selectors are synthetic evaluation fixtures; their bodies are selected verbatim from existing project rules. This measures selection, not developer/model compliance.",
      "Fixed source-based expectations cover selected occurrences, not exhaustive impact precision/recall. Common-module name seeding may include unchanged methods and unrelated receivers.",
      "A partial report may satisfy selected expectations. Report status, omitted work and limits remain visible and are not upgraded to checked.",
      "One sequential pass with a shared warmed native worker and cache; no latency distribution or speedup claim. Node CPU excludes Java; machine load is uncontrolled.",
      "Old stage2 did not produce post-change reports. Comparison is structural capability/output accounting only; old absence is not a measured failed detection.",
      "Runtime source is frozen in memory via the existing stage2 snapshot loader (same TypeScript transpilation approach as service-test-utils.loadSource); hashes record concurrent source edits.",
    ],
    baseline: { stage: "old-stage2", reportPath: baselineFile, reportSha256: sha(fs.readFileSync(baselineFile)),
      lastRun: baselineRun.startedAt, postChangeReports: 0, changeDetectionAccuracy: null, postChangeFindingCount: null,
      note: "Historical pre-edit retrieval only, different tasks. No apples-to-apples accuracy, runtime or model-quality delta.",
      retrievalStructure: { cases: baselineRun.summary.stage2.totalCases, semanticChars: baselineRun.summary.stage2.semanticChars,
        deliveredPromptChars: baselineRun.summary.stage2.deliveredPromptChars, semanticDuplicateChars: baselineRun.summary.stage2.semanticDuplicateChars } },
    run: { startedAt: new Date().toISOString(), command: [process.execPath, __filename, "--project", args.project, "--jar", args.jar, "--output", output],
      harnessSha256: sha(fs.readFileSync(__filename)), project, fixtureCommit: fixture.commit,
      fixture: { fileCount: fixture.files.length, sourceFiles: fixture.files.filter(file => /\.(xbsl|ya?ml)$/i.test(file.path)).length,
        bytes: fixture.files.reduce((sum, file) => sum + file.bytes, 0), sha256: fixture.sha256, initialGitStatusSha256: sha(fixture.gitStatus) },
      source: { sha256: source.sha256, files: source.manifest.filter(file => /projectChange|projectContextService|projectStructure|projectAstReferences|nativeXbsl|rulesContext|scopedProject/.test(file.path)) },
      resources, limits: PROJECT_CHANGE_LIMITS, environment: { node: process.version, platform: process.platform, arch: process.arch,
        logicalCpus: os.cpus().length, loadAverageBefore: os.loadavg() }, nativeBaseline: [], cases: [] } };
  const priorFailures = previous?.run?.cases?.filter(item => !item.passed).map(item => ({ id: item.id, failedChecks: item.checks?.filter(check => !check.passed), error: item.error })) || [];
  if (priorFailures.length) report.previousFailureEvidence = { sourceSha256: previous.run.source.sha256, startedAt: previous.run.startedAt, cases: priorFailures };
  save(report, output);
  console.error(`Oracle frozen before execution: ${oracle.definitionsSha256}`);
  try {
    for (const file of [`${SYNC}.xbsl`, `${API}.xbsl`, CALLER]) {
      const mark = performance.now();
      const result = await native.parse(fs.readFileSync(path.join(project, file), "utf8"));
      report.run.nativeBaseline.push({ path: file, elapsedMs: ms(mark), ...astSummary(result) });
      assert.equal(result.status, "ready", `Real native parser required: ${result.reason}`);
      assert.equal(result.partial, false, `Baseline AST partial: ${file}`);
      assert.equal(result.diagnostics.length, 0, `Independent syntax premise failed: ${file}`);
    }
    for (const item of CASES) {
      let result;
      try { result = await runCase(item, { project, temporary, source, fixture, native }); }
      catch (error) { result = { id: item.id, passed: false, error: String(error.stack || error) }; }
      report.run.cases.push(result);
      save(report, output);
      console.error(`${result.passed ? "PASS" : "FAIL"} ${item.id}: ${result.report?.status || "error"}; findings=${result.report?.findingCount ?? "n/a"}; parses=${result.nativeAst?.calls ?? "n/a"}; ${result.timing?.analysisMs ?? "n/a"}ms`);
      for (const check of result.checks?.filter(check => !check.passed) || []) console.error(`  FAILED: ${check.name}`);
      if (result.error) console.error(result.error);
    }
  } catch (error) { report.run.error = String(error.stack || error); }
  finally {
    native.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
    report.run.temporaryCopiesRemoved = !fs.existsSync(temporary);
    const after = fixtureState(project);
    report.run.integrity = { fixtureUnchanged: fixture.sha256 === after.sha256 && fixture.commit === after.commit,
      gitStatusUnchanged: fixture.gitStatus === after.gitStatus, fixtureAfterSha256: after.sha256,
      sourceAfterSha256: sourceSnapshot(path.join(root, "src")).sha256,
      resourcesUnchanged: resources.every(item => sha(fs.readFileSync(item.path)) === item.sha256) };
    report.run.integrity.sourceChangedDuringRun = report.run.integrity.sourceAfterSha256 !== source.sha256;
    report.run.environment.loadAverageAfter = os.loadavg();
    report.run.durationMs = ms(started);
    report.run.completedAt = new Date().toISOString();
    const cases = report.run.cases;
    report.run.summary = { passedCases: cases.filter(item => item.passed).length, totalCases: CASES.length,
      failedCases: cases.filter(item => !item.passed).map(item => item.id),
      postChangeReports: cases.filter(item => item.report && item.report.status !== "unchanged").length,
      partialReports: cases.filter(item => item.report?.status === "partial").length,
      nativeParseCalls: cases.reduce((sum, item) => sum + (item.nativeAst?.calls || 0), 0),
      unavailableLspCalls: cases.reduce((sum, item) => sum + (item.lsp?.unavailableCalls || 0), 0),
      formattedReportChars: cases.reduce((sum, item) => sum + (item.report?.formatted.chars || 0), 0),
      formattedReportBytes: cases.reduce((sum, item) => sum + (item.report?.formatted.bytes || 0), 0) };
    report.run.passed = !report.run.error && cases.length === CASES.length && cases.every(item => item.passed)
      && report.run.integrity.fixtureUnchanged && report.run.integrity.gitStatusUnchanged && report.run.integrity.resourcesUnchanged;
    save(report, output);
  }
  console.log(JSON.stringify({ passed: report.run.passed, ...report.run.summary, durationMs: report.run.durationMs, artifactBytes: report.artifactBytes, output }, null, 2));
  if (report.run.error) console.error(report.run.error);
  if (!report.run.passed) process.exitCode = 1;
}

module.exports = { CASES, PINS, EVIDENCE, options };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

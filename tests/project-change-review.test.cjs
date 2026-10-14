const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { loadSource, logger } = require("./service-test-utils.cjs");

function fixture() {
  let profile = "one";
  let current = true;
  let hash = "a";
  let diagnostics = [];
  let failRead = false;
  let failCapture = false;
  let analysisHook;
  const calls = [];
  const root = path.resolve("/project");
  const capture = async () => {
    if (failCapture) throw new Error("capture failed");
    const captured = hash;
    return { workspaceRoot: root, files: [{ path: "Panel.xbsl", hash },
      { path: "Panel.yaml", hash: "yaml", structure: { element: { kind: "Форма" } } }], coverage: "bounded-index",
      isCurrent: () => current,
      isContentCurrent: () => current && captured === hash && !failRead,
      readFile: async name => {
        calls.push(name);
        if (failRead || captured !== hash) throw new Error("changed");
        return { text: "source", hash };
      } };
  };
  const report = { status: "checked", changedPaths: ["Panel.xbsl"], checkedPaths: ["Panel.xbsl"],
    findings: [{ kind: "impact", path: "Panel.xbsl", line: 3, message: "Check receiver", evidence: "candidate" }],
    limitations: [], elementTargets: [{ path: "Panel.xbsl", elementKind: "Форма" }] };
  const vscode = { languages: { getDiagnostics: () => diagnostics }, DiagnosticSeverity: { Error: 0, Warning: 1 }, Uri: { file: file => ({ fsPath: file }) } };
  const { ProjectChangeReviewService, formatChangeReview } = loadSource("src/projectChangeReviewService.ts", {
    vscode, "./projectChangeAnalysis": { analyzeProjectChanges: async options => { await analysisHook?.(options); return report; } }
  });
  const service = new ProjectChangeReviewService({ captureChangeSnapshot: capture }, {}, {}, () => profile, logger);
  const diagnostic = (file, message, line = 2, severity = 0) => [{ scheme: "file", fsPath: path.join(root, file) }, [{ severity, message, range: { start: { line } } }]];
  return { service, report, calls, diagnostic, formatChangeReview,
    profile: value => { profile = value; }, scope: value => { current = value; }, hash: value => { hash = value; },
    diagnostics: value => { diagnostics = value; }, failRead: () => { failRead = true; }, failCapture: () => { failCapture = true; },
    hook: fn => { analysisHook = fn; } };
}

test("review reads only diagnostic cache entries for changed or related files, without declaring new errors introduced", async () => {
  const f = fixture();
  f.diagnostics([f.diagnostic("Panel.xbsl", "Existing", 2), f.diagnostic("Other.xbsl", "Unrelated")]);
  const before = await f.service.begin();
  f.diagnostics([f.diagnostic("Panel.xbsl", "Existing", 12), f.diagnostic("Panel.xbsl", "Observed warning", 5, 1), f.diagnostic("Other.xbsl", "Unrelated")]);
  const result = await f.service.complete("chat", before, () => true);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].observed, "existing");
  assert.equal(result.diagnostics[1].observed, "not-in-baseline");
  assert.match(result.text, /без подтверждения повторной компиляции/);
  assert.match(result.text, /авторство изменений не устанавливается/);
  assert.doesNotMatch(result.text, /Unrelated/);
});

test("empty IDE cache is never presented as successful compilation", async () => {
  const f = fixture();
  const result = await f.service.complete("chat", await f.service.begin(), () => true);
  assert.match(result.text, /Пустой кеш не означает отсутствие ошибок/);
  assert.match(result.text, /не сборка/);
});

test("report reaches next request only after validating its source hashes", async () => {
  const f = fixture();
  await f.service.complete("chat", await f.service.begin(), () => true);
  const block = await f.service.context("chat");
  assert.equal(block.source, "project");
  assert.equal(block.metadata.targets[0].elementKind, "Форма");
  assert.deepEqual(f.calls, ["Panel.xbsl"]);
  f.hash("b");
  assert.equal(await f.service.context("chat"), undefined);
});

test("next request refreshes IDE cache even when source hashes have not changed", async () => {
  const f = fixture();
  const baseline = await f.service.begin();
  f.diagnostics([f.diagnostic("Panel.xbsl", "Old cached diagnostic")]);
  await f.service.complete("chat", baseline, () => true);
  f.diagnostics([f.diagnostic("Panel.xbsl", "Fresh cached diagnostic")]);
  const block = await f.service.context("chat");
  assert.doesNotMatch(block.text, /Old cached diagnostic/);
  assert.match(block.text, /Fresh cached diagnostic/);
  f.diagnostics([]);
  assert.doesNotMatch((await f.service.context("chat")).text, /Fresh cached diagnostic/);
});

test("next-turn rule targets include changed XBSL even when analyzer element targets contain only YAML", async () => {
  const f = fixture();
  f.report.elementTargets = [{ path: "Panel.yaml", elementKind: "Форма" }];
  await f.service.complete("chat", await f.service.begin(), () => true);
  const block = await f.service.context("chat");
  assert.deepEqual(JSON.parse(JSON.stringify(block.metadata.targets)), [
    { path: "Panel.xbsl", elementKind: "Форма" }, { path: "Panel.yaml", elementKind: "Форма" }
  ]);
});

test("YAML-only changes retain the indexed XBSL companion and LSP target as rule targets", async () => {
  const f = fixture();
  f.report.changedPaths = ["Panel.yaml"];
  f.report.findings = [{ path: "Panel.yaml", kind: "yaml-handler", line: 1, evidence: "lsp", message: "handler",
    targets: [{ path: "Panel.xbsl", line: 1 }] }];
  f.report.elementTargets = [{ path: "Panel.yaml", elementKind: "Форма" }];
  await f.service.complete("chat", await f.service.begin(), () => true);
  const block = await f.service.context("chat");
  assert.ok(block.metadata.targets.some(target => target.path === "Panel.xbsl" && target.elementKind === "Форма"));
});

test("strict after-snapshot validity protects unchanged results and empty checkedPaths", async () => {
  const f = fixture();
  f.report.status = "unchanged";
  f.report.checkedPaths = [];
  const before = await f.service.begin();
  f.hook(() => f.hash("changed during analysis"));
  assert.equal(await f.service.complete("chat", before, () => true), undefined);
  f.hook(undefined);
  f.report.status = "partial";
  await f.service.complete("chat", await f.service.begin(), () => true);
  f.failRead();
  assert.equal(await f.service.context("chat"), undefined, "no checked paths does not bypass strict validity");
});

test("malformed diagnostic records cannot suppress later valid IDE errors", async () => {
  const f = fixture();
  const nullCode = f.diagnostic("Panel.xbsl", "Null code is optional");
  nullCode[1][0].code = null;
  const malformed = f.diagnostic("Panel.xbsl", null);
  f.diagnostics([nullCode, malformed, f.diagnostic("Panel.xbsl", "Valid error after malformed")]);
  const result = await f.service.complete("chat", await f.service.begin(), () => true);
  assert.equal(result.diagnostics.length, 2);
  assert.match(result.text, /Valid error after malformed/);
});

for (const change of ["profile", "workspace", "cancel", "stale"]) test(`discard ${change} during analysis`, async () => {
  const f = fixture();
  let valid = true;
  const before = await f.service.begin();
  f.hook(() => {
    if (change === "profile") f.profile("two");
    if (change === "workspace") f.scope(false);
    if (change === "cancel") valid = false;
    if (change === "stale") f.report.status = "stale";
  });
  assert.equal(await f.service.complete("chat", before, () => valid), undefined);
  assert.equal(await f.service.context("chat"), undefined);
});

test("unreadable files remove remembered report instead of replaying it", async () => {
  const f = fixture();
  await f.service.complete("chat", await f.service.begin(), () => true);
  f.failRead();
  assert.equal(await f.service.context("chat"), undefined);
  assert.equal(await f.service.context("chat"), undefined);
});

test("baseline failure is optional, not a successful check", async () => {
  const f = fixture(); f.failCapture();
  assert.equal(await f.service.begin(), undefined);
});

test("remembered reports are bounded and scoped to chat", async () => {
  const f = fixture();
  for (let i = 0; i < 9; i++) await f.service.complete(`chat${i}`, await f.service.begin(), () => true);
  assert.equal(await f.service.context("chat0"), undefined);
  assert.ok(await f.service.context("chat8"));
  f.service.forget("chat8");
  assert.equal(await f.service.context("chat8"), undefined);
  f.service.clear();
  assert.equal(await f.service.context("chat7"), undefined);
});

test("long reports disclose omitted output", () => {
  const f = fixture(); f.report.findings[0].message = "x".repeat(20000);
  const text = f.formatChangeReview({ report: f.report, diagnostics: [] });
  assert.ok(text.length <= 16000);
  assert.match(text, /часть замечаний не включена/);
});

test("real index snapshots preserve the report across refresh and invalidate same-stat shell changes", async t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "change-review-integration-")));
  const root = path.join(temporary, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "project.yaml"), "Name: Review\n");
  const file = path.join(root, "Panel.xbsl");
  fs.writeFileSync(file, "method Pulse()\n    return 1\n;\n");
  const uri = file => ({ scheme: "file", fsPath: file, toString: () => pathToFileURL(file).href });
  const event = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: uri }, RelativePattern: class {}, DiagnosticSeverity: { Error: 0, Warning: 1 },
    languages: { getDiagnostics: () => [] },
    workspace: { workspaceFolders: [{ uri: uri(root) }], textDocuments: [], onDidChangeWorkspaceFolders: event,
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event, onDidCreate: event, onDidDelete: event }) }
  };
  const { ProjectContextService } = loadSource("src/projectContextService.ts", { vscode });
  const { ProjectChangeReviewService } = loadSource("src/projectChangeReviewService.ts", { vscode });
  const project = new ProjectContextService({}, path.join(temporary, "config"), logger);
  const service = new ProjectChangeReviewService(project, {
    parse: async text => ({ status: "unavailable", sourceHash: createHash("sha256").update(text).digest("hex"), code: "parser_not_found" })
  }, {}, () => "user", logger);
  t.after(() => { project.dispose(); service.clear(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const baseline = await service.begin();
  assert.ok(baseline);
  fs.writeFileSync(file, "method Pulse()\n    return 2\n;\n");
  const result = await service.complete("chat", baseline, () => true);
  assert.deepEqual([...result.report.changedPaths], ["Panel.xbsl"]);
  assert.equal(result.report.status, "partial");
  assert.ok(await service.context("chat"));
  assert.ok(await service.context("chat"), "same content survives another force refresh");
  const stat = fs.statSync(file);
  fs.writeFileSync(file, "method Pulse()\n    return 3\n;\n");
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(await service.context("chat"), undefined);
});

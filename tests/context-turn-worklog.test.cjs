const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");
const { ContextTurnOrchestrator } = loadSource("src/contextTurnOrchestrator.ts");
const { ContextRouterService } = loadSource("src/contextRouterService.ts");

function harness({ pressure = false, saturate = false } = {}) {
  let rules = "PROJECT_RULES_REVISION_1";
  let rulesReads = 0;
  let projectReads = 0;
  const block = (source, size) => ({ source, text: source + "x".repeat(size), mode: "matched", matchCount: 1 });
  const blocks = saturate ? [block("docs", 128_000)] : pressure
    ? [block("docs", 22_000), block("docs", 7000), block("diagnostics", 16_000), block("project", 36_000), block("project", 8000)]
    : [block("project", 400)];
  const orchestrator = new ContextTurnOrchestrator({
    logger, contextRouter: new ContextRouterService(logger),
    baseContext: { buildContext: async () => ({ text: "b".repeat(pressure ? 17_000 : 10), matchCount: 1 }) },
    rulesContext: { buildContext: async () => {
      rulesReads++;
      return { text: rules + "r".repeat(pressure ? 11_000 : 0), matchCount: 1, status: { status: "active" } };
    } },
    projectContext: { getDetails: async () => { projectReads++; return { status: "active", label: "Ready" }; } },
    docsContext: { buildExplicitPathContext: async () => undefined },
    diagnosticsContext: { isDiagnosticsRelevantPrompt: () => false, isHighPriorityPrompt: () => false },
    nativeContextTools: { getSnapshot: () => ({ status: "unavailable" }) },
    managedContextTools: { buildContext: async () => ({ blocks, worklog: [], docsRoute: "added", projectRoute: "added", diagnosticsRoute: "added" }) },
    profiles: { getCurrentProfileId: () => "stock-review" },
    state: { setProjectContext() {}, setRulesContext() {} }, onDidChange() {}, onDidChangeChat() {},
  });
  return { orchestrator, setRules: value => { rules = value; }, counts: () => ({ rulesReads, projectReads }) };
}

function request(source = "editorSelection", size = 900, runMode = "execution", chatKind = "project") {
  const code = "метод ПровестиОстатки()\n" + "// stock ledger row\n".repeat(Math.ceil(size / 19)) + "возврат \"STOCK_END_MARKER\"\n;";
  assert.ok(Buffer.byteLength(code, "utf8") < 200 * 1024);
  return {
    chatId: "stock-audit", chatKind, cwd: "/warehouse", rulesEnabled: true,
    prompt: "Объясни файл stock/Ledger.xbsl и его расчёт", runMode,
    explicitContextBlocks: [{ source, text: code, matchCount: 1, mode: "matched" }],
  };
}

for (const mode of ["execution", "planning"]) test(`small editor context remains intact in ${mode}`, async () => {
  const { orchestrator } = harness();
  const input = request("editorSelection", 900, mode);
  const result = await orchestrator.buildTurnContext(input);
  assert.ok(result.input[0].text.includes(input.explicitContextBlocks[0].text));
  const entry = result.worklog.entries.find(item => item.source === "editorSelection");
  assert.equal(entry.truncated, false);
  assert.equal(entry.label, "Изучен выделенный фрагмент");
});

for (const source of ["editorFile", "editorSelection"]) {
  test(`budget trimming is visible in ${source} worklog`, async () => {
    const { orchestrator } = harness({ pressure: true });
    const result = await orchestrator.buildTurnContext(request(source, 120_000));
    const report = result.budget.sourceReports.find(item => item.source === source);
    const entry = result.worklog.entries.find(item => item.source === source);
    assert.ok(report.trimmedBlocks > 0);
    assert.equal(result.input[0].text.includes("STOCK_END_MARKER"), false);
    assert.equal(entry.chars, report.afterChars);
    assert.equal(entry.truncated, true);
    assert.match(entry.label, /контекст сокращён/);
    assert.ok(result.worklog.details.some(text => text.includes("truncated=true")));
  });
  test(`fully dropped ${source} is not reported as read`, async () => {
    const { orchestrator } = harness({ saturate: true });
    const result = await orchestrator.buildTurnContext(request(source));
    const entry = result.worklog.entries.find(item => item.source === source);
    assert.ok(entry);
    assert.equal(entry.chars, 0);
    assert.equal(entry.blockCount, 0);
    assert.equal(entry.truncated, true);
    assert.match(entry.label, /не включён: лимит контекста/);
  });
}

test("changed project rules reach next request with the same tool results", async () => {
  const h = harness();
  await h.orchestrator.buildTurnContext(request());
  h.setRules("PROJECT_RULES_REVISION_2");
  const result = await h.orchestrator.buildTurnContext(request());
  assert.ok(result.input[0].text.includes("PROJECT_RULES_REVISION_2"));
  assert.equal(result.input[0].text.includes("PROJECT_RULES_REVISION_1"), false);
  assert.equal(h.counts().rulesReads, 2);
});

test("general chat retains explicit input without project rules or index", async () => {
  const h = harness();
  const input = request("editorFile", 900, "execution", "general");
  const result = await h.orchestrator.buildTurnContext(input);
  assert.ok(result.input[0].text.includes(input.explicitContextBlocks[0].text));
  assert.deepEqual(h.counts(), { rulesReads: 0, projectReads: 0 });
});

test("scoped-only rules reach input with verified-source targets, not documentation metadata", async () => {
  const h = harness();
  let targets;
  h.orchestrator.options.rulesContext.buildContext = async (_kind, _enabled, selected) => {
    targets = selected;
    return { scopedText: "MODULE_RULE_MARKER", scopedMatchCount: 1, scopedPaths: ["module.md"],
      matchCount: 0, status: { status: "active" } };
  };
  const input = request();
  input.explicitContextBlocks = [
    { source: "editorSelection", text: "selected code", matchCount: 1, mode: "matched", metadata: { ruleTargets: [{ path: "/warehouse/Ledger.xbsl" }] } },
    { source: "project", text: "prior review", matchCount: 1, mode: "matched", metadata: { changeReview: true, ruleRoot: "/warehouse", targets: [{ path: "Form.xbsl", elementKind: "Component" }] } },
    { source: "project", text: "stale source", matchCount: 1, mode: "matched", metadata: { ruleRoot: "/other-project", ruleTargets: [{ path: "Stale.xbsl" }] } },
    { source: "docs", text: "reference", matchCount: 1, mode: "matched", metadata: { ruleTargets: [{ path: "NotProject.xbsl" }] } }
  ];
  const result = await h.orchestrator.buildTurnContext(input);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), [{ path: "/warehouse/Ledger.xbsl" }, { path: "Form.xbsl", elementKind: "Component" }]);
  assert.equal(result.rulesRoute, "added");
  assert.match(result.input[0].text, /MODULE_RULE_MARKER/);
  assert.equal(result.blocks.find(block => block.text === "MODULE_RULE_MARKER").metadata.scopedRules, true);
});

for (const route of ["technicalProject", "docsLookup", "docsOverview"]) test(`supplemental rules cannot displace global and base rules under ${route} pressure`, () => {
  const { applyContextBudget } = loadSource("src/contextBudgetPlanner.ts");
  const result = applyContextBudget([
    { source: "rules", text: "s".repeat(12000), matchCount: 1, mode: "matched", priority: 999, metadata: { scopedRules: true } },
    { source: "rules", text: "GLOBAL" + "r".repeat(6000), matchCount: 1, mode: "matched" },
    { source: "baseRules", text: "BASE" + "b".repeat(6000), matchCount: 1, mode: "matched" }
  ], { route, totalChars: 12500 });
  assert.ok(result.blocks.some(block => block.text === "GLOBAL" + "r".repeat(6000)));
  assert.ok(result.blocks.some(block => block.text === "BASE" + "b".repeat(6000)));
});

test("editor file and selection use the actual file path as a scoped-rule target", async () => {
  const { EditorContextService } = loadSource("src/editorContextService.ts", {
    vscode: { workspace: { asRelativePath: () => "Ledger.xbsl" }, window: { showWarningMessage() {} } }
  });
  const service = new EditorContextService();
  const document = { uri: { scheme: "file", fsPath: "/warehouse/Ledger.xbsl" }, languageId: "xbsl", getText: () => "code" };
  const selection = { isEmpty: false, start: { line: 0 }, end: { line: 1 } };
  for (const built of [service.buildFileRequest(document), service.buildSelectionRequest({ document, selections: [selection] })]) {
    assert.deepEqual(JSON.parse(JSON.stringify(built.contextBlock.metadata.ruleTargets)), [{ path: document.uri.fsPath }]);
  }
});

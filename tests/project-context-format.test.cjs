const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource, logger } = require("./service-test-utils.cjs");
const { formatSemanticContext } = loadSource("src/projectSemanticService.ts", { vscode: {} });
const { ProjectToolsService } = loadSource("src/projectToolsService.ts", { vscode: {} });
const { applyContextBudget } = loadSource("src/contextBudgetPlanner.ts");

function snippet(name, size) {
  return { path: `${name}.xbsl`, startLine: 1, endLine: 3, source: "native-ast", purpose: "implementation",
    text: `method ${name}()\n${"x".repeat(size)}\n;`, hash: name, fromOpenDocument: false, truncated: false };
}

function semantic(snippets) {
  return { links: [], hovers: [], diagnostics: [], providers: [{ path: "Target.xbsl", ast: "ready", lsp: "ready", parserVersion: "9.1.9-1" }],
    snippets, documentationQueries: [], selection: { intent: "implementation", maxDepth: 2, budgetChars: 32000, omittedRanges: 0 } };
}

test("semantic output budget preserves whole bodies and reports omitted ranges", () => {
  const first = snippet("Target", 1300), second = snippet("Dependency", 3000);
  const text = formatSemanticContext(semantic([first, second]), 2800);
  assert.ok(text.length <= 2800);
  assert.ok(text.includes(first.text));
  assert.ok(!text.includes("method Dependency"));
  assert.match(text, /Не включено в лимит вывода целых участков: 1/);
});

test("project tool uses the larger production limit without truncating a 25k body", async () => {
  const body = snippet("Target", 25_000);
  const tools = new ProjectToolsService({ searchTool: async () => ({ workspaceRoot: "/project", query: "Target", totalFiles: 1, totalChunks: 1,
    updatedAt: "now", chunks: [{ path: body.path, startLine: 1, endLine: 3, preview: "DUPLICATE_PREVIEW", chunkId: "target", score: 1,
      symbols: ["Target"], keywords: [], language: "xbsl" }], semantic: semantic([body]) }) }, logger, () => "user");
  const result = await tools.search({ chatId: "chat", query: "Target", reason: "test" });
  assert.equal(result.ok, true);
  assert.ok(result.blocks[0].text.includes(body.text));
  assert.ok(result.blocks[0].text.length <= 36_000);
  assert.ok(!result.blocks[0].text.includes("DUPLICATE_PREVIEW"));
  assert.equal(result.metadata.platformVersion, "9.1.9-1");
});

test("larger shared budget carries code, docs, diagnostics and both rule sources", () => {
  const blocks = [
    { source: "docs", text: "d".repeat(29_000) }, { source: "diagnostics", text: "e".repeat(16_000) },
    { source: "project", text: "p".repeat(44_000) }, { source: "baseRules", text: "b".repeat(18_000) },
    { source: "rules", text: "r".repeat(12_000) },
  ];
  const result = applyContextBudget(blocks, { route: "technicalProject" });
  assert.equal(result.totalCharsLimit, 128_000);
  assert.equal(result.blocks.length, blocks.length);
  assert.equal(result.trimmed.length, 0);
  assert.equal(result.dropped.length, 0);
});

test("project rules survive a constrained explicit project budget before optional evidence", () => {
  const rules = { source: "rules", text: "mandatory rules".repeat(100) };
  const result = applyContextBudget([{ source: "docs", text: "d".repeat(20_000) }, rules], { route: "explicitProject", totalChars: 4000 });
  assert.ok(result.blocks.some(block => block.source === "rules" && block.text === rules.text));
  assert.ok(result.afterChars <= 4000);
});

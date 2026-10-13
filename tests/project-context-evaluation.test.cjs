"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { CASES, SETTINGS, snapshotLoader, lineRange, mapSegment, duplicateChars, coverage, excludedBodyChars, scoreResult, compactReport } = require("../scripts/evaluate-project-context-stage2.cjs");

test("oracle covers eight tasks and preserves all three original regression queries", () => {
  assert.equal(CASES.length, 8);
  assert.equal(CASES.filter(item => item.id.startsWith("regression-")).length, 3);
  assert.ok(CASES.some(item => item.expectAbstention));
  assert.ok(CASES.some(item => item.excludedBodies?.length));
  assert.equal(SETTINGS.maxPreviewChars, 420);
  assert.equal(SETTINGS.maxChars, 20000);
  assert.equal(SETTINGS.managedMaxChars, 22000);
  assert.equal(SETTINGS.productionMaxChars, 36000);
});

test("snapshot loader isolates transitive source modules and caches identities", () => {
  const files = new Map([
    ["a.ts", "export { value } from './b'; export const dirname = __dirname;"],
    ["b.ts", "export const value = 'frozen';"],
  ]);
  const load = snapshotLoader({ directory: "/tmp/frozen/src", files });
  assert.equal(load("a.ts").value, "frozen");
  assert.equal(load("a.ts"), load("a.ts"));
  assert.ok(!load("a.ts").dirname.startsWith("/tmp/frozen"));
  assert.throws(() => load("missing.ts"), /Missing frozen source/);
});

test("coverage is path-qualified even for byte-identical same-named methods", () => {
  const item = { path: "Office.xbsl", start: 5, end: 20 };
  assert.equal(coverage([item], [{ path: "Organization.xbsl", start: 0, end: 100 }]).covered, 0);
  assert.equal(coverage([item], [{ path: "Office.xbsl", start: 0, end: 20 }]).covered, 1);
  assert.equal(coverage([item], [{ path: "Office.xbsl", start: 5, end: 10 }, { path: "Office.xbsl", start: 10, end: 20 }]).covered, 0);
});

test("truncation metadata cannot count an unseen method suffix", () => {
  const source = "method Target()\n    return 42\n;\n";
  const segment = mapSegment({ path: "A", startLine: 1, endLine: 4 }, source, "method Target()\n[truncated]");
  assert.equal(segment.end, "method Target()\n".length);
  assert.equal(coverage([{ path: "A", start: 0, end: source.trimEnd().length }], [segment]).covered, 0);
});

test("overlap counts repeated source positions, including partial overlap and containment", () => {
  const result = duplicateChars([
    { path: "A", start: 0, end: 10 }, { path: "A", start: 5, end: 15 },
    { path: "A", start: 6, end: 8 }, { path: "B", start: 0, end: 10 },
  ]);
  assert.deepEqual(result, { sourceChars: 32, uniqueSourceChars: 25, duplicateSourceChars: 7 });
  assert.equal(duplicateChars([]).duplicateSourceChars, 0);
});

test("preview prefixes map collapsed whitespace without trusting advertised ranges", () => {
  const source = "first\n  method Target()\n    return 42\n;";
  const item = { path: "A", startLine: 2, endLine: 4 };
  const segment = mapSegment(item, source, "method Target() return…", true);
  assert.equal(segment.start, source.indexOf("method"));
  assert.equal(segment.end, source.indexOf("return") + "return".length);
  assert.equal(mapSegment(item, source, "", true).start, mapSegment(item, source, "", true).end);
});

test("line ranges normalize only CRLF, preserving indentation and source content", () => {
  assert.deepEqual(lineRange("one\r\n  two\r\n;", 2, 3), { start: 4, end: 11 });
});

test("signature body overfetch counts union, not repeated copies of a body", () => {
  const bodies = [{ path: "A", start: 10, end: 30 }];
  assert.equal(excludedBodyChars(bodies, [{ path: "A", start: 0, end: 20 }, { path: "A", start: 10, end: 40 }]), 20);
  assert.equal(excludedBodyChars(bodies, [{ path: "B", start: 0, end: 100 }]), 0);
});

test("prompt cap reduces delivered coverage but not semantic-only coverage", () => {
  const source = "method Target()\n  return 1\n;";
  const item = { evidence: [{ kind: "method", path: "A", start: 0, end: source.length }], excludedBodies: [] };
  const raw = { chunks: [], semantic: { snippets: [{ path: "A", startLine: 1, endLine: 3, text: source }] } };
  const full = `Файл A:1-3; source=test\n${source}`;
  const result = scoreResult(item, raw, source, `${full.slice(0, 20)}…`, full, () => source);
  assert.equal(result.semanticCoverage.fullMethods.covered, 1);
  assert.equal(result.promptCoverage.fullMethods.covered, 0);
  assert.equal(result.passed, false);
});

test("flattened YAML preview is not exact YAML evidence", () => {
  const source = "field:\n  type: String";
  const preview = "field: type: String";
  const item = { evidence: [{ kind: "yaml", path: "A", start: 0, end: source.length }], excludedBodies: [] };
  const raw = { chunks: [{ path: "A", startLine: 1, endLine: 2, preview }], semantic: { snippets: [] } };
  const prompt = `1. A:1-2\n   preview: ${preview}`;
  const result = scoreResult(item, raw, "", prompt, prompt, () => source);
  assert.equal(result.promptCoverage.exactYaml.covered, 0);
});

test("unknown-symbol fallback is reported as failed abstention, not empty perfect coverage", () => {
  const raw = { chunks: [{ path: "A", startLine: 1, endLine: 1, preview: "unrelated" }], semantic: { snippets: [] } };
  const prompt = "1. A:1-1\n   preview: unrelated";
  const result = scoreResult({ evidence: [], excludedBodies: [], expectAbstention: true }, raw, "", prompt, prompt, () => "unrelated");
  assert.equal(result.abstention.passed, false);
  assert.equal(result.passed, false);
});

test("suppressed previews do not inflate formatted prompt size or overlap", () => {
  const source = "method Target()\n  return 1\n;";
  const raw = { chunks: [{ path: "A", startLine: 1, endLine: 3, preview: "method Target() return 1 ;" }],
    semantic: { snippets: [{ path: "A", startLine: 1, endLine: 3, text: source }] } };
  const prompt = `Файл A:1-3; source=test\n${source}`;
  const result = scoreResult({ evidence: [], excludedBodies: [] }, raw, source, prompt, prompt, () => source);
  assert.ok(result.chars.rawCandidatePreviewText > 0);
  assert.equal(result.chars.formattedPreviewText, 0);
  assert.equal(result.chars.deliveredPreviewText, 0);
  assert.equal(result.overlap.fullPromptBeforeCap.duplicateSourceChars, 0);
});

test("budget-aware omission never inherits coverage from raw semantic snippets", () => {
  const source = "method Target()\n  return 1\n;";
  const item = { evidence: [{ kind: "method", path: "A", start: 0, end: source.length }], excludedBodies: [] };
  const raw = { chunks: [], semantic: { snippets: [{ path: "A", startLine: 1, endLine: 3, text: source }] } };
  const prompt = "Whole snippet omitted due to budget.";
  const result = scoreResult(item, raw, source, prompt, prompt, () => source);
  assert.equal(result.semanticCoverage.fullMethods.covered, 1);
  assert.equal(result.promptCoverage.fullMethods.covered, 0);
  assert.equal(result.snippetDelivery.formatted, 0);
  assert.equal(result.overlap.fullPromptBeforeCap.sourceChars, 0);
});

test("an identical preview in another chunk does not restore suppressed path evidence", () => {
  const source = "method Target() return 1 ;";
  const item = { evidence: [{ kind: "method", path: "A", start: 0, end: source.length }], excludedBodies: [] };
  const raw = { semantic: { snippets: [] }, chunks: [
    { path: "A", startLine: 1, endLine: 1, preview: source },
    { path: "B", startLine: 1, endLine: 1, preview: source },
  ] };
  const prompt = `1. A:1-1\n2. B:1-1\n   preview: ${source}`;
  const result = scoreResult(item, raw, "", prompt, prompt, () => source);
  assert.equal(result.promptCoverage.fullMethods.covered, 0);
  assert.equal(result.chars.formattedPreviewText, source.length);
});

test("report compaction strips source text, prompt dumps and full project manifests", () => {
  const huge = "PRIVATE_FULL_PROMPT".repeat(10000);
  const report = { oracle: { fixture: { commit: "fixture", sha256: "fixture-hash", files: [{ path: "whole-project", sha256: "file" }] },
    cases: [{ id: "task", query: "frozen query", evidence: [{ path: "A", start: 0, end: 3, text: "source", sha256: "evidence-hash" }], excludedBodies: [] }] },
    runs: [{ startedAt: "now", baseline: { directory: "old", sha256: "old-hash", files: [] }, current: { directory: "new", sha256: "new-hash", files: [] },
      cases: [{ id: "task", stage1: { passed: true, texts: { semantic: huge }, chunks: [], snippets: [], astCalls: [] } }] }] };
  const compact = compactReport(report);
  const text = JSON.stringify(compact);
  assert.ok(text.length < 2000);
  assert.ok(!text.includes("PRIVATE_FULL_PROMPT"));
  assert.ok(!text.includes("whole-project"));
  assert.equal(compact.oracle.cases[0].evidence[0].sha256, "evidence-hash");
  assert.equal(compact.oracle.cases[0].query, "frozen query");
  assert.equal(JSON.stringify(compactReport(compact)), text);
});

test("historical compact outcomes remain idempotent across subsequent runs", () => {
  const report = { oracle: { fixture: { sha256: "fixture-hash" }, cases: [] }, runs: [
    { baseline: { directory: "old", sha256: "a" }, current: { directory: "new", sha256: "b" },
      caseOutcomes: [{ id: "task", stage1: { passed: false, methods: "0/1", yaml: "0/0", promptChars: 12 } }] },
    { baseline: { directory: "old", sha256: "a" }, current: { directory: "new", sha256: "c" }, cases: [] },
  ] };
  const compact = compactReport(report);
  assert.equal(JSON.stringify(compactReport(compact)), JSON.stringify(compact));
  assert.equal(compact.runs[0].caseOutcomes[0].stage1.methods, "0/1");
});

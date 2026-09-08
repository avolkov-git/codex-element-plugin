#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { buildHighlighter } = require("./build-xbsl-highlighter");

function assertNoCodeLoading(source) {
  const ast = ts.createSourceFile("bundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(ast);
      assert(!/(^|\.)(eval|Function|importScripts|fetch|XMLHttpRequest|WebSocket)$/.test(callee), `Forbidden code/network loading: ${callee}`);
      assert(node.expression.kind !== ts.SyntaxKind.ImportKeyword, "Dynamic imports are forbidden");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

async function main() {
  const webviewHtmlSource = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "webviewHtml.ts"),
    "utf8"
  );
  const highlighterSource = fs.readFileSync(
    path.resolve(__dirname, "..", "webview", "highlight", "engine.ts"),
    "utf8"
  );
  const build = await buildHighlighter();
  const highlighterBundle = build.outputFiles[0].text;
  assertNoCodeLoading(build.workerSource);
  assertNoCodeLoading(highlighterBundle);
  const sandbox = { window: {}, Blob, URL, TextEncoder, performance, setTimeout, clearTimeout, queueMicrotask };
  vm.runInNewContext(highlighterBundle, sandbox);
  const chatStyles = fs.readFileSync(path.resolve(__dirname, "..", "media", "chat.css"), "utf8");
  assert(!webviewHtmlSource.includes("'wasm-unsafe-eval'"), "Chat webview must not require WASM execution");
  assert(webviewHtmlSource.includes("worker-src blob:"), "Blob worker CSP is missing");
  assert(
    highlighterSource.includes("createJavaScriptRegexEngine"),
    "XBSL highlighter must use the CSP-safe JavaScript regex engine"
  );
  assert(!highlighterSource.includes("createOnigurumaEngine"), "XBSL highlighter still depends on Oniguruma WASM");
  assert(!/WebAssembly|wasm/i.test(highlighterBundle), "Built highlighter still contains a WASM dependency");
  assert(
    chatStyles.includes("var(--shiki-light") && chatStyles.includes("var(--shiki-dark"),
    "XBSL/YAML light and dark theme token bindings are missing"
  );

  const highlighter = sandbox.window.codexXbslHighlighter;
  assert(highlighter, "XBSL highlighter API is not exposed");
  assert(highlighter.supports("xbsl"), "XBSL alias is not supported");
  assert(highlighter.supports("yaml"), "YAML alias is not supported");

  const xbsl = await highlighter.highlight(
    [
      "структура Пользователь",
      "  знч Имя: Строка",
      ";",
      "",
      "метод ХостДоступен(Хост: Строка): Булево",
      '  пер Аргументы = <Объект>[]',
      "  если ТаймаутСекунд >= 90",
      '  Аргументы.Добавить("-c")',
      '    возврат "Недоступно"',
      "  ;",
      ";",
    ].join("\n"),
    "xbsl"
  );
  assert(xbsl.includes("--shiki-light"), "XBSL output has no light theme tokens");
  assert(xbsl.includes("--shiki-dark"), "XBSL output has no dark theme tokens");
  assert(xbsl.includes("xbsl-semantic-kind-function"), "XBSL semantic function decoration is missing");
  assert(xbsl.includes("--shiki-light:#1838FF"), "XBSL declaration keyword color differs from the Element IDE palette");
  assert(xbsl.includes("--shiki-light:#C400FF"), "XBSL control keyword color differs from the Element IDE palette");
  assert(xbsl.includes("--shiki-light:#8C6B2E"), "XBSL function color differs from the Element IDE palette");
  assert(xbsl.includes("--shiki-light:#2E8DB5"), "XBSL type color differs from the Element IDE palette");
  assert(xbsl.includes("--shiki-light:#C11F16"), "XBSL string color differs from the Element IDE palette");
  assert(
    xbsl.includes('--shiki-light:#1838FF;--shiki-dark:#66B3FF">метод</span>'),
    "Cyrillic declaration keywords are not recognized"
  );
  assert(
    xbsl.includes('--shiki-light:#C400FF;--shiki-dark:#D38CD3">  если</span>'),
    "Cyrillic control keywords are not recognized"
  );

  const yaml = await highlighter.highlight("name: demo\nenabled: true\nitems:\n  - one", "yaml");
  assert(yaml.includes("--shiki-light"), "YAML output has no light theme tokens");
  assert(yaml.includes("--shiki-dark"), "YAML output has no dark theme tokens");
  assert.equal(highlighter.getStats().mode, "fallback", "Node check must exercise the worker-unavailable fallback");
  await assert.rejects(highlighter.highlight("x".repeat(10000), "xbsl"));
  const stale = highlighter.highlight("пер A = 1", "xbsl", { blockId: "stream", version: 1 }).catch((error) => error.name);
  const current = highlighter.highlight("пер A = 2", "xbsl", { blockId: "stream", version: 2 });
  assert.equal(await stale, "AbortError");
  assert((await current).includes("2"));
  await assert.rejects(highlighter.highlight("пер A = 0", "xbsl", { blockId: "stream", version: 0 }), { name: "AbortError" });
  highlighter.dispose();
  assert.equal(highlighter.getStats().pendingBytes, 0);
  assert.equal(highlighter.getStats().cacheBytes, 0);
  console.log("XBSL/YAML palette, semantic grammar, bundled-code policy, bounded fallback and stale versions: passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

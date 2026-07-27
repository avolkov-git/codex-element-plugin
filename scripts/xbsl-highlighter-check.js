#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");

global.window = {};
require(path.resolve(__dirname, "..", "media", "xbsl-highlighter.js"));

async function main() {
  const webviewHtmlSource = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "webviewHtml.ts"),
    "utf8"
  );
  assert(
    webviewHtmlSource.includes("'wasm-unsafe-eval'"),
    "Chat webview CSP does not allow the Oniguruma WASM engine"
  );

  const highlighter = global.window.codexXbslHighlighter;
  assert(highlighter, "XBSL highlighter API is not exposed");
  assert(highlighter.supports("xbsl"), "XBSL alias is not supported");
  assert(highlighter.supports("yaml"), "YAML alias is not supported");

  const xbsl = await highlighter.highlight(
    [
      "метод ХостДоступен(Хост: Строка): Булево",
      '  пер Аргументы = <Объект>[]',
      '  Аргументы.Добавить("-c")',
      "  возврат Ложь",
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

  const yaml = await highlighter.highlight("name: demo\nenabled: true\nitems:\n  - one", "yaml");
  assert(yaml.includes("--shiki-light"), "YAML output has no light theme tokens");
  assert(yaml.includes("--shiki-dark"), "YAML output has no dark theme tokens");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

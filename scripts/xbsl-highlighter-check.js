#!/usr/bin/env node

const assert = require("assert");
const path = require("path");

global.window = {};
require(path.resolve(__dirname, "..", "media", "xbsl-highlighter.js"));

async function main() {
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

  const yaml = await highlighter.highlight("name: demo\nenabled: true\nitems:\n  - one", "yaml");
  assert(yaml.includes("--shiki-light"), "YAML output has no light theme tokens");
  assert(yaml.includes("--shiki-dark"), "YAML output has no dark theme tokens");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

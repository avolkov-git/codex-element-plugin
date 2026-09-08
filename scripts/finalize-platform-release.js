#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(__dirname, "..");
const outputRoot = path.resolve(args.output || path.resolve(sourceRoot, "..", "codex-plugin-release"));
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
const expectedNames = [
  `codex-plugins-${manifest.version}-win32-x64.zip`,
  `codex-plugins-${manifest.version}-linux-x64.tar.gz`
];

const artifacts = expectedNames.map((name) => {
  const artifactPath = path.join(outputRoot, name);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing release artifact: ${artifactPath}`);
  }
  const buffer = fs.readFileSync(artifactPath);
  return {
    name,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
});

fs.writeFileSync(
  path.join(outputRoot, "SHA256SUMS.txt"),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`,
  "utf8"
);
fs.writeFileSync(path.join(outputRoot, "README_RELEASE.md"), [
  `# Codex for 1C: Element ${manifest.version}`,
  "",
  "Платформенные архивы содержат Codex app-server и управляемый Playwright MCP browser runtime:",
  "",
  ...artifacts.map((artifact) => `- \`${artifact.name}\``),
  "",
  "Выбирайте архив по операционной системе сервера Element, а не компьютера с браузером.",
  "После распаковки скопируйте каталог `codex-plugins` в `/plugins` сервера Element.",
  "Проверяйте SHA-256 по `SHA256SUMS.txt`.",
  ...(manifest.version.includes("-") ? ["", "Это предварительная сборка для проверки. Сохраните предыдущий плагин и config root перед установкой.", "Приемочные сценарии, перенос истории и откат: `codex-plugins/docs/1.0.0-rc-testing.md`."] : []),
  ""
].join("\n"), "utf8");

console.log(`Release metadata finalized: ${outputRoot}`);

function parseArgs(rawArgs) {
  const result = { output: "" };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--output") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a path value.");
      }
      result.output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      result.output = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

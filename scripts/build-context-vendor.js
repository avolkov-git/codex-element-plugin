"use strict";

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const directory = path.join(root, "resources", "context");
const result = esbuild.buildSync({
  entryPoints: [require.resolve("yaml")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  legalComments: "inline",
  write: false
});
const outputs = new Map([
  ["yaml.cjs", result.outputFiles[0].text],
  ["yaml.LICENSE", fs.readFileSync(path.join(path.dirname(require.resolve("yaml/package.json")), "LICENSE"), "utf8")]
]);
for (const [name, text] of outputs) {
  const file = path.join(directory, name);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      throw new Error(`Stale context dependency: ${name}. Run npm run build:context.`);
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, text);
  }
}

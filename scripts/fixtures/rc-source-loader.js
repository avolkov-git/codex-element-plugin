"use strict";
// Existing regression scripts can run current sources without modifying dist:
// node -r ./scripts/fixtures/rc-source-loader.js scripts/app-server-protocol-check.js
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const dist = path.join(root, "dist") + path.sep;
const read = fs.readFileSync;
function sourceFor(filename) {
  if (typeof filename !== "string" || !filename.startsWith(dist) || !filename.endsWith(".js")) return undefined;
  const source = path.join(root, "src", filename.slice(dist.length).replace(/\.js$/, ".ts"));
  return fs.existsSync(source) ? source : undefined;
}
function compile(filename) {
  return ts.transpileModule(read(filename, "utf8"), { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
}
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  // Resolve explicit relative dist imports even when no compiled artifact exists.
  if (typeof request === "string" && (request.startsWith(".") || path.isAbsolute(request))) {
    const candidate = path.resolve(parent?.filename ? path.dirname(parent.filename) : root, request);
    const source = sourceFor(candidate.endsWith(".js") ? candidate : candidate + ".js");
    if (source) return source;
  }
  const result = resolve.call(this, request, parent, ...args);
  return sourceFor(result) || result;
};
Module._extensions[".ts"] = (mod, filename) => mod._compile(compile(filename), filename);
fs.readFileSync = function (filename, options) {
  const source = sourceFor(filename);
  if (!source) return read.call(this, filename, options);
  const output = compile(source);
  return typeof options === "string" || options?.encoding ? output : Buffer.from(output);
};

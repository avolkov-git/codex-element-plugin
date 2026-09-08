const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

function loadSource(relativePath, mocks = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(output, {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    require: (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith(".")) return loadSource(path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`)), mocks);
      return localRequire(name);
    },
    Buffer, URL, process, console, setTimeout, clearTimeout, Error, Date,
  }, { filename });
  return module.exports;
}

const logger = { info() {}, warn() {}, error() {} };
const vscode = {
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  Uri: { joinPath: (uri, relative) => ({ fsPath: path.join(uri.fsPath, relative) }) },
};

module.exports = { root, loadSource, logger, vscode };

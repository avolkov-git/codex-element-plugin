#!/usr/bin/env node

const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
async function buildHighlighter({ write = false, outfile = path.join(root, "media", "xbsl-highlighter.js") } = {}) {
  const shared = {
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome100"],
    supported: {
      "template-literal": false,
    },
    minify: true,
    sourcemap: false,
    treeShaking: true,
    write: false,
    metafile: true,
    logLevel: "silent",
  };
  const worker = await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, "webview", "highlight", "worker.ts")],
  });
  const workerSource = worker.outputFiles[0].text;
  for (const output of Object.values(worker.metafile.outputs)) {
    if (output.imports.length) throw new Error("Highlighter worker must be entirely self-contained");
  }
  const result = await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, "webview", "highlight", "index.ts")],
    globalName: "CodexXbslHighlighterBundle",
    define: { __XBSL_WORKER_SOURCE__: JSON.stringify(workerSource) },
    outfile,
    write,
  });
  return { ...result, workerSource };
}

module.exports = { buildHighlighter };

if (require.main === module) {
  buildHighlighter({ write: !process.argv.includes("--check") }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

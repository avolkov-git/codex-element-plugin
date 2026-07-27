#!/usr/bin/env node

const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

void esbuild
  .build({
    entryPoints: [path.join(root, "webview", "highlight", "index.ts")],
    bundle: true,
    format: "iife",
    globalName: "CodexXbslHighlighterBundle",
    outfile: checkOnly ? undefined : path.join(root, "media", "xbsl-highlighter.js"),
    platform: "browser",
    target: ["chrome100"],
    supported: {
      "template-literal": false,
    },
    minify: true,
    sourcemap: false,
    treeShaking: true,
    write: !checkOnly,
    logLevel: "info",
  })
  .catch(() => {
    process.exitCode = 1;
  });

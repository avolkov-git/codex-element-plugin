#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");
const { generateNotices } = require("./third-party-notices.js");
const root = path.resolve(__dirname, "..");
const options = {
  ...require("./build-chat-ui.js"),
  entryPoints: [path.join(root, "webview/browser-viewer/index.tsx")],
  outfile: path.join(root, "media/browser-viewer.js")
};
module.exports = options;
if (require.main === module) {
  esbuild.build({ ...options, write: !process.argv.includes("--check"), metafile: true }).then(result => {
    if (!process.argv.includes("--check")) fs.writeFileSync(path.join(root, "media/browser-viewer.NOTICES.txt"), generateNotices(root, result.metafile));
    console.log("Browser viewer: local IIFE, no runtime imports");
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

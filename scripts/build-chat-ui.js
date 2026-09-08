#!/usr/bin/env node
const path = require("node:path");
const esbuild = require("esbuild");
const fs = require("node:fs");
const { generateNotices } = require("./third-party-notices.js");
const root = path.resolve(__dirname, "..");
const options = {
  entryPoints: [path.join(root, "webview/chat/index.tsx")],
  outfile: path.join(root, "media/chat.js"), bundle: true, format: "iife",
  platform: "browser", target: ["chrome100"], minify: true, sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  supported: { "template-literal": false }, legalComments: "none", charset: "ascii"
};
module.exports = options;
if (require.main === module) {
  esbuild.build({ ...options, write: !process.argv.includes("--check"), metafile: true }).then(result => {
    const notices = generateNotices(root, result.metafile);
    if (!process.argv.includes("--check")) fs.writeFileSync(path.join(root, "media/chat.NOTICES.txt"), notices);
    const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
    console.log(`Chat UI: ${Math.round(bytes / 1024)} KiB, local IIFE, no runtime imports`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

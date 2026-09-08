"use strict";
const fs = require("node:fs");
const path = require("node:path");

function generateNotices(root, metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = path.resolve(root, input);
    const parts = absolute.split(path.sep);
    const index = parts.lastIndexOf("node_modules");
    if (index < 0) continue;
    const count = parts[index + 1].startsWith("@") ? index + 3 : index + 2;
    const directory = parts.slice(0, count).join(path.sep);
    if (packages.has(directory)) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const licenseFiles = fs.readdirSync(directory)
      .filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile())
      .sort();
    if (!licenseFiles.length) throw new Error(`No license text found for bundled dependency ${manifest.name}`);
    packages.set(directory, { name: manifest.name, version: manifest.version, license: manifest.license, files: licenseFiles.map((name) => ({ name, text: fs.readFileSync(path.join(directory, name), "utf8").trim() })) });
  }
  const sections = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name, "en")).map((entry) => [
    `${entry.name}@${entry.version} (${entry.license || "see license text"})`,
    "=".repeat(72),
    ...entry.files.map((file) => `${file.name}\n\n${file.text}`)
  ].join("\n\n"));
  return `Third-party licenses for the locally bundled chat webview.\nGenerated from the exact esbuild dependency graph.\n\n${sections.join("\n\n\n")}\n`;
}

module.exports = { generateNotices };

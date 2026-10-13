#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const directory = path.resolve(__dirname, "../resources/context/ast");
const source = path.join(directory, "NativeXbslAst.java");
const output = path.join(directory, "native-xbsl-ast.jar");
const manifestPath = path.join(directory, "build.json");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function current() {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.protocolVersion === 1 && manifest.javaRelease === 11
      && manifest.sourceSha256 === hash(source) && manifest.jarSha256 === hash(output);
  } catch { return false; }
}

function tool(name) {
  const executable = name + (process.platform === "win32" ? ".exe" : "");
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, "bin", executable);
  return executable;
}

if (process.argv.includes("--check")) {
  if (!current()) {
    console.error("Native AST helper is missing or stale. Run: node scripts/build-native-ast.js (JDK 11+).");
    process.exitCode = 1;
  } else console.log("Native AST helper: source and Java 11 artifact hashes match.");
} else if (!process.argv.includes("--rebuild") && current()) {
  console.log("Native AST helper is current.");
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-ast-build-"));
  try {
    const classes = path.join(temporary, "classes");
    fs.mkdirSync(classes);
    execFileSync(tool("javac"), ["--release", "11", "-encoding", "UTF-8", "-d", classes, source], { stdio: "inherit" });
    const jar = path.join(temporary, "native-xbsl-ast.jar");
    execFileSync(tool("jar"), ["--create", "--file", jar, "--main-class", "NativeXbslAst", "-C", classes, "."], { stdio: "inherit" });
    fs.copyFileSync(jar, output);
    fs.writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 1, javaRelease: 11, sourceSha256: hash(source), jarSha256: hash(output) }, null, 2) + "\n");
    console.log("Built native AST helper (Java 11 bytecode, no Element code bundled).");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

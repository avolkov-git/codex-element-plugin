"use strict";
const { spawn } = require("node:child_process");
const mode = process.argv[2];
if (mode !== "graceful-root") process.on("SIGTERM", () => {});
if (mode === "tree" || mode === "graceful-root") {
  spawn(process.execPath, [__filename, "leaf"], { stdio: ["ignore", "inherit", "inherit"] });
}
process.stdout.write(JSON.stringify({ ready: mode, pid: process.pid }) + "\n");
if (mode === "oversized") setTimeout(() => process.stdout.write("x".repeat(2048)), 25);
if (mode === "natural-root") {
  const child = spawn(process.execPath, [__filename, "leaf"], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", (data) => {
    process.stdout.write(data);
    process.exit(0);
  });
}
setInterval(() => {}, 1000);

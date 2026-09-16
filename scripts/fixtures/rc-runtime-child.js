"use strict";
const { spawn } = require("node:child_process");
const mode = process.argv[2];
if (mode !== "graceful-root") process.on("SIGTERM", () => {});
if (mode === "tree" || mode === "graceful-root") {
  spawn(process.execPath, [__filename, "leaf"], { stdio: ["ignore", "inherit", "inherit"] });
}
process.stdout.write(JSON.stringify({ ready: mode, pid: process.pid }) + "\n");
if (mode === "oversized") setTimeout(() => process.stdout.write("x".repeat(2048)), 25);
if (mode === "thread-history") {
  const { createInterface } = require("node:readline");
  const history = [{ id: "old-turn", items: [{ type: "agentMessage", id: "old-message", text: "x".repeat(9 * 1024 * 1024) }] }];
  const threads = new Map([["thread-a", history]]);
  const requests = [];
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    const respond = (result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
    requests.push({ method, params });
    if (method === "thread/resume" || method === "thread/fork") {
      if (params.model === "reject-overrides") {
        process.stdout.write(JSON.stringify({ id, error: { code: -32600, message: "invalid request: model override" } }) + "\n");
        return;
      }
      const threadId = method === "thread/fork" ? "thread-fork" : params.threadId;
      threads.set(threadId, threads.get(params.threadId));
      respond({ thread: { id: threadId, turns: params.excludeTurns ? [] : threads.get(threadId) } });
    } else if (method === "turn/start") {
      respond({ turn: { id: "continued-turn" } });
    } else if (method === "fixture/stats") {
      respond({ requests, historyBytes: JSON.stringify(threads.get(params.threadId)).length });
    } else {
      process.stdout.write(JSON.stringify({ id, error: { code: -32601, message: "unsupported fixture request" } }) + "\n");
    }
  });
}
if (mode === "natural-root") {
  const child = spawn(process.execPath, [__filename, "leaf"], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.on("data", (data) => {
    process.stdout.write(data);
    process.exit(0);
  });
}
setInterval(() => {}, 1000);

"use strict";
// Explicit live migration test. Both runtimes share only a disposable test profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { JsonRpcClient } = require("../dist/jsonRpcClient");

function session(binary, home) {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  const child = spawn(binary, ["app-server"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stderr.resume();
  let completeTurn;
  let answer = "";
  const rpc = new JsonRpcClient((line) => child.stdin.write(`${line}\n`), (notification) => {
    if (notification.method === "item/completed" && notification.params.item?.type === "agentMessage") answer += notification.params.item.text;
    if (notification.method === "turn/completed") completeTurn?.(notification.params.turn);
  }, () => { throw new Error("Tool calls are not allowed in upgrade smoke"); });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => rpc.handleLine(line));
  child.on("error", () => rpc.dispose());
  child.on("exit", () => rpc.dispose());
  return {
    async initialize(version) {
      const result = await rpc.request("initialize", { clientInfo: { name: "codex_element_upgrade_smoke", version: "0.1.89" }, capabilities: { experimentalApi: true } }, 30000);
      assert.ok(result.userAgent.includes(version), `expected runtime ${version}`);
      rpc.notify("initialized");
      const account = await rpc.request("account/read", { refreshToken: false });
      assert.ok(account.account, "Authenticated auth.json is required for upgrade smoke");
    },
    request: (method, params) => rpc.request(method, params, 30000),
    async turn(threadId, model, text) {
      answer = "";
      let timer;
      const done = new Promise((resolve) => { completeTurn = resolve; });
      try {
        await rpc.request("turn/start", { threadId, model, effort: "low", input: [{ type: "text", text, text_elements: [] }], sandboxPolicy: { type: "readOnly" }, approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null }, 30000);
        const result = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("turn/completed timeout")), 90000); })]);
        assert.equal(result.status, "completed", JSON.stringify(result.error));
        return answer;
      } finally { clearTimeout(timer); completeTurn = undefined; }
    },
    async close() {
      rpc.dispose();
      reader.close();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill();
      await closed;
      clearTimeout(timer);
    }
  };
}

async function main() {
  const [oldBinary, newBinary, authHome] = process.argv.slice(2);
  assert.ok(oldBinary && newBinary && authHome, "Usage: node scripts/app-server-upgrade-smoke.js OLD_BINARY NEW_BINARY AUTH_HOME");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-element-upgrade-smoke-"));
  let active;
  try {
    fs.chmodSync(home, 0o700);
    fs.copyFileSync(path.join(path.resolve(authHome), "auth.json"), path.join(home, "auth.json"));
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
    active = session(path.resolve(oldBinary), home);
    await active.initialize("0.144.5");
    const created = await active.request("thread/start", { cwd: home, model: null, sandbox: "read-only", approvalPolicy: "on-request" });
    const marker = "UPGRADE-CHECK-5827";
    const oldAnswer = await active.turn(created.thread.id, null, `Remember this marker for my next question: ${marker}. Reply exactly LEGACY-OK. Do not use tools.`);
    assert.match(oldAnswer, /LEGACY-OK/);
    await active.close();
    active = undefined;
    console.log("PASS 0.144.5 created a persisted conversation");

    active = session(path.resolve(newBinary), home);
    await active.initialize("0.153.4");
    const resumed = await active.request("thread/resume", { threadId: created.thread.id, cwd: home, model: "gpt-6-astra", sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null });
    assert.equal(resumed.thread.id, created.thread.id);
    assert.ok(resumed.thread.turns.some((turn) => turn.items.some((item) => item.type === "agentMessage" && item.text.includes("LEGACY-OK"))), "previous answer must survive runtime upgrade");
    const newAnswer = await active.turn(created.thread.id, "gpt-6-astra", "Reply with only the marker from my previous message. Do not use tools.");
    assert.ok(newAnswer.includes(marker), "Astra must receive the conversation context from 0.144.5");
    console.log("PASS 0.153.4 resumed the same thread; Astra recalled the previous context");
  } finally {
    try { await active?.close(); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

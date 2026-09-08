"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const Ajv = require("ajv");
const { JsonRpcClient } = require("../dist/jsonRpcClient");
const runtime = path.resolve(process.argv[2]);
const live = process.argv.includes("--live");
const authHomeIndex = process.argv.indexOf("--auth-home");
const contract = require("./fixtures/app-server/0.153.4.json");
const validators = new Map();
function validate(group, name, value) {
  const key = `${group}:${name}`;
  if (!validators.has(key)) validators.set(key, new Ajv({ strict: false, validateFormats: false }).compile({ ...contract[group][name], definitions: contract.definitions }));
  const fn = validators.get(key);
  assert.ok(fn(value), `${key}: ${JSON.stringify(fn.errors)}`);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-element-runtime-smoke-"));
  let child;
  let processClosed;
  let rpc;
  let reader;
  let completionTimer;
  let cleanupTimer;
  const notificationErrors = [];
  try {
    fs.chmodSync(temp, 0o700);
    if (authHomeIndex !== -1) {
      const authPath = path.join(path.resolve(process.argv[authHomeIndex + 1]), "auth.json");
      fs.copyFileSync(authPath, path.join(temp, "auth.json"));
      fs.chmodSync(path.join(temp, "auth.json"), 0o600);
    }
    const env = { ...process.env, CODEX_HOME: temp };
    delete env.OPENAI_API_KEY;
    child = spawn(runtime, ["app-server"], { cwd: temp, env, stdio: ["pipe", "pipe", "pipe"] });
    processClosed = new Promise((resolve) => child.once("close", resolve));
    child.stderr.resume();
    let completed;
    let finalText = "";
    let deltaCount = 0;
    const done = new Promise((resolve) => { completed = resolve; });
    rpc = new JsonRpcClient((line) => child.stdin.write(`${line}\n`), (notification) => {
      try {
        if (contract.notifications[notification.method]) validate("notifications", notification.method, notification);
        if (notification.method === "item/agentMessage/delta") deltaCount++;
        if (notification.method === "item/completed" && notification.params.item?.type === "agentMessage") finalText += notification.params.item.text;
        if (notification.method === "turn/completed") completed(notification.params.turn);
      } catch (error) { notificationErrors.push(error.message); }
    }, () => { throw new Error("No tool approvals allowed in smoke test"); });
    reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => rpc.handleLine(line));
    child.on("error", () => rpc.dispose());
    child.on("exit", () => rpc.dispose());
    async function request(method, params, responseName) {
      validate("requests", method, { id: 1, method, ...(params === undefined ? {} : { params }) });
      const result = await rpc.request(method, params, 30000);
      if (responseName) validate("responses", responseName, result);
      console.log(`PASS ${method}`);
      return result;
    }
    const initialized = await request("initialize", { clientInfo: { name: "codex_element_smoke", version: "0.1.89" }, capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false, optOutNotificationMethods: null } }, "InitializeResponse");
    assert.ok(initialized.userAgent.includes("0.153.4"));
    rpc.notify("initialized");
    const models = [];
    let cursor = null;
    do {
      const result = await request("model/list", { cursor, limit: 2, includeHidden: false }, "ModelListResponse");
      models.push(...result.data);
      cursor = result.nextCursor;
      assert.ok(models.length < 200, "unexpected model pagination loop");
    } while (cursor);
    const astra = models.find((item) => item.model === "gpt-6-astra");
    assert.ok(astra && !astra.hidden, "Astra missing from model/list");
    console.log(`Astra visible; default=${astra.isDefault}; efforts=${astra.supportedReasoningEfforts.map((entry) => entry.reasoningEffort).join(",")}`);
    const account = await request("account/read", { refreshToken: false }, "GetAccountResponse");
    console.log(`Account type: ${account.account?.type || "none"}`);
    if (account.account?.type === "chatgpt") await request("account/rateLimits/read", undefined, "GetAccountRateLimitsResponse");
    await request("skills/list", { cwds: [temp], forceReload: true }, "SkillsListResponse");
    await request("mcpServerStatus/list", { cursor: null, limit: 100 }, "ListMcpServerStatusResponse");
    await request("config/mcpServer/reload", null);
    const thread = await request("thread/start", { cwd: temp, model: astra.model, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null, serviceName: "codex_element_smoke", sessionStartSource: "startup" }, "ThreadStartResponse");
    if (live) {
      assert.ok(account.account, "Live test needs --auth-home with an authenticated profile");
      await request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Reply with exactly OK. Do not use tools.", text_elements: [] }], cwd: temp, model: astra.model, effort: "low", serviceTier: null, approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } }, "TurnStartResponse");
      const turn = await Promise.race([done, new Promise((_, reject) => { completionTimer = setTimeout(() => reject(new Error("turn/completed timeout")), 90000); })]);
      assert.equal(turn.status, "completed", JSON.stringify(turn.error));
      assert.match(finalText, /\bOK\b/);
      console.log(`PASS Astra live turn: completed, ${deltaCount} streaming deltas, answer OK`);
      // Empty threads have no persisted rollout until their first turn.
      await request("thread/resume", { threadId: thread.thread.id, cwd: temp, model: astra.model, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", serviceTier: null }, "ThreadResumeResponse");
    } else {
      console.log("SKIP live generation (use --live --auth-home for a small authenticated Astra request)");
      await request("account/logout", undefined, "LogoutAccountResponse");
    }
    assert.deepEqual(notificationErrors, []);
    console.log("Runtime smoke test passed.");
  } finally {
    clearTimeout(completionTimer);
    rpc?.dispose();
    reader?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      cleanupTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }
    await processClosed;
    clearTimeout(cleanupTimer);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { JsonRpcClient } = require("../dist/jsonRpcClient");
const { version: runtimeVersion } = require("../bin/runtime-manifest.json");

// A real app-server and Code Mode process talk to local MCP/Responses fixtures.
// No account, external model request, or user MCP configuration is used.
async function main() {
  assert(process.argv[2], "Usage: node scripts/code-mode-mcp-smoke.cjs <native-codex> [--expect-missing-host]");
  const sourceRuntime = path.resolve(process.argv[2]);
  const missingHost = process.argv.includes("--expect-missing-host");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-code-mode-smoke-"));
  const home = path.join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  let child, reader, rpc, closed, deadline, killTimer;
  let responseCount = 0, mcpCalls = 0, toolOutput = "", stderr = "";
  const requestErrors = [];
  const marker = "CODE_MODE_MCP_OK";
  const json = (res, value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      const body = JSON.parse(bytes.toString());
      if (req.url === "/mcp") {
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        let result;
        switch (body.method) {
          case "initialize": result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
          case "tools/list": result = { tools: [{ name: "ping", description: "Return a local test marker.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] }; break;
          case "tools/call": assert.equal(body.params.name, "ping"); mcpCalls++; result = { content: [{ type: "text", text: marker }] }; break;
          case "resources/list": result = { resources: [] }; break;
          case "resources/templates/list": result = { resourceTemplates: [] }; break;
          case "prompts/list": result = { prompts: [] }; break;
          default: throw new Error(`Unexpected MCP method: ${body.method}`);
        }
        json(res, { jsonrpc: "2.0", id: body.id, result }); return;
      }
      assert.equal(req.url, "/v1/responses");
      const id = `resp-${++responseCount}`;
      assert(responseCount <= 2, "Unexpected extra model request");
      const output = responseCount === 1
        ? { type: "custom_tool_call", call_id: "fixture-call", name: "exec", input: "text(await tools.mcp__fixture__ping({}));" }
        : { type: "message", role: "assistant", id: "done", content: [{ type: "output_text", text: "Done" }] };
      if (responseCount === 2) toolOutput = JSON.stringify(body.input);
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item: output },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      requestErrors.push(error.message); res.writeHead(500); res.end("Fixture failed");
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(home, "config.toml"), [
      'model = "mock-model"', 'model_provider = "mock_provider"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[features]', 'code_mode_only = true',
      '[model_providers.mock_provider]', 'name = "Local smoke fixture"', `base_url = "${url}/v1"`,
      'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', 'requires_openai_auth = false', 'supports_websockets = false',
      '[mcp_servers.fixture]', `url = "${url}/mcp"`, 'startup_timeout_sec = 10', 'tool_timeout_sec = 10',
    ].join("\n"), { mode: 0o600 });
    let runtime = sourceRuntime;
    if (missingHost) {
      runtime = path.join(root, path.basename(sourceRuntime));
      fs.copyFileSync(sourceRuntime, runtime, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(runtime, 0o755);
    }
    const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home };
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    child = spawn(runtime, ["app-server"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    closed = new Promise((resolve) => child.once("close", resolve));
    const notifications = [];
    rpc = new JsonRpcClient((line) => child.stdin.write(`${line}\n`), (notification) => notifications.push(notification), (request) => {
      throw new Error(`Unexpected server request: ${request.method}`);
    });
    child.on("error", () => rpc.dispose()); child.on("exit", () => rpc.dispose());
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    reader = createInterface({ input: child.stdout }); reader.on("line", (line) => rpc.handleLine(line));
    const run = async () => {
      const initialized = await rpc.request("initialize", { clientInfo: { name: "codex_element_code_mode_smoke", version: "1" }, capabilities: { experimentalApi: true } });
      assert(initialized.userAgent.includes(runtimeVersion)); rpc.notify("initialized");
      const thread = await rpc.request("thread/start", { cwd: root, model: "mock-model", approvalPolicy: "never", sandbox: "read-only" });
      const status = await rpc.request("mcpServerStatus/list", { cursor: null, limit: 100 });
      assert(status.data.some((entry) => entry.name === "fixture" && Object.keys(entry.tools).length === 1), "MCP fixture did not register");
      await rpc.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Run the local MCP fixture.", text_elements: [] }] });
      while (!notifications.some((n) => n.method === "turn/completed")) {
        assert(child.exitCode === null && child.signalCode === null, "App-server exited before completion");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(requestErrors, []);
      assert.equal(responseCount, 2, "Code Mode did not produce a tool result");
      if (missingHost) {
        assert.equal(mcpCalls, 0); assert.match(toolOutput, /code-mode.host.*(?:not found|No such file|cannot find)/i);
        console.log("PASS negative control: missing host blocks the call before MCP");
      } else {
        assert.equal(mcpCalls, 1, `MCP not invoked; tool output: ${toolOutput}`); assert(toolOutput.includes(marker));
        console.log("PASS app-server -> Code Mode host -> MCP tools/call -> model tool result (local fixtures, no account)");
      }
    };
    await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Code Mode MCP smoke timed out")), 45000); })]);
  } catch (error) {
    if (stderr) console.error(stderr); throw error;
  } finally {
    clearTimeout(deadline); rpc?.dispose(); reader?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end(); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }
    await closed; clearTimeout(killTimer);
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { BrowserRuntimeService } = require("../dist/browserRuntimeService");
const { RuntimeProcessManager } = require("../dist/runtimeProcessManager");
const { JsonRpcClient } = require("../dist/jsonRpcClient");

async function main() {
  const [input, ...flags] = process.argv.slice(2);
  assert(input, "Usage: node scripts/browser-runtime-smoke.cjs <runtime-root> [--development-node=<native-node> --development-browser=<native-browser>]");
  const runtimeRoot = path.resolve(input);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8"));
  const node = flags.find(flag => flag.startsWith("--development-node="))?.split("=").slice(1).join("=");
  const browser = flags.find(flag => flag.startsWith("--development-browser="))?.split("=").slice(1).join("=");
  assert(flags.every(flag => flag.startsWith("--development-node=") || flag.startsWith("--development-browser=")), "Unknown smoke test argument");
  assert(Boolean(node) === Boolean(browser), "Development overrides must specify both native executables");
  if (!node) assert.equal(manifest.platformId, `${process.platform}-${process.arch}`, "Never execute a foreign-platform payload");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-mcp-smoke-"));
  const manager = new RuntimeProcessManager();
  let stderr = "";
  const rpc = new JsonRpcClient(line => manager.writeLine(JSON.stringify({ jsonrpc: "2.0", ...JSON.parse(line) })), () => {},
    request => { throw new Error(`Unexpected MCP server request: ${request.method}`); });
  const server = http.createServer((request, response) => {
    if (request.url !== "/applications/demo/pages/nested") { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Browser MCP fixture</title><button>Increment</button><output>Count: 0</output><script src="http://127.0.0.1:${external.address().port}/asset.js"></script>`);
  });
  const external = http.createServer((request, response) => {
    if (request.url === "/asset.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end('document.querySelector("button").onclick = () => document.querySelector("output").textContent = "Count: 1";');
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Other origin</title><p>Other origin accessible</p>");
    }
  });
  try {
    external.listen(0, "127.0.0.1");
    await once(external, "listening");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/applications/demo/pages/nested`;
    const application = { getView: () => ({ status: "ready", url, name: "Smoke", message: "" }), resolve: async () => application.getView() };
    const persistent = path.join(temp, "user", "project");
    const service = new BrowserRuntimeService({ extensionUri: { fsPath: path.resolve(runtimeRoot, "../..") } },
      { getConfigRoot: () => temp }, { info: console.log, warn: console.warn },
      () => path.join(persistent, "sessions", "smoke"), () => persistent, application);
    if (node) {
      // Local development exercises the shipped JS with explicitly supplied
      // native executables. Release CI never supplies these overrides.
      assert(path.isAbsolute(node) && path.isAbsolute(browser));
      service.resolveRuntime = () => ({ root: runtimeRoot, manifest: { ...manifest, platformId: `${process.platform}-${process.arch}` },
        nodePath: node, launcherPath: path.join(runtimeRoot, manifest.launcherPath), browserExecutablePath: browser });
      console.log("Development smoke: native executables; this does not validate the foreign OS binaries.");
    }
    service.saveSettings({ enabled: true, disableSandbox: false });
    const checked = await service.test();
    assert.equal(checked.status, "ready", `${checked.message} ${checked.details}`);
    console.log(checked.details);
    const entry = service.prepareMcpServer();
    assert.equal(JSON.parse(fs.readFileSync(entry.args[2], "utf8")).network, undefined);
    manager.start({ command: entry.command, args: entry.args, cwd: temp, env: process.env,
      onStdout: line => { rpc.handleLine(line); },
      onStderr: line => { stderr = `${stderr}${line}\n`.slice(-16000); },
      onError: error => { stderr += String(error); rpc.dispose(); }, onExit: () => rpc.dispose() });
    await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-browser-smoke", version: "1" } });
    rpc.notify("notifications/initialized");
    const listed = await rpc.request("tools/list", {});
    for (const name of ["browser_navigate", "browser_click", "browser_snapshot", "browser_close"]) {
      assert(listed.tools.some(tool => tool.name === name), `Missing MCP tool ${name}`);
    }
    const call = async (name, args) => {
      const result = await rpc.request("tools/call", { name, arguments: args }, 35_000);
      assert(!result.isError, JSON.stringify(result));
      return (result.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
    };
    await call("browser_navigate", { url });
    const navigation = await call("browser_snapshot", {});
    const ref = navigation.match(/button "Increment" \[ref=([^\]]+)\]/)?.[1];
    assert(ref, `Button not found in MCP snapshot: ${navigation}`);
    assert(listed.tools.find(tool => tool.name === "browser_click").inputSchema.properties.target, "Expected the bundled browser_click target schema");
    await call("browser_click", { target: ref, element: "Increment button" });
    const snapshot = await call("browser_snapshot", {});
    assert.match(snapshot, /Count: 1/);
    await call("browser_navigate", { url: `http://127.0.0.1:${external.address().port}/another/application` });
    assert.match(await call("browser_snapshot", {}), /Other origin accessible/);
    await call("browser_close", {});
    console.log("PASS: settings probe, real MCP, nested application page, cross-origin script and navigation, click, snapshot, close.");
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    rpc.dispose();
    try { await manager.stop(2000); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      external.closeAllConnections();
      await new Promise(resolve => external.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

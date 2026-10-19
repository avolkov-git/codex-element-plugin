const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const { verifyLinuxBrowserDependencies } = require("./linux-browser-dependencies");

async function main() {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  assert.notEqual(process.getuid(), 0, "Run the clean check as an unprivileged user");
  assert.match(fs.readFileSync("/etc/os-release", "utf8"), /VERSION_ID="24\.04"/);
  const root = path.resolve(process.argv[2]);
  const browserRoot = path.join(root, "browser/linux-x64");
  const manifest = JSON.parse(fs.readFileSync(path.join(browserRoot, "runtime.json"), "utf8"));
  assert(manifest.linuxDependenciesPath, "A legacy runtime cannot pass the portable check");
  verifyLinuxBrowserDependencies(browserRoot, manifest);
  const dependencies = JSON.parse(fs.readFileSync(path.join(browserRoot, manifest.linuxDependenciesPath), "utf8"));
  const raw = spawnSync("ldd", [path.join(browserRoot, dependencies.browserBinaryPath)], { encoding: "utf8" });
  assert.match(raw.stdout, /libgbm\.so\.1 => not found/, "Use clean Ubuntu, without installing Chromium dependencies");
  const osPackages = fs.readFileSync("/var/lib/dpkg/status", "utf8");
  const libraryPath = process.env.LD_LIBRARY_PATH;
  const { BrowserRuntimeService } = require(path.join(root, "dist/browserRuntimeService"));
  const { BrowserViewerService } = require(path.join(root, "dist/browserViewerService"));
  const { RuntimeProcessManager } = require(path.join(root, "dist/runtimeProcessManager"));
  const { JsonRpcClient } = require(path.join(root, "dist/jsonRpcClient"));
  const { jpegjs } = require(path.join(browserRoot, "node_modules/playwright-core/lib/utilsBundle.js"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-portable-check-"));
  const scope = path.join(temp, "user/project/sessions/check");
  const viewer = new BrowserViewerService(() => scope);
  const manager = new RuntimeProcessManager();
  let stderr = "", frameError, frames = 0, screenshot;
  const pointers = [], inputs = [];
  viewer.onPointer(pointer => pointers.push(pointer));
  viewer.onInputResult(result => inputs.push(result));
  viewer.onFrame(frame => {
    try {
      const bytes = Buffer.from(frame.data, "base64");
      const image = jpegjs.decode(bytes, { useTArray: true });
      assert.equal(image.width, 1440); assert.equal(image.height, 900);
      // The bottom right is the fixture's colored background, not a blank frame.
      const pixel = (image.width * (image.height - 5) + image.width - 5) * 4;
      assert(Math.abs(image.data[pixel + 1] - 150) < 15);
      screenshot = bytes; frames++;
    } catch (error) { frameError = error; }
    viewer.acknowledge(frame.sessionId, frame.pageId, frame.sequence);
  });
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (frameError) throw frameError;
      assert(Date.now() < deadline, `Timeout: ${label}; ${JSON.stringify(viewer.getState())}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const rpc = new JsonRpcClient(line => manager.writeLine(JSON.stringify({ jsonrpc: "2.0", ...JSON.parse(line) })), () => {}, () => {});
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Portable browser</title>
      <style>body{background:rgb(30,150,90);font:24px 'Liberation Sans'}button,input{position:absolute;font:inherit;left:20px;height:50px}button{top:20px;width:200px}input{top:100px;width:400px}p{margin-top:200px}</style>
      <button onclick="this.textContent='Нажато'">Проверить</button><input aria-label="Текст"><p>Русский текст: Привет, мир! Ёж</p>`);
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/applications/check`;
    const application = { getView: () => ({ status: "ready", url, name: "Check", message: "" }) };
    const runtime = new BrowserRuntimeService({ extensionUri: { fsPath: root } }, { getConfigRoot: () => temp },
      { info: console.log, warn: console.warn }, () => scope, () => path.join(temp, "user/project"), application, viewer);
    runtime.saveSettings({ enabled: true, disableSandbox: false });
    const probe = await runtime.test(); assert.equal(probe.status, "ready", JSON.stringify(probe));
    const launch = runtime.prepareRuntimeLaunch(); assert(!launch.disabledReason, launch.disabledReason);
    const entry = runtime.getManagedServer(); assert(entry);
    viewer.setVisible(true);
    manager.start({ command: entry.command, args: entry.args, cwd: temp, env: process.env,
      onStdout: line => rpc.handleLine(line), onStderr: line => { stderr = (stderr + line + "\n").slice(-16000); },
      onError: error => { stderr += String(error); rpc.dispose(); }, onExit: () => rpc.dispose() });
    await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "portable-check", version: "1" } });
    rpc.notify("notifications/initialized");
    const call = async (name, args) => {
      const result = await rpc.request("tools/call", { name, arguments: args }, 35000);
      assert(!result.isError, JSON.stringify(result));
      return (result.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
    };
    await call("browser_navigate", { url });
    await wait(() => frames > 0, "CDP frame");
    const snapshot = await call("browser_snapshot", {});
    const target = snapshot.match(/button "Проверить" \[ref=([^\]]+)\]/)?.[1]; assert(target, snapshot);
    await call("browser_click", { target, element: "Проверить" });
    assert.match(await call("browser_snapshot", {}), /Нажато/);
    await wait(() => pointers.some(pointer => pointer.kind === "click" || pointer.kind === "focus"), "agent pointer");
    let state = viewer.getState(); viewer.setControl(state.sessionId, state.selectedPageId, true);
    state = viewer.getState(); assert(state.controlId, "Manual control lease missing");
    let id = 0;
    const input = async action => {
      viewer.sendInput(state.sessionId, state.selectedPageId, state.controlId, ++id, action);
      await wait(() => inputs.some(result => result.inputId === id), "manual input result");
      assert(inputs.find(result => result.inputId === id).ok);
    };
    await input({ kind: "click", x: 200 / 1440, y: 125 / 900, button: "left", clickCount: 1, modifiers: 0 });
    await input({ kind: "text", text: "Ручной ввод: Ёж 42" });
    assert.match(await call("browser_snapshot", {}), /Ручной ввод: Ёж 42/);
    viewer.setControl(state.sessionId, state.selectedPageId, false);
    await call("browser_tabs", { action: "new" });
    await call("browser_navigate", { url });
    await wait(() => viewer.getState().pages.length === 2, "second tab");
    state = viewer.getState(); viewer.closePages(state.sessionId, state.selectedPageId, "others");
    await wait(() => viewer.getState().pages.length === 1, "close other tabs");
    state = viewer.getState(); viewer.closePages(state.sessionId, state.selectedPageId, "selected");
    await wait(() => viewer.getState().pages.length === 0, "close last tab");
    const before = frames;
    await call("browser_navigate", { url });
    await wait(() => viewer.getState().pages.length === 1 && frames > before, "reopen browser tab");
    if (process.env.CODEX_TEST_ARTIFACTS) {
      fs.mkdirSync(process.env.CODEX_TEST_ARTIFACTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.CODEX_TEST_ARTIFACTS, "portable-browser.jpg"), screenshot);
    }
    await call("browser_close", {});
    assert.equal(process.env.LD_LIBRARY_PATH, libraryPath, "Private libraries leaked into the host environment");
    assert.equal(fs.readFileSync("/var/lib/dpkg/status", "utf8"), osPackages, "The test installed OS packages");
    if (frameError) throw frameError;
    console.log(`PASS: clean Ubuntu 24.04, ${frames} CDP frames, production runtime/MCP, agent pointer, manual Cyrillic input, close/reopen tabs. No OS packages installed.`);
  } catch (error) { console.error(stderr); throw error; }
  finally {
    rpc.dispose(); viewer.stop(); await manager.stop(2000);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const { loadSource, root } = require("../tests/service-test-utils.cjs");

const usage = "node scripts/browser-viewer-smoke.cjs <runtime-root> [--development-node=<native-node> --development-browser=<native-browser>]";
const colors = [[36, 158, 90], [38, 100, 210], [208, 64, 72], [180, 132, 32]];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runtimeOptions() {
  const [input, ...flags] = process.argv.slice(2);
  assert(input && !input.startsWith("--"), `Usage: ${usage}`);
  assert(flags.every(flag => /^--development-(node|browser)=.+/.test(flag)), `Usage: ${usage}`);
  assert.equal(new Set(flags.map(flag => flag.split("=")[0])).size, flags.length, "Duplicate argument");
  const option = name => flags.find(flag => flag.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runtimeRoot = path.resolve(input);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8"));
  const node = option("development-node");
  const browser = option("development-browser");
  assert(Boolean(node) === Boolean(browser), "Development overrides must specify both native executables");
  if (!node) assert.equal(manifest.platformId, `${process.platform}-${process.arch}`, "Never execute a foreign-platform payload; provide both native development overrides");
  const nodePath = node || path.join(runtimeRoot, manifest.nodePath);
  const browserPath = browser || path.join(runtimeRoot, manifest.browserExecutablePath);
  for (const executable of [nodePath, browserPath]) {
    assert(path.isAbsolute(executable), "Executables must be absolute paths");
    fs.accessSync(executable, fs.constants.X_OK);
    if (process.platform !== "win32") {
      const descriptor = fs.openSync(executable, "r");
      const magic = Buffer.alloc(4);
      try { fs.readSync(descriptor, magic, 0, magic.length, 0); }
      finally { fs.closeSync(descriptor); }
      assert(!/\.exe$/i.test(executable) && magic.toString("ascii", 0, 2) !== "MZ", "Refusing to run a Windows executable on this host");
      if (process.platform === "darwin") {
        assert(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic.toString("hex")), `Not a native macOS executable: ${executable}`);
      }
    }
  }
  const actual = JSON.parse(execFileSync(nodePath, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})"], { encoding: "utf8", timeout: 5000 }));
  assert.equal(actual.platform, process.platform);
  const mcpVersion = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "node_modules/@playwright/mcp/package.json"), "utf8")).version;
  const launcher = path.join(runtimeRoot, manifest.launcherPath);
  assert(fs.statSync(launcher).isFile(), "MCP launcher missing");
  console.log(`Runtime: ${actual.platform}-${actual.arch}, Node ${actual.version}, @playwright/mcp ${mcpVersion}`);
  if (node) console.log(`Development smoke: cached ${manifest.platformId} JavaScript with native executables; foreign OS binaries are not validated.`);
  console.log(`Node: ${nodePath}\nBrowser: ${browserPath}\nMCP: ${launcher}`);
  return { runtimeRoot, manifest, nodePath, browserPath, launcher };
}

function compileHook(directory) {
  // Compile only the production helper into the disposable fixture extension.
  // Never rebuild or overwrite the shared repository's dist directory.
  const out = path.join(directory, "dist");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const name of ["browserViewerProtocol", "browserViewerHook"]) {
    const filename = path.join(root, "src", `${name}.ts`);
    const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
      reportDiagnostics: true,
    });
    assert(!result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), `Cannot transpile ${filename}`);
    fs.writeFileSync(path.join(out, `${name}.js`), result.outputText, { mode: 0o600 });
  }
  return path.join(out, "browserViewerHook.js");
}

function fixtureHtml(isNewTab = false) {
  const palette = isNewTab ? [colors[3], colors[1], colors[2], colors[0]] : colors;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Viewer smoke</title>
<style>html{background:rgb(${palette[0]})}body{margin:0;min-height:2400px;font:24px sans-serif}
header{position:fixed;top:20px;left:20px}button,input{font:inherit}output{display:block}
#pulse{position:fixed;bottom:20px;left:20px;width:20px;height:20px;background:white;animation:pulse .6s linear infinite alternate}
@keyframes pulse{to{transform:translateX(100px)}}</style></head><body>
<header><button id="increment">Increment</button><input id="sentinel" value="untouched"><output>Count: 0</output>
<a href="/applications/demo" target="_blank">Open popup</a></header>
<div id="pulse"></div><script>
window.fixtureId=${JSON.stringify(randomUUID())};
window.events={click:0,input:0,focus:0,blur:0,scroll:0,resize:0};
for(const name of Object.keys(window.events)) window.addEventListener(name,()=>window.events[name]++,true);
window.mutations=0;
new MutationObserver(records=>window.mutations+=records.length).observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});
let count=0;
document.querySelector('button').onclick=()=>{
  count++;
  document.querySelector('output').textContent='Count: '+count;
  document.documentElement.style.backgroundColor='rgb('+${JSON.stringify(palette)}[count%4].join(',')+')';
};
sessionStorage.setItem('viewer-sentinel',window.fixtureId);
window.addEventListener('load',()=>{window.scrollTo(0,173);document.querySelector('input').focus({preventScroll:true});});
</script></body></html>`;
}

function observeViewer(viewer, jpegjs) {
  const events = new EventEmitter();
  let count = 0, last, failure;
  const subscriptions = [viewer.onState(state => {
    if (state.status === "error") failure = new Error(state.message);
    events.emit("change");
  }), viewer.onFrame(frame => {
    try {
      assert.equal(frame.sessionId, viewer.getState().sessionId, "Stale-session frame");
      assert.equal(frame.pageId, viewer.getState().selectedPageId, "Frame belongs to another page");
      assert(frame.sequence > (last?.sequence || 0), "Frame sequence must increase");
      const jpeg = Buffer.from(frame.data, "base64");
      assert.equal(jpeg.readUInt16BE(0), 0xffd8, "Missing JPEG SOI");
      const decoded = jpegjs.decode(jpeg, { useTArray: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 16 });
      assert(decoded.width > 0 && decoded.width <= 1440 && decoded.height > 0 && decoded.height <= 900, "JPEG exceeds configured screencast bounds");
      assert.equal(frame.width, decoded.width, `Frame width metadata disagrees with JPEG for ${frame.pageId}`);
      assert.equal(frame.height, decoded.height, `Frame height metadata disagrees with JPEG for ${frame.pageId}`);
      const pixel = (Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width * .75)) * 4;
      last = { ...frame, data: undefined, rgb: Array.from(decoded.data.slice(pixel, pixel + 3)) };
      count++;
    } catch (error) { failure = error; }
    finally { viewer.acknowledge(frame.sessionId, frame.pageId, frame.sequence); }
    events.emit("change");
  })];
  const check = () => { if (failure) throw failure; };
  const wait = (predicate, label, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); events.off("change", inspect); };
    const inspect = () => {
      try {
        check();
        const value = predicate();
        if (value) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out: ${label}; frames=${count}; state=${JSON.stringify(viewer.getState())}; last=${JSON.stringify(last)}`));
    }, timeoutMs);
    events.on("change", inspect);
    inspect();
  });
  return {
    check,
    count: () => count,
    state: (predicate, label) => wait(() => predicate(viewer.getState()), label),
    frame: (after, color, pageId) => wait(() => count > after && last?.pageId === pageId && last.rgb.every((value, index) => Math.abs(value - color[index]) <= 16) && last, `new JPEG for page ${pageId}, RGB ${color}`),
    async quiet(label, ms = 900) {
      const before = count;
      await delay(ms);
      check();
      assert.equal(count, before, `${label}: frames continued while the CSS fixture was still animating`);
    },
    dispose() { subscriptions.forEach(subscription => subscription.dispose()); events.removeAllListeners(); },
  };
}

async function main() {
  const options = runtimeOptions();
  const { BrowserViewerService } = loadSource("src/browserViewerService.ts");
  const { BrowserRuntimeService } = loadSource("src/browserRuntimeService.ts");
  const { RuntimeProcessManager } = loadSource("src/runtimeProcessManager.ts");
  const { JsonRpcClient } = loadSource("src/jsonRpcClient.ts");
  const { jpegjs } = require(path.join(options.runtimeRoot, "node_modules/playwright-core/lib/utilsBundle.js"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-viewer-smoke-"));
  const scopeRoot = path.join(temp, "user", "project", "sessions", "smoke");
  const viewer = new BrowserViewerService(() => scopeRoot);
  const observed = observeViewer(viewer, jpegjs);
  const manager = new RuntimeProcessManager();
  let stderr = "", phase = "setup", connection, failure;
  const startSession = viewer.startSession.bind(viewer);
  viewer.startSession = scope => { connection = startSession(scope); return connection; };
  const requests = [];
  const rpc = new JsonRpcClient(line => manager.writeLine(JSON.stringify({ jsonrpc: "2.0", ...JSON.parse(line) })), () => {},
    request => { throw new Error(`Unexpected MCP server request: ${request.method}`); });
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (!["/applications/demo", "/applications/demo/pages/viewer", "/applications/demo/pages/new-tab"].includes(request.url)) { response.writeHead(404).end(); return; }
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(fixtureHtml(request.url.endsWith("/new-tab")));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/applications/demo`;
    const url = `${baseUrl}/pages/viewer`;
    const helper = compileHook(temp);
    const application = { getView: () => ({ status: "ready", url: baseUrl, name: "Viewer smoke", message: "" }), resolve: async () => application.getView() };
    const runtime = new BrowserRuntimeService({ extensionUri: { fsPath: temp } }, { getConfigRoot: () => temp },
      { info: console.log, warn: console.warn }, () => scopeRoot, () => path.join(temp, "user", "project"), application, viewer);
    // Only executable discovery is overridden, as in browser-runtime-smoke.
    runtime.resolveRuntime = () => ({ root: options.runtimeRoot,
      manifest: { ...options.manifest, platformId: `${process.platform}-${process.arch}` },
      nodePath: options.nodePath, launcherPath: options.launcher, browserExecutablePath: options.browserPath });
    runtime.saveSettings({ enabled: true, disableSandbox: false });
    const launch = runtime.prepareRuntimeLaunch();
    assert(!launch.disabledReason, launch.disabledReason);
    const entry = runtime.getManagedServer();
    assert(entry?.command && entry.args?.length, "Production runtime did not prepare a managed MCP server");
    assert(connection?.socketPath && connection.token && connection.sessionId, "Production runtime did not start the viewer session");
    const config = JSON.parse(fs.readFileSync(entry.args[2], "utf8"));
    assert.equal(config.browser.initPage.length, 1);
    const initPage = config.browser.initPage[0];
    const initSource = fs.readFileSync(initPage, "utf8");
    const helperUrl = pathToFileURL(helper).href;
    assert(initSource.includes(`await import(${JSON.stringify(helperUrl)})`) && initSource.includes("attachBrowserViewer"), "Production initPage did not import the production hook URL");
    manager.start({ command: entry.command, args: entry.args, cwd: temp, env: process.env,
      onStdout: line => { assert(rpc.handleLine(line), `Non-JSON MCP stdout: ${line.slice(0, 300)}`); },
      onStderr: line => { stderr = `${stderr}${line}\n`.slice(-16000); },
      onError: error => { stderr += String(error); rpc.dispose(); },
      onExit: (code, signal) => { stderr += `\nMCP exit: code=${code}, signal=${signal}`; rpc.dispose(); },
    });
    await rpc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-browser-viewer-smoke", version: "1" } });
    rpc.notify("notifications/initialized");
    const { tools } = await rpc.request("tools/list", {});
    for (const name of ["browser_navigate", "browser_click", "browser_snapshot", "browser_evaluate", "browser_tabs", "browser_close"]) {
      assert(tools.some(tool => tool.name === name), `Missing MCP tool ${name}`);
    }
    const call = async (name, args = {}) => {
      observed.check();
      const result = await rpc.request("tools/call", { name, arguments: args }, 35000);
      const text = (result.content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
      assert(!result.isError, `${name}: ${text}`);
      return text;
    };
    const readState = async () => {
      const text = await call("browser_evaluate", { function: `() => ({
        url: location.href, title: document.title, fixtureId: window.fixtureId,
        html: document.documentElement.outerHTML, count: document.querySelector('output').textContent,
        viewport: [innerWidth, innerHeight, devicePixelRatio], scroll: [scrollX, scrollY],
        focus: document.activeElement.id, focused: document.hasFocus(), visibility: document.visibilityState,
        value: document.querySelector('input').value,
        storage: sessionStorage.getItem('viewer-sentinel'), events: window.events, mutations: window.mutations
      })` });
      const json = text.match(/(?:^|\n)(\{[\s\S]*?\n\})(?=\n|$)/)?.[1];
      assert(json, `MCP evaluation did not return a JSON object: ${text}`);
      return JSON.parse(json);
    };
    const click = async expected => {
      const snapshot = await call("browser_snapshot");
      const target = snapshot.match(/button "Increment"[^\n]*?\[ref=([^\]]+)\]/)?.[1];
      assert(target, `Increment button missing: ${snapshot}`);
      assert(tools.find(tool => tool.name === "browser_click").inputSchema.properties.target, "Expected bundled browser_click.target schema");
      await call("browser_click", { target, element: "Increment button" });
      assert.match(await call("browser_snapshot"), new RegExp(`Count: ${expected}\\b`));
    };
    const assertUnchanged = async (before, label) => assert.deepEqual(await readState(), before, label);

    phase = "MCP initPage (production)";
    await call("browser_navigate", { url });
    await observed.state(state => state.pages.length === 1 && state.pages[0].url === url, "one real MCP page registered");
    const pageId = viewer.getState().selectedPageId;
    assert.equal(viewer.getState().status, "paused", "Hidden viewer must not stream");
    await observed.quiet("initially hidden");
    const before = await readState();
    assert.equal(before.url, url);
    assert.equal(before.count, "Count: 0");
    assert.deepEqual(before.viewport, [1440, 900, 1]);
    assert.deepEqual(before.scroll, [0, 173]);
    assert.equal(before.focus, "sentinel");
    assert.equal(before.storage, before.fixtureId);
    const tabsBefore = await call("browser_tabs", { action: "list" });
    const requestsBefore = [...requests];

    phase = "same-page JPEG and passive viewing";
    viewer.setVisible(true);
    const first = await observed.frame(0, colors[0], pageId);
    assert.equal(first.width, 1440);
    assert.equal(first.height, 900);
    assert.equal(viewer.getState().status, "live");
    await observed.frame(observed.count(), colors[0], pageId);
    await assertUnchanged(before, "Viewing changed DOM, URL, viewport, focus, scroll, storage or page events");
    assert.deepEqual(requests, requestsBefore, "Viewing reloaded or opened a separate fixture page");
    assert.equal(await call("browser_tabs", { action: "list" }), tabsBefore, "Viewing created or selected a tab");
    console.log(`PASS: real initPage, single MCP page, JPEG ${first.width}x${first.height}, passive viewing.`);

    phase = "MCP click appears in that page's JPEG";
    let count = observed.count();
    await click(1);
    await observed.frame(count, colors[1], pageId);
    assert.equal((await readState()).fixtureId, before.fixtureId, "Click/viewer replaced the document");
    console.log("PASS: MCP click changed the same page from green to blue in decoded CDP frames.");

    phase = "pause, click while paused, resume";
    const beforePause = await readState();
    viewer.setPaused(true);
    assert.equal(viewer.getState().status, "paused");
    await observed.quiet("paused");
    await assertUnchanged(beforePause, "Pausing changed the page");
    count = observed.count();
    await click(2);
    await observed.quiet("MCP click while viewer paused");
    const pausedPage = await readState();
    viewer.setPaused(false);
    await observed.frame(count, colors[2], pageId);
    await assertUnchanged(pausedPage, "Resuming changed the page");
    viewer.setVisible(false);
    await observed.quiet("hidden after streaming");
    await assertUnchanged(pausedPage, "Hiding changed the page");
    count = observed.count();
    viewer.setVisible(true);
    await observed.frame(count, colors[2], pageId);
    await assertUnchanged(pausedPage, "Showing changed the page");
    console.log("PASS: pause/resume and hide/show; MCP remains usable while paused; no page mutations.");

    const checkAdditionalPage = async (kind, create, expectedUrl, color) => {
      phase = `${kind}: creation and observation`;
      await create();
      await observed.state(state => state.pages.length === 2 && state.pages.some(page => page.id !== pageId && page.url === expectedUrl), `${kind} registered separately`);
      const extra = viewer.getState().pages.find(page => page.id !== pageId);
      assert.equal(viewer.getState().selectedPageId, pageId, "New page unexpectedly changed the viewer selection");
      const tabs = await call("browser_tabs", { action: "list" });
      const tab = [...tabs.matchAll(/^- (\d+):[^\n]*\]\(([^\n]*)\)/gm)].find(match => match[2] === expectedUrl);
      assert(tab, `New ${kind} missing from MCP tabs: ${tabs}`);
      const index = Number(tab[1]);
      await call("browser_tabs", { action: "select", index });
      const extraBefore = await readState();
      assert.notEqual(extraBefore.fixtureId, before.fixtureId, `${kind} reused the original document`);
      const tabsBeforeSelection = await call("browser_tabs", { action: "list" });
      phase = `${kind}: viewer-only selection`;
      for (const [id, expectedColor] of [[extra.id, color], [pageId, colors[2]], [extra.id, color]]) {
        const after = observed.count();
        viewer.selectPage(connection.sessionId, id);
        await observed.frame(after, expectedColor, id);
        await assertUnchanged(extraBefore, `Viewer selection changed the active ${kind} document`);
        assert.equal(await call("browser_tabs", { action: "list" }), tabsBeforeSelection, "Viewer selection switched the active MCP tab");
      }
      phase = `${kind}: close selected viewer page`;
      const after = observed.count();
      await call("browser_tabs", { action: "close", index });
      await observed.state(state => state.pages.length === 1 && state.selectedPageId === pageId, `closed ${kind} removed, original page selected`);
      await observed.frame(after, colors[2], pageId);
      const original = await readState();
      assert.equal(original.fixtureId, before.fixtureId, "Original MCP page was lost");
      assert.deepEqual(original.viewport, before.viewport, "Original MCP viewport changed");
      console.log(`PASS: ${kind} has its own page ID/JPEG; viewer selection is passive; close returns to original page.`);
    };
    await checkAdditionalPage("popup", async () => {
      const snapshot = await call("browser_snapshot");
      const target = snapshot.match(/link "Open popup"[^\n]*?\[ref=([^\]]+)\]/)?.[1];
      assert(target, `Popup link missing: ${snapshot}`);
      await call("browser_click", { target, element: "Open popup link" });
    }, baseUrl, colors[0]);
    const newTabUrl = `${baseUrl}/pages/new-tab`;
    await checkAdditionalPage("MCP new tab", () => call("browser_tabs", { action: "new", url: newTabUrl }), newTabUrl, colors[3]);

    phase = "MCP browser close";
    await call("browser_close");
    await observed.state(state => state.pages.length === 0 && state.status === "waiting", "closed MCP page removed from viewer");
    await observed.quiet("closed browser");
    count = observed.count();
    phase = "MCP browser reopen and attach";
    await call("browser_navigate", { url });
    await observed.state(state => state.pages.length === 1 && state.pages[0].url === url, "reopened MCP page registered");
    const reopenedId = viewer.getState().selectedPageId;
    assert.notEqual(reopenedId, pageId, "Reopened browser reused a stale viewer page ID");
    await observed.frame(count, colors[0], reopenedId);
    const reopened = await readState();
    assert.notEqual(reopened.fixtureId, before.fixtureId);

    phase = "viewer stop leaves MCP page intact";
    viewer.stop();
    assert.equal(viewer.getState().status, "idle");
    assert.equal(viewer.getState().pages.length, 0);
    await observed.quiet("stopped viewer");
    assert(!fs.existsSync(connection.socketPath), "Viewer socket was not removed");
    await assertUnchanged(reopened, "Stopping the viewer changed or closed the MCP page");
    await click(1);
    await call("browser_close");
    console.log("PASS: browser close/reopen, viewer stop, IPC cleanup, MCP navigation/click after viewer detaches.");
  } catch (error) {
    failure = error;
    console.error(`FAIL at ${phase}`);
    console.error(`Viewer state: ${JSON.stringify(viewer.getState())}; decoded frames=${observed.count()}`);
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    observed.dispose();
    viewer.dispose();
    rpc.dispose();
    try { await manager.stop(2000); }
    catch (error) {
      throw failure ? new AggregateError([failure, error], "Smoke failed and MCP process cleanup also failed") : error;
    }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  console.log("PASS: browser viewer smoke using production service/hook and real @playwright/mcp stdio.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

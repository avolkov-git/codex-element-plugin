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
const artifacts = process.env.CODEX_TEST_ARTIFACTS && path.resolve(process.env.CODEX_TEST_ARTIFACTS);
const russian = "\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440 \u0401\u0436";
const replacement = "\u0417\u0430\u043c\u0435\u043d\u0430";

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
  for (const name of ["browserViewerProtocol", "browserViewerInteraction", "browserViewerHook"]) {
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
header{position:fixed;top:20px;left:20px}button,input{font:inherit}input{width:330px}output{display:block}
#editor{position:fixed;top:170px;left:20px;width:500px;min-height:64px;background:white;border:2px solid black}
#after-editor{position:fixed;top:255px;left:20px}
#scrollpane{position:fixed;top:320px;left:20px;width:500px;height:180px;overflow:auto;background:white;border:2px solid black}
#scroll-content{height:1400px;background:repeating-linear-gradient(white 0 39px,#ddd 39px 40px)}
#pulse{position:fixed;bottom:20px;left:20px;width:20px;height:20px;background:white;animation:pulse .6s linear infinite alternate}
@keyframes pulse{to{transform:translateX(100px)}}</style></head><body>
<header><button id="increment">Increment</button><input id="sentinel" aria-label="Smoke input" value="untouched"><output>Count: 0</output>
<a href="/applications/demo" target="_blank">Open popup</a></header>
<div id="editor" role="textbox" aria-label="Smoke editor" contenteditable="true" tabindex="0"></div>
<button id="after-editor">After editor</button>
<div id="scrollpane" role="region" aria-label="Smoke scroll pane"><div id="scroll-content">Independent scroll target</div></div>
<div id="pulse"></div><script>
window.fixtureId=${JSON.stringify(randomUUID())};
window.events={click:0,input:0,focus:0,blur:0,scroll:0,resize:0};
for(const name of Object.keys(window.events)) window.addEventListener(name,()=>window.events[name]++,true);
window.interactions=[];
for(const name of ['mousemove','click','dblclick','focus','keydown','input','wheel']) window.addEventListener(name,event=>{
  window.interactions.push({type:name,target:event.target.id,trusted:event.isTrusted,
    ...(name==='mousemove'||name==='click'||name==='dblclick'||name==='wheel'?{x:event.clientX,y:event.clientY,detail:event.detail}:{}),
    ...(name==='keydown'?{key:event.key,ctrl:event.ctrlKey,meta:event.metaKey}:{}),
    ...(name==='input'?{inputType:event.inputType}:{})});
  if(window.interactions.length>100) window.interactions.shift();
},true);
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
  const pointers = [], results = [];
  let count = 0, last, lastJpeg, failure;
  const subscriptions = [viewer.onState(state => {
    if (state.status === "error") failure = new Error(state.message);
    events.emit("change");
  }), viewer.onFrame(frame => {
    try {
      assert.equal(frame.sessionId, viewer.getState().sessionId, "Stale-session frame");
      assert.equal(frame.pageId, viewer.getState().selectedPageId, "Frame belongs to another page");
      assert.equal(frame.pageRevision, viewer.getState().pageRevision, "Frame belongs to an old document revision");
      assert(frame.sequence > (last?.sequence || 0), "Frame sequence must increase");
      const jpeg = Buffer.from(frame.data, "base64");
      assert.equal(jpeg.readUInt16BE(0), 0xffd8, "Missing JPEG SOI");
      const decoded = jpegjs.decode(jpeg, { useTArray: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 16 });
      assert(decoded.width > 0 && decoded.width <= 1440 && decoded.height > 0 && decoded.height <= 900, "JPEG exceeds configured screencast bounds");
      // CDP metadata describes the viewport; the capped JPEG can be proportionally
      // downscaled. Allow one pixel of rounding on either decoded dimension.
      const aspectError = Math.abs(decoded.width * frame.height - decoded.height * frame.width);
      assert(aspectError <= frame.width + frame.height,
        `JPEG ${decoded.width}x${decoded.height} disagrees with viewport aspect ratio ${frame.width}x${frame.height} for ${frame.pageId}`);
      const pixel = (Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width * .75)) * 4;
      last = { ...frame, data: undefined, rgb: Array.from(decoded.data.slice(pixel, pixel + 3)) };
      lastJpeg = jpeg;
      count++;
    } catch (error) { failure = error; }
    finally { viewer.acknowledge(frame.sessionId, frame.pageId, frame.sequence); }
    events.emit("change");
  }), viewer.onPointer(pointer => {
    try {
      const state = viewer.getState();
      assert.equal(pointer.sessionId, state.sessionId, "Stale-session pointer");
      assert.equal(pointer.pageId, state.selectedPageId, "Pointer belongs to another page");
      assert.equal(state.status, "live", "Pointer arrived while viewer was not live");
      assert(["move", "click", "focus", "clear"].includes(pointer.kind));
      assert([pointer.x, pointer.y, ...Object.values(pointer.bounds || {})].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
      assert(Object.keys(pointer).every(key => ["type", "sessionId", "pageId", "kind", "x", "y", "bounds"].includes(key)), "Pointer must not include typed text or DOM contents");
      if (pointer.bounds) assert.deepEqual(Object.keys(pointer.bounds).sort(), ["height", "width", "x", "y"]);
      pointers.push(pointer);
    } catch (error) { failure = error; }
    events.emit("change");
  }), viewer.onInputResult(result => { results.push(result); events.emit("change"); })];
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
    pointers,
    results,
    count: () => count,
    state: (predicate, label) => wait(() => predicate(viewer.getState()), label),
    frame: (after, color, pageId) => wait(() => count > after && last?.pageId === pageId && last.pageRevision === viewer.getState().pageRevision && last.rgb.every((value, index) => Math.abs(value - color[index]) <= 16) && last, `JPEG for page ${pageId}, RGB ${color}, after frame ${after}`),
    pointer: (after, predicate, label) => wait(() => pointers.slice(after).find(predicate), label),
    result: (lease, inputId) => wait(() => results.find(result => result.sessionId === lease.sessionId && result.pageId === lease.pageId && result.controlId === lease.controlId && result.inputId === inputId), `input ${inputId} result`, 8500),
    capture(name) {
      if (!artifacts || !lastJpeg) return;
      fs.mkdirSync(artifacts, { recursive: true });
      const filename = path.join(artifacts, `mcp-viewer-${name}.jpg`);
      fs.writeFileSync(filename, lastJpeg);
      console.log(`Screenshot (actual MCP screencast): ${filename}`);
    },
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
    for (const name of ["browser_navigate", "browser_click", "browser_fill_form", "browser_snapshot", "browser_evaluate", "browser_tabs", "browser_close"]) {
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
        url: location.href, title: document.title, ready: document.readyState, fixtureId: window.fixtureId,
        html: document.documentElement.outerHTML, count: document.querySelector('output').textContent,
        viewport: [innerWidth, innerHeight, devicePixelRatio], scroll: [scrollX, scrollY],
        focus: document.activeElement.id, focused: document.hasFocus(), visibility: document.visibilityState,
        value: document.querySelector('input').value,
        selection: [document.querySelector('input').selectionStart, document.querySelector('input').selectionEnd],
        editor: document.getElementById('editor').innerText, paneScroll: document.getElementById('scrollpane').scrollTop,
        geometry: Object.fromEntries(['increment','sentinel','editor','after-editor','scrollpane'].map(id=>{
          const rect=document.getElementById(id).getBoundingClientRect();
          return [id,{x:rect.x,y:rect.y,width:rect.width,height:rect.height}];
        })),
        storage: sessionStorage.getItem('viewer-sentinel'), events: window.events, mutations: window.mutations,
        interactions: window.interactions, elements: document.querySelectorAll('*').length
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
    const waitPage = async (predicate, label) => {
      const deadline = Date.now() + 5000;
      let state;
      do {
        state = await readState();
        if (predicate(state)) return state;
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail(`${label}: ${JSON.stringify(state)}`);
    };
    const point = (state, id, scale = 1) => {
      const rect = state.geometry[id];
      // A half/third-size displayed image with a nonzero offset must hit the same DOM target.
      const displayed = { x: 37, y: 61, width: state.viewport[0] * scale, height: state.viewport[1] * scale };
      const client = { x: displayed.x + (rect.x + rect.width / 2) * scale, y: displayed.y + (rect.y + rect.height / 2) * scale };
      const normalized = { x: (client.x - displayed.x) / displayed.width, y: (client.y - displayed.y) / displayed.height };
      assert(Object.values(normalized).every(value => value > 0 && value < 1), `${id} is outside the observed viewport`);
      return normalized;
    };
    const pointerAt = async (after, kind, state, id) => {
      const rect = state.geometry[id];
      const center = point(state, id);
      const pointer = await observed.pointer(after, value => value.kind === kind &&
        Math.abs(value.x - center.x) * state.viewport[0] <= 3 && Math.abs(value.y - center.y) * state.viewport[1] <= 3,
      `${kind} pointer at ${id}`);
      if (kind === "focus") {
        assert(pointer.bounds, `${id}: focus pointer needs target bounds`);
        for (const [key, dimension] of [["x", 0], ["y", 1], ["width", 0], ["height", 1]]) {
          assert(Math.abs(pointer.bounds[key] * state.viewport[dimension] - rect[key]) <= 3, `${id}: wrong normalized focus ${key}`);
        }
      }
      return pointer;
    };
    const trustedClick = (state, id, type = "click") => {
      const event = state.interactions.findLast(event => event.type === type && event.target === id);
      assert(event?.trusted, `${id}: missing trusted ${type} event`);
      const rect = state.geometry[id];
      assert(Math.abs(event.x - rect.x - rect.width / 2) <= 3 && Math.abs(event.y - rect.y - rect.height / 2) <= 3,
        `${id}: normalized click missed the displayed target center`);
      return event;
    };
    const stableFrame = async (id, expectedUrl, color) => {
      await observed.state(state => state.status === "live" && state.selectedPageId === id &&
        state.pages.some(page => page.id === id && page.url === expectedUrl && page.title === "Viewer smoke"), "stable selected-page URL metadata");
      // Background tabs may stop repainting. Require an ACKed current-revision frame,
      // not extra frames after the observed image and navigation metadata have settled.
      const frame = await observed.frame(0, color, id);
      await delay(300);
      observed.check();
      assert.equal(viewer.getState().pageRevision, frame.pageRevision, "Navigation is still pending");
      assert.equal(viewer.getState().selectedPageId, id);
      assert.equal(viewer.getState().pages.find(page => page.id === id)?.url, expectedUrl);
    };
    const enable = async (id, expectedUrl, color) => {
      await stableFrame(id, expectedUrl, color);
      viewer.setControl(connection.sessionId, id, true);
      const controlId = viewer.getState().controlId;
      assert(controlId, "Visible, live, previously ACKed page did not grant control");
      await delay(200);
      assert.equal(viewer.getState().controlId, controlId, "Navigation metadata revoked a newly enabled lease");
      return { sessionId: connection.sessionId, pageId: id, controlId };
    };
    let inputId = 0, inputInFlight = false;
    const send = async (lease, input) => {
      assert(!inputInFlight, "Smoke must send only one manual input at a time");
      inputInFlight = true;
      const id = ++inputId, after = observed.results.length;
      try {
        viewer.sendInput(lease.sessionId, lease.pageId, lease.controlId, id, input);
        const result = await observed.result(lease, id);
        assert.equal(result.ok, true, `Manual ${input.kind} #${id}: ${result.message || viewer.getState().inputError}`);
        assert.equal(observed.results.length, after + 1, "Exactly one matching result is required per input");
        observed.check();
      } finally { inputInFlight = false; }
    };
    const manualClick = (lease, state, id, scale = 1) => send(lease, { kind: "click", ...point(state, id, scale), button: "left", clickCount: 1, modifiers: 0 });
    const key = (lease, key, modifiers = 0) => send(lease, { kind: "key", key, modifiers });
    const ignored = async (lease, label, state = undefined) => {
      const before = state || await readState(), after = observed.results.length;
      for (const input of [{ kind: "text", text: "STALE-LEASE" },
        { kind: "click", ...point(before, "increment"), button: "left", clickCount: 1, modifiers: 0 },
        { kind: "wheel", ...point(before, "scrollpane"), deltaX: 0, deltaY: 200 }]) {
        viewer.sendInput(lease.sessionId, lease.pageId, lease.controlId, ++inputId, input);
      }
      await delay(350);
      observed.check();
      assert.equal(observed.results.length, after, `${label}: stale input was acknowledged`);
      await assertUnchanged(before, `${label}: stale input changed the actual MCP page`);
    };

    phase = "MCP initPage (production)";
    await call("browser_navigate", { url });
    await observed.state(state => state.pages.length === 1 && state.pages[0].url === url, "one real MCP page registered");
    const pageId = viewer.getState().selectedPageId;
    assert.equal(viewer.getState().status, "paused", "Hidden viewer must not stream");
    viewer.setControl(connection.sessionId, pageId, true);
    assert.equal(viewer.getState().controlId, "", "Hidden viewer granted control without an ACKed frame");
    await observed.quiet("initially hidden");
    const before = await readState();
    assert.equal(before.url, url);
    assert.equal(before.ready, "complete");
    assert.equal(before.count, "Count: 0");
    assert.deepEqual(before.viewport, [1440, 900, 1]);
    assert.deepEqual(before.scroll, [0, 173]);
    assert.equal(before.focus, "sentinel");
    assert.equal(before.storage, before.fixtureId);
    const tabsBefore = await call("browser_tabs", { action: "list" });
    const requestsBefore = [...requests];

    phase = "same-page JPEG and passive viewing";
    viewer.setVisible(true);
    viewer.setControl(connection.sessionId, pageId, true);
    assert.equal(viewer.getState().controlId, "", "Live viewer granted control before its first frame ACK");
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
    let pointerMark = observed.pointers.length;
    await click(1);
    await observed.frame(count, colors[1], pageId);
    await pointerAt(pointerMark, "move", before, "increment");
    await pointerAt(pointerMark, "focus", before, "increment");
    assert.equal(viewer.getState().controlId, "", "Agent pointer observation must not require manual control");
    assert.equal((await readState()).fixtureId, before.fixtureId, "Click/viewer replaced the document");
    trustedClick(await readState(), "increment");
    console.log("PASS: MCP click changed the same page's JPEG and emitted normalized cursor/focus before manual control.");

    phase = "MCP fill emits focus without DOM injection";
    const fill = async value => {
      const snapshot = await call("browser_snapshot");
      const target = snapshot.match(/textbox "Smoke input"[^\n]*?\[ref=([^\]]+)\]/)?.[1];
      assert(target, `Smoke input missing: ${snapshot}`);
      await call("browser_fill_form", { fields: [{ name: "Smoke input", type: "textbox", target, value }] });
    };
    const clicked = await readState();
    pointerMark = observed.pointers.length;
    await fill("agent-fill");
    const filled = await readState();
    await pointerAt(pointerMark, "focus", filled, "sentinel");
    assert.equal(filled.focus, "sentinel");
    assert.equal(filled.value, "agent-fill");
    assert.equal(filled.html, clicked.html, "Pointer observation injected DOM while MCP filled an input");
    assert.equal(filled.mutations, clicked.mutations, "Pointer observation mutated the document");
    assert(filled.interactions.some(event => event.type === "input" && event.target === "sentinel" && event.trusted), "MCP fill must use trusted browser input");
    console.log("PASS: real MCP fill emits focus bounds without control, typed-text telemetry, or added DOM elements.");

    phase = "manual scaled click, Unicode insertText, Ctrl+A, Backspace and Enter";
    let lease = await enable(pageId, url, colors[1]);
    pointerMark = observed.pointers.length;
    await manualClick(lease, filled, "sentinel", .5);
    await pointerAt(pointerMark, "click", filled, "sentinel");
    // Browser event.detail sends the first and second clicks as separate acknowledged inputs.
    await send(lease, { kind: "click", ...point(filled, "sentinel", .5), button: "left", clickCount: 2, modifiers: 0 });
    const doubleClicked = await readState();
    assert.equal(trustedClick(doubleClicked, "sentinel", "dblclick").detail, 2);
    assert.equal(doubleClicked.events.click, filled.events.click + 2, "Double-click replayed its first click");
    await key(lease, "End");
    await send(lease, { kind: "text", text: russian });
    let manual = await readState();
    assert.equal(manual.value, `agent-fill${russian}`, "Unicode insertText must preserve Cyrillic, punctuation and spaces");
    assert(manual.interactions.some(event => event.type === "input" && event.target === "sentinel" && event.trusted && event.inputType === "insertText"));
    assert.equal(manual.mutations, filled.mutations, "Input control or pointer telemetry mutated DOM");
    await key(lease, "a", 2);
    manual = await readState();
    assert.deepEqual(manual.selection, [0, manual.value.length], "Ctrl+A did not select the entire input");
    await send(lease, { kind: "text", text: `${replacement}X` });
    await key(lease, "Backspace");
    await key(lease, "Enter");
    manual = await readState();
    assert.equal(manual.value, replacement, "Replacement and Backspace must use real editing semantics");
    assert(manual.interactions.some(event => event.type === "keydown" && event.target === "sentinel" && event.key === "Enter" && event.trusted));

    phase = "manual contenteditable Enter/Tab and focus bounds";
    pointerMark = observed.pointers.length;
    await manualClick(lease, manual, "editor", .375);
    await pointerAt(pointerMark, "focus", manual, "editor");
    trustedClick(await readState(), "editor");
    await send(lease, { kind: "text", text: russian });
    await key(lease, "Enter");
    await send(lease, { kind: "text", text: `${replacement}X` });
    await key(lease, "Backspace");
    manual = await readState();
    assert.equal(manual.editor, `${russian}\n${replacement}`, "Contenteditable must retain Unicode and a real Enter line break");
    pointerMark = observed.pointers.length;
    await key(lease, "Tab");
    manual = await readState();
    assert.equal(manual.focus, "after-editor", "Tab did not advance focus to the next fixture control");
    await pointerAt(pointerMark, "focus", manual, "after-editor");
    assert(manual.interactions.some(event => event.type === "keydown" && event.target === "editor" && event.key === "Tab" && event.trusted));
    console.log("PASS: half/third-scale normalized clicks, double-click, Russian insertText, Ctrl+A replacement, Backspace, Enter, contenteditable and Tab focus.");

    phase = "manual move and wheel target the nested scroll pane";
    const beforeWheel = manual;
    pointerMark = observed.pointers.length;
    await send(lease, { kind: "move", ...point(manual, "scrollpane", .5) });
    await pointerAt(pointerMark, "move", manual, "scrollpane");
    await send(lease, { kind: "wheel", ...point(manual, "scrollpane", .5), deltaX: 0, deltaY: 360 });
    manual = await waitPage(state => state.paneScroll > beforeWheel.paneScroll, "Wheel did not scroll its target");
    assert.deepEqual(manual.scroll, beforeWheel.scroll, "Wheel scrolled the document instead of its target pane");
    assert(manual.interactions.some(event => event.type === "wheel" && event.target === "scroll-content" && event.trusted));
    assert.equal(manual.fixtureId, before.fixtureId);
    assert.deepEqual(manual.viewport, before.viewport);
    await observed.frame(observed.count(), colors[1], pageId);
    observed.capture("manual-input");
    const controlled = await readState();
    await observed.frame(observed.count(), colors[1], pageId);
    await assertUnchanged(controlled, "Observation during manual control changed DOM, focus or scroll");
    console.log("PASS: normalized move/wheel reached the nested pane with trusted events; document viewport/scroll/identity stayed intact.");

    phase = "manual disable, stale lease and subsequent MCP fill";
    viewer.setControl(lease.sessionId, lease.pageId, false);
    assert.equal(viewer.getState().controlId, "");
    await ignored(lease, "explicitly disabled control");
    const oldLease = lease;
    lease = await enable(pageId, url, colors[1]);
    assert.notEqual(lease.controlId, oldLease.controlId, "Re-enabling reused a stale lease");
    await ignored(oldLease, "old lease while fresh control is enabled");
    await fill("agent-after-manual");
    assert.equal((await readState()).value, "agent-after-manual", "MCP fill stopped working after manual input");
    console.log("PASS: disabled/stale leases ignored; fresh lease issued; production MCP fill still works after manual editing.");

    phase = "pause, click while paused, resume";
    const beforePause = await readState();
    viewer.setPaused(true);
    assert.equal(viewer.getState().status, "paused");
    assert.equal(viewer.getState().controlId, "", "Pause did not revoke control");
    await observed.quiet("paused");
    await assertUnchanged(beforePause, "Pausing changed the page");
    await ignored(lease, "paused control");
    viewer.setControl(connection.sessionId, pageId, true);
    assert.equal(viewer.getState().controlId, "", "Paused viewer granted control");
    count = observed.count();
    await click(2);
    await observed.quiet("MCP click while viewer paused");
    const pausedPage = await readState();
    viewer.setPaused(false);
    await observed.frame(count, colors[2], pageId);
    await assertUnchanged(pausedPage, "Resuming changed the page");
    await ignored(lease, "resuming must not restore an old lease");
    lease = await enable(pageId, url, colors[2]);
    viewer.setVisible(false);
    assert.equal(viewer.getState().controlId, "", "Hide did not revoke control");
    await observed.quiet("hidden after streaming");
    await assertUnchanged(pausedPage, "Hiding changed the page");
    await ignored(lease, "hidden control");
    count = observed.count();
    viewer.setVisible(true);
    await observed.frame(count, colors[2], pageId);
    await assertUnchanged(pausedPage, "Showing changed the page");
    await ignored(lease, "showing must not restore an old lease");
    console.log("PASS: pause/resume and hide/show revoke leases; stale input ignored; MCP remains usable while paused; no page mutations.");

    const checkAdditionalPage = async (kind, create, expectedUrl, color) => {
      phase = `${kind}: creation and observation`;
      const originalBefore = await readState();
      const backgroundValue = `${kind}: ${russian}`;
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
        const selected = viewer.getState().selectedPageId;
        const selectionLease = await enable(selected, selected === pageId ? url : expectedUrl, selected === pageId ? colors[2] : color);
        const after = observed.count();
        viewer.selectPage(connection.sessionId, id);
        assert.equal(viewer.getState().controlId, "", `${kind}: page selection did not revoke control`);
        await observed.frame(after, expectedColor, id);
        await assertUnchanged(extraBefore, `Viewer selection changed the active ${kind} document`);
        await ignored(selectionLease, `${kind}: old page's control after viewer selection`, extraBefore);
        assert.equal(await call("browser_tabs", { action: "list" }), tabsBeforeSelection, "Viewer selection switched the active MCP tab");
        if (id === pageId) {
          phase = `${kind}: manual input into background A while MCP keeps B selected`;
          const backgroundLease = await enable(pageId, url, colors[2]);
          await manualClick(backgroundLease, originalBefore, "sentinel", .5);
          await key(backgroundLease, "a", 2);
          await send(backgroundLease, { kind: "text", text: backgroundValue });
          assert.equal(await call("browser_tabs", { action: "list" }), tabsBeforeSelection, "Background manual input switched the selected MCP tab");
          await assertUnchanged(extraBefore, "Manual input for viewer-selected A changed MCP-selected B");
          phase = `${kind}: viewer-only selection`;
        }
      }
      phase = `${kind}: close selected viewer page`;
      const closingLease = await enable(extra.id, expectedUrl, color);
      const after = observed.count();
      viewer.closePages(connection.sessionId, extra.id, "selected");
      await observed.state(state => state.pages.length === 1 && state.selectedPageId === pageId, `closed ${kind} removed, original page selected`);
      assert.equal(viewer.getState().controlId, "", `${kind}: page closure did not revoke control`);
      await observed.frame(after, colors[2], pageId);
      const original = await readState();
      assert.equal(original.fixtureId, before.fixtureId, "Original MCP page was lost");
      assert.deepEqual(original.viewport, before.viewport, "Original MCP viewport changed");
      // Read A through MCP only after closing B; the manual actions themselves must never switch MCP's tab.
      assert.equal(original.value, backgroundValue, `${kind}: manual typing did not reach background A`);
      trustedClick(original, "sentinel");
      for (const field of ["count", "editor", "paneScroll", "elements"]) assert.deepEqual(original[field], originalBefore[field], `${kind}: stale input changed the inactive original page's ${field}`);
      await ignored(closingLease, `${kind}: closed page's control`, original);
      console.log(`PASS: ${kind} has its own page ID/JPEG; selection/close revoke control without switching MCP tabs or mutating either page.`);
      console.log(`PASS: ${kind}: manual click/Unicode text reached viewer-selected background A while MCP stayed on unchanged B; no bringToFront.`);
    };
    await checkAdditionalPage("popup", async () => {
      const snapshot = await call("browser_snapshot");
      const target = snapshot.match(/link "Open popup"[^\n]*?\[ref=([^\]]+)\]/)?.[1];
      assert(target, `Popup link missing: ${snapshot}`);
      await call("browser_click", { target, element: "Open popup link" });
    }, baseUrl, colors[0]);
    const newTabUrl = `${baseUrl}/pages/new-tab`;
    await checkAdditionalPage("MCP new tab", () => call("browser_tabs", { action: "new", url: newTabUrl }), newTabUrl, colors[3]);

    phase = "viewer closes all other tabs while keeping the selected page and lease";
    const keptPage = await readState();
    await call("browser_tabs", { action: "new", url: newTabUrl });
    await call("browser_tabs", { action: "new", url: baseUrl });
    await observed.state(state => state.pages.length === 3, "three pages registered before close others");
    assert.equal(viewer.getState().selectedPageId, pageId);
    lease = await enable(pageId, url, colors[2]);
    viewer.closePages(connection.sessionId, pageId, "others");
    await observed.state(state => state.pages.length === 1 && !state.closingPageIds.length, "other pages closed through viewer");
    assert.equal(viewer.getState().selectedPageId, pageId);
    assert.equal(viewer.getState().controlId, lease.controlId, "Closing other tabs revoked the kept page's control");
    const remainingTabs = await call("browser_tabs", { action: "list" });
    assert.equal([...remainingTabs.matchAll(/^- (\d+):/gm)].length, 1, "MCP must observe the same single surviving tab");
    assert.equal((await readState()).fixtureId, keptPage.fixtureId);
    console.log("PASS: viewer close-current and close-others remove real MCP pages, preserve the selected document, and leave MCP usable.");

    phase = "same-URL navigation revokes control";
    lease = await enable(pageId, url, colors[2]);
    const revision = viewer.getState().pageRevision;
    count = observed.count();
    await call("browser_navigate", { url });
    await observed.frame(count, colors[0], pageId);
    assert(viewer.getState().pageRevision > revision, "Same-URL navigation did not advance the observed document revision");
    assert.equal(viewer.getState().controlId, "", "Same-URL navigation did not revoke control");
    const navigated = await readState();
    assert.notEqual(navigated.fixtureId, before.fixtureId, "Navigation did not replace the document");
    await ignored(lease, "navigated document's old control", navigated);
    console.log("PASS: same-URL navigation revokes control and ignores the old document's lease.");

    phase = "viewer closes the last browser tab";
    const closedLease = await enable(pageId, url, colors[0]);
    viewer.closePages(connection.sessionId, pageId, "selected");
    await observed.state(state => state.pages.length === 0 && state.status === "waiting", "closed MCP page removed from viewer");
    assert.equal(viewer.getState().controlId, "", "Browser close did not revoke control");
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
    lease = await enable(reopenedId, url, colors[0]);
    await ignored(closedLease, "closed browser's old lease after reopening", reopened);
    await manualClick(lease, reopened, "sentinel", .5);
    await send(lease, { kind: "text", text: russian });
    assert((await readState()).value.includes(russian), "Reopened browser did not accept fresh manual input");
    await observed.frame(observed.count(), colors[0], reopenedId);
    observed.capture("reopened");

    phase = "untrusted DOM events must not spoof pointer telemetry";
    const beforeSynthetic = await readState();
    await stableFrame(reopenedId, url, colors[0]);
    pointerMark = observed.pointers.length;
    await call("browser_evaluate", { function: `() => {
      const target = document.getElementById('sentinel');
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1234, clientY: 567 }));
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1234, clientY: 567 }));
      target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'untrusted-not-entered' }));
      return { dispatched: true };
    }` });
    await stableFrame(reopenedId, url, colors[0]);
    assert.equal(observed.pointers.length, pointerMark, "Synthetic untrusted DOM events produced agent cursor/focus telemetry");
    const synthetic = await readState();
    assert.equal(synthetic.value, beforeSynthetic.value);
    assert.equal(synthetic.html, beforeSynthetic.html);
    assert.equal(synthetic.mutations, beforeSynthetic.mutations);
    console.log("PASS: untrusted pointer/focus/input dispatches cannot spoof agent telemetry.");

    phase = "viewer stop leaves MCP page intact";
    const beforeStop = await readState();
    viewer.stop();
    assert.equal(viewer.getState().status, "idle");
    assert.equal(viewer.getState().pages.length, 0);
    assert.equal(viewer.getState().controlId, "", "Viewer stop did not revoke control");
    await observed.quiet("stopped viewer");
    assert(!fs.existsSync(connection.socketPath), "Viewer socket was not removed");
    await assertUnchanged(beforeStop, "Stopping the viewer changed or closed the MCP page");
    await ignored(lease, "stopped viewer's old control", beforeStop);
    await click(1);
    await call("browser_close");
    console.log("PASS: browser close/reopen, viewer stop, IPC cleanup, MCP navigation/click after viewer detaches.");
  } catch (error) {
    failure = error;
    observed.capture("FAILED");
    console.error(`FAIL at ${phase}`);
    console.error(`Viewer state: ${JSON.stringify(viewer.getState())}; decoded frames=${observed.count()}`);
    console.error(`Recent pointer telemetry: ${JSON.stringify(observed.pointers.slice(-8))}; input results: ${JSON.stringify(observed.results.slice(-4))}`);
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

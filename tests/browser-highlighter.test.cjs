const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require("playwright");
const { buildHighlighter } = require("../scripts/build-xbsl-highlighter");
const { loadSource, vscode } = require("./service-test-utils.cjs");

let browser;
let bundle;
const sample = "метод Проверка(): Строка\n  возврат \"Готово\"\n;";
const escapeScript = (value) => value.replace(/<\/script/gi, "<\\/script");

before(async () => {
  bundle = (await buildHighlighter()).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
});
after(async () => { await browser?.close(); });

async function highlighterPage(t, { worker = true } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  await page.addInitScript(() => {
    window.blobsCreated = 0;
    window.blobsRevoked = 0;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (...args) => { window.blobsCreated += 1; return create(...args); };
    URL.revokeObjectURL = (...args) => { window.blobsRevoked += 1; return revoke(...args); };
  });
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-test'; style-src 'unsafe-inline'; worker-src ${worker ? "blob:" : "'none'"};"><div id="root"></div><script nonce="test">${escapeScript(bundle)}</script>` });
  });
  await page.goto("http://highlight-test.invalid/prefix/");
  return { page, requests };
}

test("native Chrome worker preserves colors, rejects stale versions, bounds caches/queue and releases Blob resources", { timeout: 30000 }, async (t) => {
  const { page, requests } = await highlighterPage(t);
  const workers = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  const result = await page.evaluate(async (source) => {
    const h = window.codexXbslHighlighter;
    const html = await h.highlight(source, "xbsl");
    const initial = h.getStats();
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 10);
    for (let index = 0; index < 95; index += 1) {
      await h.highlight((`пер Значение${index} = 42\n`).repeat(80), "xbsl");
    }
    const cached = h.getStats();
    const versions = [];
    for (let version = 1; version <= 30; version += 1) {
      versions.push(h.highlight(`пер Текущий = ${version}`, "xbsl", { blockId: "chat:message:0", version }).then(() => "ok", (error) => error.name));
    }
    const versionResults = await Promise.all(versions);
    const obsolete = await h.highlight("пер Текущий = 0", "xbsl", { blockId: "chat:message:0", version: 0 }).catch((error) => error.name);
    const cachedStale = h.highlight("пер Текущий = 30", "xbsl", { blockId: "cache-race", version: 0 }).catch((error) => error.name);
    const cachedLatest = h.highlight("пер Текущий = 31", "xbsl", { blockId: "cache-race", version: 1 });
    const cachedRejection = await cachedStale;
    await cachedLatest;
    const flood = Array.from({ length: 90 }, (_, index) => h.highlight(`пер Flood${index} = 0`, "xbsl").then(() => "ok", (error) => error.name));
    const pending = h.getStats();
    h.dispose();
    await Promise.all(flood);
    clearInterval(heartbeat);
    return { html, initial, cached, pending, disposed: h.getStats(), versionResults, obsolete, cachedRejection, ticks,
      created: window.blobsCreated, revoked: window.blobsRevoked, secure: isSecureContext, serviceWorker: !!navigator.serviceWorker };
  }, sample);
  assert.match(result.html, /xbsl-semantic-kind-function/);
  assert.match(result.html, /--shiki-light:#1838FF/);
  assert.match(result.html, /--shiki-dark:#66B3FF/);
  assert.equal(result.initial.mode, "worker");
  assert.equal(result.initial.fallbackJobs, 0);
  assert.equal(result.secure, false);
  assert.equal(result.serviceWorker, false);
  assert(result.cached.evictions > 0, "byte budget must trigger eviction before entry limit");
  assert(result.cached.cacheBytes <= result.cached.limits.cacheBytes);
  assert(result.pending.pendingBytes <= result.pending.limits.pendingBytes);
  assert(result.pending.pendingJobs <= result.pending.limits.pendingJobs);
  assert.equal(result.versionResults.filter((item) => item === "ok").length, 1);
  assert.equal(result.obsolete, "AbortError");
  assert.equal(result.cachedRejection, "AbortError");
  assert(result.ticks >= 20, "UI heartbeat must continue during tokenization");
  assert.equal(result.disposed.cacheBytes, 0);
  assert.equal(result.disposed.pendingBytes, 0);
  assert.equal(result.created, 1);
  assert.equal(result.revoked, 1);
  assert.equal(workers.length, 1);
  assert(workers[0].startsWith("blob:"));
  assert.equal(requests.length, 1, "worker must not load network dependencies");
});

test("CSP-denied worker uses throttled semantic fallback and rejects oversized work without truncating text", async (t) => {
  const { page } = await highlighterPage(t, { worker: false });
  const result = await page.evaluate(async (source) => {
    const h = window.codexXbslHighlighter;
    const html = await h.highlight(source, "xbsl");
    const start = performance.now();
    await Promise.all([0, 1, 2, 3].map((index) => h.highlight(`пер Разный = ${index}`, "xbsl")));
    const elapsed = performance.now() - start;
    const before = h.getStats().fallbackJobs;
    const oversized = await h.highlight("пер А = 1\n".repeat(100), "xbsl").catch((error) => error.name);
    const after = h.getStats();
    h.dispose();
    return { html, elapsed, before, after, oversized, created: window.blobsCreated, revoked: window.blobsRevoked };
  }, sample);
  assert.match(result.html, /xbsl-semantic-kind-function/);
  assert.equal(result.after.mode, "fallback");
  assert(result.elapsed >= 280, "fallback must be paced, not one microtask per block");
  assert.equal(result.oversized, "RangeError");
  assert.equal(result.before, result.after.fallbackJobs);
  assert.equal(result.created, result.revoked);
});

const wrapperRoot = process.env.ELEMENT_WEBVIEW_PRE || path.join(os.homedir(), "Downloads/server-package-with-ide-9.2.4-6/ide/theia/products/browser-app/lib/webview/pre");

async function wrapperProbe(t, assetMode, protocol = "http:") {
  assert(fs.existsSync(path.join(wrapperRoot, "host.js")), "Set ELEMENT_WEBVIEW_PRE to the actual Element webview/pre source directory");
  const origin = `${protocol}//element-wrapper.invalid`;
  const prefix = "/reverse-proxy/element";
  const main = `(() => {
    window.externalExecutions = (window.externalExecutions || 0) + 1;
    if (window.__codexElementAppReady) return;
    window.__codexElementAppReady = true;
    window.mounts = (window.mounts || 0) + 1;
    const api = acquireVsCodeApi();
    window.codexXbslHighlighter.highlight(${JSON.stringify(sample)}, 'xbsl').then(html => {
      document.getElementById('root').innerHTML = '<pre>' + html + '</pre>';
      api.postMessage({ type:'test-ready', html, assetMode:window.__codexElementWebviewAssetMode,
        mode:window.codexXbslHighlighter.getStats().mode, secure:isSecureContext, serviceWorker:!!navigator.serviceWorker });
    });
  })();`;
  const assets = new Map([["chat.js", main], ["xbsl-highlighter.js", bundle], ["chat.css", "pre { font-size: 14px; }"]]);
  const { renderWebviewHtml } = loadSource("src/webviewHtml.ts", {
    vscode, fs: { ...fs, readFileSync: (file) => assets.get(path.basename(file)) },
  });
  const contents = renderWebviewHtml({ extensionUri: { fsPath: "/plugin" }, webview: {
    cspSource: origin, asWebviewUri: (uri) => `${origin}${prefix}/webview/theia-resource/file/plugin/${path.basename(uri.fsPath)}`,
  }, scriptPath: "chat.js", preloadScriptPaths: ["xbsl-highlighter.js"], stylePath: "chat.css", title: "RC bootstrap" });
  const outer = `<html><head><meta charset="UTF-8"></head><body><script>
    window.result = null;
    window.addEventListener('message', event => {
      if(event.data.channel === 'webview-ready') event.source.postMessage({channel:'content', args:${escapeScript(JSON.stringify({ contents, options: { allowScripts: true } }))}}, '*');
      if(event.data.channel === 'onmessage' && event.data.data.type === 'test-ready') window.result = event.data.data;
    });
  </script><iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" src="${prefix}/webview/index.html?id=probe"></iframe></body></html>`;
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(() => Object.defineProperty(navigator, "serviceWorker", { value: undefined }));
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `${prefix}/`) return route.fulfill({ contentType: "text/html; charset=utf-8", body: outer });
    const file = path.basename(url.pathname);
    if (["index.html", "main.js", "host.js", "fake.html", "service-worker.js"].includes(file)) {
      return route.fulfill({ contentType: file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", body: fs.readFileSync(path.join(wrapperRoot, file)) });
    }
    if (assets.has(file) && assetMode !== "missing") {
      if (assetMode === "late") await new Promise((resolve) => setTimeout(resolve, 1400));
      return route.fulfill({ contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8", body: assets.get(file) });
    }
    return route.fulfill({ status: 404, body: "Resource delivery requires the absent Service Worker" });
  });
  await page.goto(`${origin}${prefix}/`);
  await page.waitForFunction(() => window.result, undefined, { timeout: 15000 });
  const result = await page.evaluate(() => window.result);
  const frame = page.frames().find((candidate) => candidate.url().includes("fake.html"));
  assert(frame, "actual nested Theia content iframe was not created");
  if (assetMode === "late") {
    try {
      await frame.waitForFunction(() => window.externalExecutions === 2, undefined, { timeout: 10000 });
    } catch (error) {
      console.error(await frame.evaluate(() => ({ executions: window.externalExecutions, mounts: window.mounts,
        scripts: [...document.scripts].map((script) => ({ src: script.src, defer: script.defer })), state: document.readyState })));
      throw error;
    }
  }
  const state = await frame.evaluate(() => {
    const api = window.codexXbslHighlighter;
    window.__codexElementRunInlineFallback();
    window.__codexElementRunInlineFallback();
    return { mounts: window.mounts, singleton: api === window.codexXbslHighlighter,
      fallbackStyles: document.querySelectorAll("style[data-codex-element-inline-fallback]").length,
      workerJobs: api.getStats().workerJobs };
  });
  assert.equal(state.mounts, 1);
  assert.equal(state.singleton, true);
  assert.equal(state.workerJobs, 1);
  assert.equal(state.fallbackStyles, assetMode === "external" ? 0 : 1);
  return result;
}

test("actual Element wrapper: HTTP inline includes preload, HTTPS external matches, late external mounts once", { timeout: 45000 }, async (t) => {
  const inline = await wrapperProbe(t, "missing");
  const external = await wrapperProbe(t, "external", "https:");
  const late = await wrapperProbe(t, "late");
  assert.equal(inline.secure, false);
  assert.equal(inline.serviceWorker, false);
  assert.equal(inline.assetMode, "inline fallback");
  assert.equal(external.assetMode, "external");
  assert.equal(late.assetMode, "inline fallback");
  assert.equal(inline.mode, "worker");
  assert.equal(external.mode, "worker");
  assert.equal(late.mode, "worker");
  assert.equal(inline.html, external.html);
  assert.equal(inline.html, late.html);
});

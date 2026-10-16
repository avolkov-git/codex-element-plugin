const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { loadSource, root, vscode } = require("../tests/service-test-utils.cjs");

const artifacts = process.env.CODEX_TEST_ARTIFACTS || path.join(root, ".impeccable/review/browser-viewer");
const wrapperRoot = process.env.ELEMENT_WEBVIEW_PRE || path.join(os.homedir(),
  "pet-project/element-ai/theia-plugin-qc/artifacts/server 9.1.9-17/ide/theia/products/browser-app/lib/webview/pre");
const skipWrapper = process.env.CODEX_TEST_SKIP_ELEMENT_WRAPPER === "1";
const origin = "http://browser-viewer.fixture.invalid";
const prefix = "/reverse-proxy/element";
const escapeScript = value => value.replace(/<\/script/gi, "<\\/script");
const { renderWebviewHtml } = loadSource("src/webviewHtml.ts", { vscode });
const allowedMessages = new Set(["viewer.ready", "viewer.visibility", "viewer.pause", "viewer.select", "viewer.ack", "viewer.control", "viewer.input"]);
const themes = {
  light: { "editor-background": "#ffffff", "editor-foreground": "#25282c", "panel-border": "#d0d0d0",
    descriptionForeground: "#626871", "editorWidget-background": "#f3f4f6", "list-hoverBackground": "#e9ecef", errorForeground: "#bd303b" },
  dark: { "editor-background": "#202020", "editor-foreground": "#ededed", "panel-border": "#454545",
    descriptionForeground: "#b3b3b3", "editorWidget-background": "#292929", "list-hoverBackground": "#383838", errorForeground: "#ff8980" }
};
const sizes = [{ width: 1100, height: 760 }, { width: 360, height: 720 }];

function viewerState(patch = {}) {
  return { type: "browser.viewer.state", sessionId: "session-a", status: "live", message: "Live fixture view",
    pages: [{ id: "page-a", title: "Orders " + "long-title-".repeat(35), url: `${origin}/orders/${"long-path-".repeat(70)}` },
      { id: "page-b", title: "Inventory", url: `${origin}/inventory` }], selectedPageId: "page-a", controlId: "", pageRevision: 0, ...patch };
}

async function settle(frame) {
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function fits(frame, label) {
  const failures = await frame.evaluate(() => {
    const failures = [];
    for (const node of [document.documentElement, document.body, document.getElementById("root")]) {
      if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) failures.push(`${node.tagName}: document overflow`);
    }
    const selectors = ".browser-viewer, .viewer-toolbar, .viewer-toolbar > *, .viewer-address, .viewer-stage, .viewer-frame, .viewer-empty, .viewer-empty p, .viewer-status, .viewer-status > *";
    for (const node of document.querySelectorAll(selectors)) {
      if (!node.getClientRects().length) continue;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) failures.push(`${node.className || node.tagName}: outside viewport`);
      // URL and native select labels are intentionally ellipsized, not wrapped.
      if (node.tagName !== "SELECT" && style.textOverflow !== "ellipsis" && node.scrollWidth > node.clientWidth + 1) failures.push(`${node.className || node.tagName}: clipped text`);
      if (node.scrollHeight > node.clientHeight + 1) failures.push(`${node.className || node.tagName}: vertical overflow`);
    }
    const rows = [...document.querySelector(".browser-viewer").children].map(node => node.getBoundingClientRect());
    for (let i = 1; i < rows.length; i++) if (rows[i].top < rows[i - 1].bottom - 1) failures.push("viewer rows overlap");
    const controls = [...document.querySelector(".viewer-toolbar").children].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect());
    for (let i = 1; i < controls.length; i++) if (controls[i].left < controls[i - 1].right - 1) failures.push("toolbar controls overlap");
    return failures;
  });
  assert.deepEqual(failures, [], `${label}: responsive bounds`);
}

async function makeJpeg(browser) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; color: #25282c; background: #fff; font: 16px system-ui; }
      header { padding: 24px 32px; background: #163e35; color: white; font-size: 24px; }
      main { padding: 24px 32px; } h1 { margin: 0 0 18px; font-size: 24px; }
      table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 14px; border-bottom: 1px solid #ddd; }
      th { background: #edf1f0; } .status { color: #217342; } footer { margin-top: 24px; color: #626871; }
    </style></head><body><header>Element / Local browser fixture</header><main><h1>Orders</h1>
      <table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>
      <tr><td>ORD-1042</td><td>North workshop</td><td class="status">Complete</td><td>12,800</td></tr>
      <tr><td>ORD-1043</td><td>City office</td><td>Processing</td><td>8,420</td></tr>
      <tr><td>ORD-1044</td><td>Central store</td><td class="status">Complete</td><td>3,600</td></tr></tbody></table>
      <footer>Local screenshot fixture. No remote page was opened.</footer></main></body></html>`);
    const bytes = await page.screenshot({ type: "jpeg", quality: 80, path: path.join(artifacts, "fixture.jpg") });
    assert.equal(bytes.readUInt16BE(0), 0xffd8, "fixture must be a real JPEG");
    assert(bytes.toString("base64").length < 512 * 1024);
    return bytes.toString("base64");
  } finally { await context.close(); }
}

function hostHtml(contents, theme) {
  // Same real-wrapper content/styles handshake as tests/browser-highlighter.test.cjs.
  const styles = Object.fromEntries(Object.entries(themes[theme]).map(([key, value]) => [`vscode-${key}`, value]));
  styles["vscode-font-family"] = "system-ui, sans-serif";
  styles["vscode-font-size"] = "13px";
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    html, body { width:100%; height:100%; margin:0; overflow:hidden; } iframe { display:block; width:100%; height:100%; border:0; }
    </style></head><body><script>
    window.fixtureMessages = []; window.fixtureHostErrors = []; window.fixtureForwardedKeys = [];
    window.fixtureSend = data => document.querySelector('iframe').contentWindow.postMessage({channel:'message', args:data}, '*');
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe').contentWindow) return;
      if (event.data.channel === 'webview-ready') {
        event.source.postMessage({channel:'styles', args:${escapeScript(JSON.stringify({ styles, activeThemeType: `vscode-${theme}`, activeThemeName: theme }))}}, '*');
        event.source.postMessage({channel:'content', args:${escapeScript(JSON.stringify({ contents, options: { allowScripts: true } }))}}, '*');
      }
      if (event.data.channel === 'onmessage') window.fixtureMessages.push(event.data.data);
      if (event.data.channel === 'did-keydown') window.fixtureForwardedKeys.push(event.data.data);
      if (event.data.channel === 'onconsole' && event.data.data.level === 'error') window.fixtureHostErrors.push(event.data.data);
    });
    </script><iframe title="Element webview host" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" src="${prefix}/webview/index.html?id=viewer-probe"></iframe></body></html>`;
}

async function manualControlChecks({ page, frame, emit, messages, sendFrame, waitAck, shot, noImage }) {
  const control = frame.getByRole("button", { name: /^(Включить|Отключить) управление$/ });
  const proxy = frame.getByRole("textbox", { name: "Клавиатура браузера агента" });
  const inputs = async () => (await messages()).filter(message => message.type === "viewer.input");
  const answered = new Set();
  const reply = async (input, patch = {}) => {
    answered.add(input.inputId);
    await emit({ type: "browser.viewer.inputResult", sessionId: input.sessionId, pageId: input.pageId,
      controlId: input.controlId, inputId: input.inputId, ok: true, ...patch });
  };
  const drain = async () => {
    // The actual Element wrapper forwards postMessage through two nested frames.
    await settle(frame);
    for (let i = 0; i < 80; i++) {
      const next = (await inputs()).find(input => !answered.has(input.inputId));
      if (!next) return;
      await reply(next);
    }
    assert.fail("input queue did not drain");
  };
  let lease = 0, sequence = 100;
  const grant = async () => {
    await emit(viewerState());
    await sendFrame(++sequence); await waitAck(sequence);
    await control.click();
    assert.deepEqual((await messages()).filter(message => message.type === "viewer.control").at(-1),
      { type: "viewer.control", sessionId: "session-a", pageId: "page-a", enabled: true });
    const controlId = `lease-${++lease}`;
    await emit(viewerState({ controlId }));
    assert.equal(await control.getAttribute("aria-pressed"), "true");
    assert(await proxy.evaluate(node => node === document.activeElement), "keyboard capture starts only after grant");
    return controlId;
  };
  const gesture = (type, x, y, extra = {}) => frame.locator(".viewer-stage").evaluate((node, { type, x, y, extra }) => {
    const box = node.getBoundingClientRect(), image = node.querySelector("img");
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    const options = { bubbles: true, cancelable: true, clientX: box.left + (box.width - width) / 2 + width * x,
      clientY: box.top + height * y, ...extra };
    return node.dispatchEvent(type === "wheel" ? new WheelEvent(type, options) : new MouseEvent(type, options));
  }, { type, x, y, extra });
  const key = options => proxy.evaluate((node, options) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, options);
  const pointer = { type: "browser.viewer.pointer", sessionId: "session-a", pageId: "page-a", kind: "focus", x: .25, y: .4,
    bounds: { x: .15, y: .32, width: .4, height: .12 } };

  assert.equal(await control.getAttribute("aria-pressed"), "false");
  assert((await control.getAttribute("title")).includes("Esc"));
  await gesture("click", .25, .5, { detail: 1 });
  await gesture("wheel", .25, .5, { deltaY: 100 });
  await page.keyboard.insertText("read-only");
  assert.equal((await inputs()).length, 0, "live viewer is read-only until explicit opt-in");
  assert.equal((await messages()).filter(message => message.type === "viewer.control").length, 0);
  await emit({ ...pointer, pageId: "other" });
  assert.equal(await frame.locator(".viewer-pointer").count(), 0);
  await emit(pointer);
  assert.equal(await frame.locator(".viewer-pointer").count(), 0, "focus-only events must not fabricate mouse movement");
  assert.equal(await frame.locator(".viewer-focus-bounds").count(), 1, "focus-only events show the field outline");
  await shot("focus-only");
  const readOverlay = () => frame.locator(".viewer-pointer-layer").evaluate(node => {
    const layer = node.getBoundingClientRect(), cursor = node.querySelector(".viewer-pointer").getBoundingClientRect();
    const bounds = node.querySelector(".viewer-focus-bounds").getBoundingClientRect();
    return { x: (cursor.left - layer.left) / layer.width, y: (cursor.top - layer.top) / layer.height,
      width: bounds.width / layer.width, height: bounds.height / layer.height };
  });
  await emit({ ...pointer, kind: "move", bounds: undefined });
  const overlay = await readOverlay();
  for (const [key, expected] of Object.entries({ x: .25, y: .4, width: .4, height: .12 })) assert(Math.abs(overlay[key] - expected) < .001, `scaled overlay ${key}`);
  await emit({ ...pointer, x: .8, y: .8, bounds: { ...pointer.bounds, width: .3 } });
  const afterFocus = await readOverlay();
  assert.equal(afterFocus.x, overlay.x); assert.equal(afterFocus.y, overlay.y);
  assert(Math.abs(afterFocus.width - .3) < .001, "focus changes bounds without relocating the cursor");
  await emit({ ...pointer, kind: "click", x: .6, y: .2, bounds: undefined });
  const afterClick = await readOverlay();
  assert(Math.abs(afterClick.x - .6) < .001 && Math.abs(afterClick.y - .2) < .001, "actual click updates cursor geometry");
  await emit(pointer);
  assert.equal((await readOverlay()).x, afterClick.x, "focus after click preserves actual cursor position");
  await shot("pointer-readonly");
  await emit({ ...pointer, kind: "clear" });
  assert.equal(await frame.locator(".viewer-pointer, .viewer-focus-bounds").count(), 0, "clear removes both overlays");

  let controlId = await grant();
  const start = (await inputs()).length;
  await gesture("click", .25, .5, { detail: 1, metaKey: true });
  let first = (await inputs()).at(-1);
  assert.deepEqual({ ...first.input, x: .25, y: .5 }, { kind: "click", x: .25, y: .5, button: "left", clickCount: 1, modifiers: 2 });
  assert(Math.abs(first.input.x - .25) < .006 && Math.abs(first.input.y - .5) < .006, "click maps to decoded pixels within one CSS pixel");
  await gesture("mousemove", .1, .1); await gesture("mousemove", .2, .2); await gesture("mousemove", .3, .3);
  await gesture("wheel", .3, .3, { deltaY: 20 }); await gesture("wheel", .3, .3, { deltaY: 30 });
  await gesture("wheel", .4, .4, { deltaY: 15 });
  await page.keyboard.insertText("Привет"); await page.keyboard.insertText(" мир");
  assert.equal((await inputs()).length, start + 1, "only one input in flight");
  for (const patch of [{ inputId: first.inputId + 1 }, { controlId: "stale" }, { pageId: "other" }, { sessionId: "old" }]) {
    await emit({ ...first, type: "browser.viewer.inputResult", ok: true, ...patch });
    assert.equal((await inputs()).length, start + 1, "stale inputResult cannot advance queue");
  }
  await drain();
  assert.deepEqual((await inputs()).slice(start).map(message => message.input.kind), ["click", "move", "wheel", "wheel", "text"]);
  const queued = (await inputs()).slice(start);
  assert.equal(queued[1].input.x, .3); assert.equal(queued[2].input.deltaY, 50); assert.equal(queued[3].input.deltaY, 15);
  assert.equal(queued[4].input.text, "Привет мир");
  await emit(pointer); await emit({ ...pointer, kind: "move", x: .6, y: .4, bounds: undefined }); await shot("manual-control");

  const beforeLetterbox = (await inputs()).length;
  await gesture("click", .5, 1.05, { detail: 1 });
  await gesture("wheel", .5, 1.05, { deltaY: 80 });
  await gesture("mousemove", -.05, .5);
  assert.equal((await inputs()).length, beforeLetterbox, "letterbox gestures never reach remote page");
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 1100, height: 420 }); await settle(frame);
  await gesture("click", -.05, .5, { detail: 1 });
  assert.equal((await inputs()).length, beforeLetterbox, "side letterbox is excluded too");
  await gesture("click", .75, .25, { detail: 1 }); await drain();
  assert(Math.abs((await inputs()).at(-1).input.x - .75) < .006);
  await page.setViewportSize(originalViewport); await settle(frame);

  const beforeDouble = (await inputs()).length;
  await frame.locator(".viewer-stage").dblclick({ position: { x: 80, y: 70 } });
  await drain();
  assert.deepEqual((await inputs()).slice(beforeDouble).filter(message => message.input.kind === "click").map(message => message.input.clickCount), [1, 2], "double-click emits two down/up requests, not three");
  await frame.locator(".viewer-stage").click({ button: "right", position: { x: 80, y: 70 } }); await drain();
  assert.equal((await inputs()).at(-1).input.button, "right");

  await frame.evaluate(() => { window.fixtureBubbledKeys = []; window.addEventListener("keydown", event => window.fixtureBubbledKeys.push(event.key)); });
  await page.evaluate(() => { window.fixtureForwardedKeys = []; });
  const beforeKeys = (await inputs()).length;
  for (const options of [{ key: "ф", code: "KeyA", metaKey: true }, { key: "a", code: "KeyA", ctrlKey: true },
    { key: "z", code: "KeyZ", metaKey: true }, { key: "z", code: "KeyZ", metaKey: true, shiftKey: true }, { key: "y", code: "KeyY", ctrlKey: true },
    ...["Backspace", "Delete", "Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].map(key => ({ key }))]) {
    assert(await key(options), "remote editing keys prevent native document shortcuts"); await drain();
  }
  const keys = (await inputs()).slice(beforeKeys).map(message => message.input);
  assert.deepEqual(keys.slice(0, 5), [{ kind: "key", key: "a", modifiers: 2 }, { kind: "key", key: "a", modifiers: 2 },
    { kind: "key", key: "z", modifiers: 2 }, { kind: "key", key: "z", modifiers: 10 }, { kind: "key", key: "y", modifiers: 2 }]);
  assert(await key({ key: "p", code: "KeyP", metaKey: true }));
  assert.equal(await key({ key: "a", code: "KeyA", ctrlKey: true, altKey: true }), false, "AltGr printable input is not a remote shortcut");
  assert.deepEqual(await frame.evaluate(() => window.fixtureBubbledKeys), [], "captured keys do not reach the Element key forwarder");
  assert.deepEqual(await page.evaluate(() => window.fixtureForwardedKeys), [], "real Element wrapper does not forward remote shortcuts to IDE");
  assert(await proxy.evaluate(node => node === document.activeElement), "remote Tab retains proxy focus");

  const paste = "Я".repeat(1023) + "😀" + "文".repeat(1100) + "\nконец";
  const beforePaste = (await inputs()).length;
  await proxy.evaluate((node, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, paste);
  await drain();
  const chunks = (await inputs()).slice(beforePaste).map(message => message.input.text);
  assert.equal(chunks.join(""), paste); assert(chunks.every(chunk => chunk.length <= 1024 && !/[\uD800-\uDBFF]$/.test(chunk)));
  for (const inputType of ["insertFromComposition", "insertText"]) {
    const beforeComposition = (await inputs()).length;
    await proxy.evaluate((node, inputType) => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      node.value = "日本語";
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本語", inputType: "insertCompositionText", isComposing: true }));
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
      node.value = "日本語";
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本語", inputType }));
    }, inputType);
    await drain();
    assert.deepEqual((await inputs()).slice(beforeComposition).map(message => message.input), [{ kind: "text", text: "日本語" }], `IME ${inputType} commits once`);
  }
  const beforeNativeComposition = (await inputs()).length;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    assert.equal((await inputs()).length, beforeNativeComposition, "native Chromium composition stays local until commit");
    await cdp.send("Input.insertText", { text: "日本語" });
    await drain();
    assert.deepEqual((await inputs()).slice(beforeNativeComposition).map(message => message.input), [{ kind: "text", text: "日本語" }], "native Chromium IME commits once");
  } finally { await cdp.detach(); }
  assert.equal(await proxy.inputValue(), "", "proxy does not retain plaintext field values");

  await frame.getByRole("combobox").focus();
  assert.equal(await control.getAttribute("aria-pressed"), "true", "toolbar focus does not revoke control");
  const outside = await frame.getByRole("combobox").evaluate(node => {
    const event = new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true });
    node.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(outside, false, "no document-global keyboard capture");
  await proxy.focus(); await page.keyboard.press("Escape");
  assert.equal(await control.getAttribute("aria-pressed"), "false");
  assert(!(await proxy.evaluate(node => node === document.activeElement)));
  assert.equal((await messages()).filter(message => message.type === "viewer.control").at(-1).enabled, false);

  controlId = await grant();
  await gesture("click", .5, .5, { detail: 1 }); first = (await inputs()).at(-1);
  await page.keyboard.insertText("не повторять");
  await reply(first, { ok: false, message: "Не удалось выполнить ввод" });
  const afterError = (await inputs()).length;
  assert.equal(await control.getAttribute("aria-pressed"), "false");
  assert((await frame.getByRole("status").innerText()).includes("Не удалось выполнить ввод"));
  await reply(first); assert.equal((await inputs()).length, afterError, "late success never replays failed input");

  controlId = await grant();
  await gesture("click", .5, .5, { detail: 1 }); first = (await inputs()).at(-1);
  for (let i = 0; i < 33; i++) await key({ key: "ArrowDown" });
  assert.equal(await control.getAttribute("aria-pressed"), "false", "bounded queue stops on overflow");
  assert((await frame.getByRole("status").innerText()).includes("переполнена"));
  await reply(first);
  assert.equal((await inputs()).at(-1).inputId, first.inputId, "overflow does not replay queued edits");

  controlId = await grant();
  await gesture("click", .5, .5, { detail: 1 }); first = (await inputs()).at(-1);
  await frame.evaluate(() => window.fixtureInputTimeouts.at(-1)()); await settle(frame);
  assert.equal(await control.getAttribute("aria-pressed"), "false", "stuck input times out locally");
  await reply(first);

  controlId = await grant();
  await gesture("click", .5, .5, { detail: 1 }); first = (await inputs()).at(-1);
  await key({ key: "Enter" });
  await emit(viewerState({ controlId: "replacement-lease" }));
  assert.equal(await control.getAttribute("aria-pressed"), "false", "new lease cannot inherit local capture");
  await reply(first); assert.equal((await inputs()).at(-1).inputId, first.inputId);

  controlId = await grant();
  await emit(pointer);
  await emit(viewerState({ pageRevision: 1 }));
  await noImage("same-page navigation clears decoded frame");
  assert.equal(await frame.locator(".viewer-pointer, .viewer-focus-bounds").count(), 0);
  assert(await control.isDisabled());
  await sendFrame(++sequence); await noImage("old revision frame must be ignored");

  controlId = await grant();
  await emit(viewerState({ status: "paused" }));
  assert(await control.isDisabled());
  await emit(viewerState());
  assert(await control.isDisabled(), "resume waits for a fresh decoded ACK");
  controlId = await grant();
  await frame.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(frame);
  assert.equal(await control.getAttribute("aria-pressed"), "false");
  assert.equal((await messages()).filter(message => message.type === "viewer.control").at(-1).enabled, false);
  await frame.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await emit(viewerState());
  assert(await control.isDisabled(), "visibility recovery waits for a fresh decoded ACK");

  await grant();
  await emit(pointer);
  await emit({ type: "browser.viewer.frameClear", sessionId: "session-a", pageId: "page-a" });
  await noImage("frameClear clears image and pointer");
  assert.equal(await frame.locator(".viewer-pointer, .viewer-focus-bounds").count(), 0);
  await grant();
  const allInputs = await inputs();
  assert(allInputs.every((input, i) => Number.isInteger(input.inputId) && input.inputId > (i ? allInputs[i - 1].inputId : 0)), "input IDs remain positive and monotonic across leases");
  // Leave control active so the existing pause/select flow exercises explicit revocation.
}

async function runScenario(browser, scenario, jpeg) {
  const { wrapper, mode, theme, width, height } = scenario;
  const label = `${wrapper ? "element-http" : "production-html"}-${mode}-${width}x${height}-${theme}`;
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", colorScheme: theme });
  const errors = [], requests = [], blocked = [], expectedDiagnostics = [];
  let page;
  try {
    await context.addInitScript(({ wrapper, theme, tokens }) => {
      window.fixtureCsp = []; window.fixtureDecodeGates = []; window.fixtureInputTimeouts = [];
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, ms, ...args) => {
        if (ms === 10000) window.fixtureInputTimeouts.push(callback);
        return timeout(callback, ms, ...args);
      };
      window.addEventListener("securitypolicyviolation", event => window.fixtureCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
      // Hold an actual native decode to deterministically exercise session/page races.
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        const hold = window.fixtureHoldDecode;
        return decode.call(this).then(() => {
          if (hold) return new Promise(resolve => window.fixtureDecodeGates.push(resolve));
        });
      };
      if (wrapper) return;
      window.fixtureMessages = []; window.fixtureHostErrors = []; window.fixtureAcquires = 0;
      window.fixtureSend = data => window.postMessage(data, "*");
      window.acquireVsCodeApi = () => {
        if (++window.fixtureAcquires > 1) throw new Error("VS Code API acquired twice");
        return Object.freeze({ postMessage: message => window.fixtureMessages.push(structuredClone(message)) });
      };
      document.addEventListener("DOMContentLoaded", () => {
        document.body.classList.add(`vscode-${theme}`);
        for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--vscode-${key}`, value);
      });
    }, { wrapper, theme, tokens: themes[theme] });

    const contents = renderWebviewHtml({ extensionUri: { fsPath: root }, webview: {
      cspSource: origin, asWebviewUri: uri => `${origin}${prefix}/webview/theia-resource/file/plugin/${path.basename(uri.fsPath)}`
    }, scriptPath: "media/browser-viewer.js", stylePath: "media/browser-viewer.css", title: "Browser viewer smoke" });
    assert(contents.includes("__codexElementRunInlineFallback"), "build media/browser-viewer.js before running the smoke");
    const assets = new Map(["browser-viewer.js", "browser-viewer.css"].map(file => [file, fs.readFileSync(path.join(root, "media", file))]));
    const outer = wrapper ? hostHtml(contents, theme) : contents;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      requests.push(url.href);
      if (url.origin !== origin) { blocked.push(url.href); return route.abort(); }
      if (url.pathname === `${prefix}/`) return route.fulfill({ contentType: "text/html; charset=utf-8", body: outer });
      const file = path.basename(url.pathname);
      if (wrapper && ["index.html", "main.js", "host.js", "fake.html", "service-worker.js"].includes(file)) {
        return route.fulfill({ contentType: file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", body: fs.readFileSync(path.join(wrapperRoot, file)) });
      }
      if (assets.has(file)) {
        if (mode === "missing") return route.fulfill({ status: 404, body: "Fixture: external webview resource unavailable" });
        if (mode === "late") await delay(1400);
        return route.fulfill({ contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8", body: assets.get(file) });
      }
      blocked.push(url.href);
      return route.abort();
    });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text();
      const expected = (wrapper && text === "Service Workers are not enabled. Webviews will not work properly") ||
        (mode === "missing" && text.includes("404") && /browser-viewer\.(js|css)$/.test(message.location().url || ""));
      (expected ? expectedDiagnostics : errors).push(text);
    });
    await page.goto(`${origin}${prefix}/`);
    await page.waitForFunction(() => window.fixtureMessages?.some(message => message.type === "viewer.ready"));
    const frame = wrapper ? page.frames().find(frame => frame.url().includes("fake.html?id=viewer-probe")) : page.mainFrame();
    assert(frame, `${label}: actual nested wrapper iframe must exist`);
    if (wrapper) {
      const host = page.frames().find(candidate => candidate.url().includes("index.html?id=viewer-probe"));
      await host.locator("#active-frame").waitFor({ state: "visible" });
    }
    await frame.locator(".browser-viewer").waitFor();
    // The real wrapper's document.write removes listeners installed on its old document.
    // Reattach CSP observation to the active document for the interaction phase.
    if (wrapper) await frame.evaluate(() => window.addEventListener("securitypolicyviolation", event =>
      window.fixtureCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI })));
    assert.equal(await frame.evaluate(() => isSecureContext), false, "exercise the actual insecure HTTP deployment path");
    if (wrapper) assert.equal(await frame.evaluate(() => !!navigator.serviceWorker), false);
    const emit = async data => { await page.evaluate(data => window.fixtureSend(data), data); await settle(frame); };
    const messages = async () => { await settle(frame); return page.evaluate(() => window.fixtureMessages); };
    const ackCount = async () => (await messages()).filter(message => message.type === "viewer.ack").length;
    const waitAck = async (sequence, sessionId = "session-a", pageId = "page-a") => {
      await page.waitForFunction(({ sequence, sessionId, pageId }) => window.fixtureMessages.some(message =>
        message.type === "viewer.ack" && message.sequence === sequence && message.sessionId === sessionId && message.pageId === pageId), { sequence, sessionId, pageId });
    };
    const sendFrame = (sequence, patch = {}) => emit({ type: "browser.viewer.frame", sessionId: "session-a", pageId: "page-a", sequence, pageRevision: 0, data: jpeg, width: 960, height: 540, ...patch });
    const shot = async suffix => { await settle(frame); await fits(frame, `${label}/${suffix}`); await page.screenshot({ path: path.join(artifacts, `${label}-${suffix}.png`) }); };
    const noImage = async reason => { await settle(frame); assert.equal(await frame.locator(".viewer-frame").count(), 0, reason); };

    assert(await frame.getByRole("combobox").isDisabled());
    assert(await frame.getByRole("button", { name: "Приостановить просмотр" }).isDisabled());
    assert(await frame.getByRole("button", { name: "Включить управление" }).isDisabled());
    await shot("idle");
    await emit(viewerState({ status: "waiting", message: "Waiting for the agent page", pages: [], selectedPageId: "" }));
    assert.equal(await frame.getByRole("status").innerText(), "Waiting for the agent page");
    await noImage("waiting has no stale image");
    await emit(viewerState());
    assert(!await frame.getByRole("combobox").isDisabled());
    assert(!await frame.getByRole("button", { name: "Приостановить просмотр" }).isDisabled());
    assert(await frame.getByRole("button", { name: "Включить управление" }).isDisabled(), "no control before decoded ACK");
    assert.equal(await frame.locator(".viewer-address").getAttribute("title"), viewerState().pages[0].url);

    await frame.evaluate(() => { window.fixtureHoldDecode = true; });
    const acksBefore = await ackCount();
    await sendFrame(1);
    await frame.waitForFunction(() => window.fixtureDecodeGates.length === 1);
    assert.equal(await ackCount(), acksBefore, "ACK must wait for image decode");
    await noImage("undecoded image is not rendered");
    await frame.evaluate(() => { window.fixtureHoldDecode = false; window.fixtureDecodeGates.shift()(); });
    await waitAck(1);
    await frame.locator(".viewer-frame").waitFor();
    const image = await frame.locator(".viewer-frame").evaluate(async node => {
      await node.decode();
      const canvas = document.createElement("canvas"); canvas.width = node.naturalWidth; canvas.height = node.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(node, 0, 0);
      return { complete: node.complete, width: node.naturalWidth, height: node.naturalHeight,
        header: [...context.getImageData(8, 8, 1, 1).data], background: [...context.getImageData(8, 520, 1, 1).data],
        fit: getComputedStyle(node).objectFit, pointerEvents: getComputedStyle(node).pointerEvents, draggable: node.draggable };
    });
    assert(image.complete); assert.equal(image.width, 960); assert.equal(image.height, 540);
    assert(image.header.every((value, index) => Math.abs(value - [22, 62, 53, 255][index]) <= 5), "decoded pixels must include the fixture's green header");
    assert(image.background.every(value => value >= 250), "decoded pixels must include the fixture's white background");
    assert.equal(image.fit, "contain"); assert.equal(image.pointerEvents, "none"); assert.equal(image.draggable, false);
    await shot("live");

    await manualControlChecks({ page, frame, emit, messages, sendFrame, waitAck, shot, noImage });
    const pause = frame.getByRole("button", { name: /^(Приостановить|Возобновить) просмотр$/ }), pauseName = await pause.getAttribute("aria-label");
    assert(pauseName); assert.equal(await pause.getAttribute("title"), pauseName);
    await pause.click();
    await page.waitForFunction(() => window.fixtureMessages.some(message => message.type === "viewer.pause" && message.paused));
    assert.deepEqual((await messages()).filter(message => message.type === "viewer.pause").at(-1), { type: "viewer.pause", sessionId: "session-a", paused: true });
    await emit(viewerState({ status: "paused", message: "Viewer paused" }));
    const resumeName = await pause.getAttribute("aria-label");
    assert.notEqual(resumeName, pauseName);
    assert.equal(await frame.getByRole("status").innerText(), "Viewer paused");
    assert.equal(await frame.locator(".viewer-frame").count(), 1, "pause keeps the last decoded frame");
    await shot("paused");
    await pause.click();
    await page.waitForFunction(() => window.fixtureMessages.some(message => message.type === "viewer.pause" && message.paused === false));
    await emit(viewerState());

    await frame.getByRole("combobox").selectOption("page-b");
    await page.waitForFunction(() => window.fixtureMessages.some(message => message.type === "viewer.select" && message.pageId === "page-b"));
    assert.deepEqual((await messages()).filter(message => message.type === "viewer.select").at(-1), { type: "viewer.select", sessionId: "session-a", pageId: "page-b" });
    await emit(viewerState({ selectedPageId: "page-b" }));
    await noImage("page selection clears the previous image");
    const rejectedBefore = await ackCount();
    await sendFrame(2);
    await sendFrame(3, { sessionId: "old-session", pageId: "page-b" });
    await sendFrame(4, { pageId: "page-b", data: "A".repeat(512 * 1024 + 1) });
    await noImage("wrong page/session and oversized frames must be ignored");
    assert.equal(await ackCount(), rejectedBefore, "ignored frame envelopes must not generate ACKs");
    await sendFrame(5, { pageId: "page-b" });
    await waitAck(5, "session-a", "page-b");
    await frame.locator(".viewer-frame").waitFor();

    await emit(viewerState({ sessionId: "session-b", selectedPageId: "page-b" }));
    await noImage("sessionchange clears even when pageId is reused");
    await shot("sessionchange");
    await sendFrame(6, { pageId: "page-b" });
    await noImage("old-session frame cannot reappear");

    for (const [sequence, transition] of [[7, "session"], [8, "page"], [9, "idle"], [12, "revision"]]) {
      const before = viewerState({ sessionId: `race-${sequence}` });
      await emit(before);
      await frame.evaluate(() => { window.fixtureHoldDecode = true; });
      await sendFrame(sequence, { sessionId: before.sessionId });
      await frame.waitForFunction(() => window.fixtureDecodeGates.length === 1);
      const after = transition === "session" ? { ...before, sessionId: `next-${sequence}` } :
        transition === "page" ? { ...before, selectedPageId: "page-b" } : transition === "revision" ? { ...before, pageRevision: 1 } : { ...before, status: "idle", pages: [], selectedPageId: "" };
      await emit(after);
      await frame.evaluate(() => { window.fixtureHoldDecode = false; window.fixtureDecodeGates.shift()(); });
      await waitAck(sequence, before.sessionId);
      await noImage(`${transition} change must invalidate an in-flight decode`);
      assert(await frame.getByRole("button", { name: "Включить управление" }).isDisabled(), `${transition} clears decoded eligibility`);
    }

    await emit(viewerState());
    await sendFrame(10, { data: "/9j/AAAA" });
    await waitAck(10);
    await frame.locator(".viewer-status.viewer-error").waitFor();
    assert((await frame.getByRole("status").innerText()).trim());
    assert.equal(await pause.getAttribute("aria-label"), resumeName, "decode-error Play control must be labelled as resume");
    assert.equal(await pause.getAttribute("title"), resumeName);
    await pause.click();
    assert.equal((await messages()).filter(message => message.type === "viewer.pause").at(-1).paused, false, "decode failure offers recovery, not another pause");
    await sendFrame(11); await waitAck(11);
    await frame.locator(".viewer-frame").waitFor();
    assert.equal(await frame.locator(".viewer-error").count(), 0, "a valid frame clears decode error");
    await emit(viewerState({ status: "error", message: "Image unavailable. " + "Long diagnostic message. ".repeat(10) }));
    assert.equal(await frame.locator(".viewer-status.viewer-error").count(), 1);
    await shot("error");

    const controlsBefore = (await messages()).filter(message => ["viewer.pause", "viewer.select", "viewer.input"].includes(message.type)).length;
    await frame.locator(".viewer-stage").click();
    await page.keyboard.press("ArrowDown"); await page.keyboard.type("read-only"); await page.mouse.wheel(0, 120);
    await settle(frame);
    assert.equal((await messages()).filter(message => ["viewer.pause", "viewer.select", "viewer.input"].includes(message.type)).length, controlsBefore, "image gestures cannot control the browser");
    const readinessBefore = (await messages()).filter(message => message.type === "viewer.ready").length;
    assert.equal(readinessBefore, 2, "one mount plus the manual-control visibility recovery");
    await emit({ type: "browser.viewer.readyRequest" });
    await page.waitForFunction(count => window.fixtureMessages.filter(message => message.type === "viewer.ready").length === count + 1, readinessBefore);
    assert.equal((await messages()).filter(message => message.type === "viewer.ready").at(-1).visible, true);
    await frame.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.hidden;
    });
    await page.waitForFunction(count => window.fixtureMessages.filter(message => message.type === "viewer.ready").length === count + 2, readinessBefore);
    assert.deepEqual((await messages()).filter(message => ["viewer.visibility", "viewer.ready"].includes(message.type)).slice(-2),
      [{ type: "viewer.visibility", visible: false }, { type: "viewer.ready", visible: true }], "document reappearance must recover readiness after failed delivery");

    if (mode !== "missing") await frame.waitForFunction(() => document.readyState === "complete" &&
      performance.getEntriesByType("resource").some(entry => entry.name.endsWith("browser-viewer.js") && entry.responseEnd > 0));
    await frame.evaluate(() => { window.__codexElementRunInlineFallback(); window.__codexElementRunInlineFallback(); });
    await settle(frame);
    const bootstrap = await frame.evaluate(() => ({ mode: window.__codexElementWebviewAssetMode,
      fallbackStyles: document.querySelectorAll("style[data-codex-element-inline-fallback]").length,
      roots: document.querySelectorAll(".browser-viewer").length, csp: window.fixtureCsp, acquires: window.fixtureAcquires }));
    assert.equal(bootstrap.mode, mode === "external" ? "external" : "inline fallback");
    assert.equal(bootstrap.fallbackStyles, mode === "external" ? 0 : 1);
    assert.equal(bootstrap.roots, 1);
    assert.equal((await messages()).filter(message => message.type === "viewer.ready").length, readinessBefore + 2, "fallback retries must not add another mount after recovery");
    if (!wrapper) assert.equal(bootstrap.acquires, 1);
    assert.deepEqual(bootstrap.csp, [], "production CSP must remain intact");
    assert((await messages()).every(message => allowedMessages.has(message.type)), "only the allowlisted viewer protocol is emitted");
    assert.deepEqual(await page.evaluate(() => window.fixtureHostErrors), [], "no errors forwarded through the real VS Code API");
    assert.deepEqual(errors, [], "no unexpected browser errors");
    assert.deepEqual(blocked, [], "no external or unrecognized network requests");
    await emit(viewerState({ status: "idle", sessionId: "", pages: [], selectedPageId: "", message: "Agent browser stopped" }));
    await noImage("stopping the session clears the final frame");
    await fits(frame, `${label}/stopped`);
    fs.rmSync(path.join(artifacts, `${label}-FAILED.png`), { force: true });
    console.log(`PASS ${label}: decoded JPEG/ACK, controls, stale-decode isolation, layout, bootstrap; ${requests.length} local requests, ${expectedDiagnostics.length} expected HTTP diagnostics`);
    return { label, status: "passed", requests: requests.length, expectedDiagnostics };
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, `${label}-FAILED.png`) }).catch(() => {});
    console.error(`FAIL ${label}: ${error.stack}`);
    return { label, status: "failed", error: error.stack, errors, blocked };
  } finally { await context.close(); }
}

async function main() {
  assert.notEqual(process.platform, "win32", "run this browser smoke on a Unix workstation/CI host");
  if (!skipWrapper) for (const file of ["index.html", "main.js", "host.js", "fake.html"]) {
    assert(fs.existsSync(path.join(wrapperRoot, file)), `Missing actual Element wrapper ${file}. Set ELEMENT_WEBVIEW_PRE, or CODEX_TEST_SKIP_ELEMENT_WRAPPER=1 for general CI checks.`);
  }
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CODEX_TEST_BROWSER_CHANNEL === "bundled" ? {} : { channel: process.env.CODEX_TEST_BROWSER_CHANNEL || "chrome" }) });
  const results = [];
  try {
    const jpeg = await makeJpeg(browser);
    for (const wrapper of skipWrapper ? [false] : [true, false]) for (const mode of ["external", "missing", "late"]) {
      for (const size of sizes) for (const theme of ["light", "dark"]) {
        const label = `${wrapper ? "element-http" : "production-html"}-${mode}-${size.width}x${size.height}-${theme}`;
        if (process.env.CODEX_TEST_VIEWER_FILTER && !label.includes(process.env.CODEX_TEST_VIEWER_FILTER)) continue;
        results.push(await runScenario(browser, { wrapper, mode, theme, ...size }, jpeg));
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(artifacts, skipWrapper ? "results-ci.json" : "results.json"), JSON.stringify({ wrapperRoot: skipWrapper ? null : wrapperRoot, skippedWrapper: skipWrapper, results }, null, 2) + "\n");
  if (skipWrapper) console.log("SKIP actual Element wrappers: CODEX_TEST_SKIP_ELEMENT_WRAPPER=1; general production HTML checks still ran.");
  const failures = results.filter(result => result.status === "failed");
  console.log(`${results.length - failures.length}/${results.length} browser-viewer scenarios passed. Screenshots: ${artifacts}`);
  assert.equal(failures.length, 0, failures.map(result => result.label).join(", "));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

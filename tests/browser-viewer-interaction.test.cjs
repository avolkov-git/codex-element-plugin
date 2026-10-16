const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");
const { root, loadSource } = require("./service-test-utils.cjs");

const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function fakeClock() {
  let now = 10000, id = 0;
  const timers = new Map();
  return {
    timers, Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) { const timer = { id: ++id, at: now + ms, callback, unref() {} }; timers.set(id, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer?.id); },
    async advance(ms) {
      const end = now + ms;
      let count = 0;
      while (true) {
        const timer = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        assert(++count < 10000);
        now = timer.at; timers.delete(timer.id); timer.callback(); await settle();
      }
      now = end; await settle();
    },
  };
}

function loadInteraction(clock) {
  const filename = path.join(root, "src/browserViewerInteraction.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(output, { module, exports: module.exports, console,
    require: name => name === "./browserViewerProtocol" ? loadSource("src/browserViewerProtocol.ts") : localRequire(name), ...clock }, { filename });
  return module.exports;
}

function fixture(t, options = {}) {
  const clock = fakeClock(), calls = [], messages = [], bindings = new Map(), scripts = [], evaluations = [];
  let active = true, disposedScripts = 0;
  const main = { evaluate: async script => { evaluations.push(script); return options.evaluate?.(script); } };
  const frames = [main];
  const page = {
    isClosed: () => false, viewportSize: () => options.viewport === undefined ? { width: 1000, height: 500 } : options.viewport,
    mainFrame: () => main, frames: () => frames,
    exposeBinding: async (name, callback) => { bindings.set(name, callback); },
    addInitScript: async script => { scripts.push(script); return options.addInitScript ? options.addInitScript() : { dispose: async () => { disposedScripts++; } }; },
  };
  const session = { send: async (method, params) => { calls.push({ method, params: params && plain(params) }); return options.send ? options.send(method, params) : {}; } };
  const { BrowserViewerInteraction } = loadInteraction(clock);
  const interaction = new BrowserViewerInteraction(page, { active: () => active, session: async () => session, send: message => messages.push(plain(message)) });
  interaction.setControl("lease");
  let nextId = 0;
  const input = async value => { interaction.input({ controlId: "lease", inputId: ++nextId, input: value }); await settle(); };
  const start = async () => { interaction.start(); await settle(); };
  const emit = async (value, frame = main) => {
    const binding = [...bindings.values()][0], source = { page, frame };
    const ready = await binding(source, { kind: "ready" });
    await binding(source, { epoch: ready.epoch, ...value });
    await settle();
  };
  t.after(async () => { await interaction.dispose(); await settle(); });
  return { clock, calls, messages, bindings, scripts, evaluations, main, frames, page, interaction, input, start, emit,
    pointers: () => messages.filter(message => message.type === "pointer"),
    setActive(value) { active = value; interaction.invalidate(); }, get disposedScripts() { return disposedScripts; } };
}

test("input maps CSS viewport points and selects only explicit CDP fields", async t => {
  const f = fixture(t);
  await f.input({ kind: "move", x: 0.5, y: 0.25, type: "mousePressed", buttons: 1, commands: ["untrusted"] });
  await f.input({ kind: "wheel", x: 1, y: 1, deltaX: -3, deltaY: 120, type: "mousePressed" });
  for (const button of ["left", "right", "middle"]) {
    for (const clickCount of [1, 2]) await f.input({ kind: "click", x: 0.2, y: 0.3, button, clickCount, modifiers: 8 });
  }
  assert.deepEqual(f.calls[0], { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 500, y: 125, button: "none", buttons: 0 } });
  assert.deepEqual(f.calls[1].params, { type: "mouseWheel", x: 999, y: 499, deltaX: -3, deltaY: 120, modifiers: 0 });
  assert.equal(f.calls.length, 14, "each click, including detail=2, is exactly one down/up pair");
  for (let index = 2; index < f.calls.length; index += 2) {
    const down = f.calls[index].params, up = f.calls[index + 1].params;
    assert.equal(down.type, "mousePressed"); assert.equal(up.type, "mouseReleased");
    assert.equal(down.buttons, { left: 1, right: 2, middle: 4 }[down.button]);
    assert.equal(up.buttons, 0); assert.equal(down.clickCount, up.clickCount);
    assert.equal(up.modifiers, 8); assert.equal(down.x, 200); assert.equal(down.y, 150);
  }
  assert(f.messages.every(message => message.ok));
});

test("key input uses explicit key/code/VK and pairs every supported key with keyUp", async t => {
  const f = fixture(t);
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  for (const [key, code] of Object.entries(codes)) {
    await f.input({ kind: "key", key, modifiers: 0 });
    const [down, up] = f.calls.slice(-2).map(call => call.params);
    assert.equal(down.code, key); assert.equal(down.key, key); assert.equal(down.windowsVirtualKeyCode, code);
    assert.equal(down.type, key === "Enter" ? "keyDown" : "rawKeyDown");
    assert.equal(up.type, "keyUp"); assert.equal(up.modifiers, 0);
    if (key === "Enter") assert.equal(down.text, "\r");
  }
  for (const [key, command] of [["a", "selectAll"], ["z", "undo"], ["y", "redo"]]) {
    await f.input({ kind: "key", key, modifiers: 2, commands: ["untrusted"], text: "private" });
    const down = f.calls.at(-2).params;
    assert.deepEqual(down.commands, [command]); assert.equal(down.text, undefined);
    assert.equal(down.code, `Key${key.toUpperCase()}`); assert.equal(down.modifiers, 2);
  }
  await f.input({ kind: "key", key: "z", modifiers: 10 });
  assert.deepEqual(f.calls.at(-2).params.commands, ["redo"]);
  await f.input({ kind: "text", text: "\u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80", commands: ["untrusted"] });
  assert.deepEqual(f.calls.at(-1), { method: "Input.insertText", params: { text: "\u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80" } });
});

test("null viewport uses CSS metrics, not screenshot or deprecated device-pixel metrics", async t => {
  const f = fixture(t, { viewport: null, send: method => method === "Page.getLayoutMetrics"
    ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 }, visualViewport: { clientWidth: 1600, clientHeight: 1200 } } : {} });
  await f.input({ kind: "move", x: 0.5, y: 0.25 });
  assert.equal(f.calls[0].method, "Page.getLayoutMetrics");
  assert.equal(f.calls[1].params.x, 400); assert.equal(f.calls[1].params.y, 150);
});

test("unresolved metrics remain single-flight and cannot dispatch input after lease retirement", async t => {
  const pending = deferred(), f = fixture(t, { viewport: null, send: () => pending.promise });
  await f.input({ kind: "move", x: 0.5, y: 0.5 });
  for (let i = 0; i < 100; i++) await f.input({ kind: "move", x: 0.2, y: 0.2 });
  await f.clock.advance(30000);
  assert.equal(f.calls.length, 1);
  f.interaction.setControl("");
  pending.resolve({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } });
  await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.messages.at(-1).ok, false);
});

test("failed down still releases and a failed up gets one bounded cleanup retry", async t => {
  let releases = 0;
  const f = fixture(t, { send: (_method, params) => {
    if (params.type === "mousePressed" || (params.type === "mouseReleased" && ++releases === 1)) throw new Error("private browser error");
    return {};
  } });
  await f.input({ kind: "click", x: 0.5, y: 0.5, button: "left", clickCount: 1, modifiers: 0 });
  assert.deepEqual(f.calls.map(call => call.params.type), ["mousePressed", "mouseReleased", "mouseReleased"]);
  assert.deepEqual(f.messages, [{ type: "input.result", controlId: "lease", inputId: 1, ok: false }]);
});

test("pointer observation is independent of the manual lease, sanitized and paced to 10/s", async t => {
  const f = fixture(t); f.interaction.setControl(""); await f.start();
  await f.emit({ kind: "move", x: 0, y: 0.1, value: "secret" });
  for (let i = 1; i <= 100; i++) await f.emit({ kind: "move", x: i / 100, y: 0.1, value: "secret" });
  assert.equal(f.pointers().length, 1);
  await f.clock.advance(99); assert.equal(f.pointers().length, 1);
  await f.clock.advance(1); assert.equal(f.pointers().length, 2);
  assert.deepEqual(f.pointers()[1], { type: "pointer", kind: "move", x: 1, y: 0.1 });
  await f.emit({ kind: "focus", x: 0.2, y: 0.3, bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.2, text: "secret" } });
  await f.clock.advance(100);
  assert.deepEqual(f.pointers().at(-1).bounds, { x: 0.1, y: 0.2, width: 0.20000000000000004, height: 0.2 });
  assert(!JSON.stringify(f.messages).includes("secret")); assert.equal(f.calls.length, 0);
  assert.equal(f.scripts.length, 1); assert.equal(f.evaluations.length, 1);
  await f.emit({ kind: "move", x: NaN, y: 0 });
  await f.emit({ kind: "focus", x: 0, y: 0, bounds: { x: 0, y: 0, width: -1, height: 1 } });
  await f.clock.advance(100);
  assert.equal(f.pointers().length, 3);
});

test("iframe geometry excludes borders and accounts for axis-aligned scaling", async t => {
  const f = fixture(t); await f.start(); let disposed = 0;
  const frame = { frameElement: async () => ({
    boundingBox: async () => ({ x: 100, y: 50, width: 480, height: 280 }),
    evaluate: async callback => callback({ clientLeft: 20, clientTop: 20, clientWidth: 200, clientHeight: 100, offsetWidth: 240, offsetHeight: 140 }),
    dispose: async () => { disposed++; },
  }) };
  f.frames.push(frame);
  await f.emit({ kind: "focus", x: 0.5, y: 0.5, bounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, frame);
  const pointer = f.pointers().at(-1);
  assert.equal(pointer.x, 0.34); assert.equal(pointer.y, 0.38);
  assert(Math.abs(pointer.bounds.x - 0.24) < 1e-10); assert(Math.abs(pointer.bounds.y - 0.28) < 1e-10);
  assert(Math.abs(pointer.bounds.width - 0.2) < 1e-10); assert(Math.abs(pointer.bounds.height - 0.2) < 1e-10);
  assert.equal(disposed, 1);
});

test("an unresolved iframe lookup never accumulates RPCs and stale mapping cannot escape", async t => {
  const pending = deferred(), f = fixture(t); await f.start(); let lookups = 0, disposed = 0;
  const frame = { frameElement: async () => { lookups++; return { boundingBox: () => pending.promise,
    dispose: async () => { disposed++; }, evaluate: async () => assert.fail("retired frame must not be evaluated") }; } };
  f.frames.push(frame);
  await f.emit({ kind: "move", x: 0.1, y: 0.2 }, frame);
  for (let i = 0; i < 200; i++) await f.emit({ kind: "move", x: 0.3, y: 0.4 }, frame);
  await f.clock.advance(30000); assert.equal(lookups, 1);
  f.interaction.refreshObservation();
  pending.resolve({ x: 0, y: 0, width: 100, height: 100 }); await settle();
  assert.equal(disposed, 1); assert.equal(lookups, 1);
  assert(f.pointers().every(pointer => pointer.kind === "clear"));
});

function browserWorld(f) {
  const listeners = new Map();
  const target = name => ({
    addEventListener(type, callback, options) { assert.equal(options.capture, true); assert.equal(options.passive, true); listeners.set(`${name}:${type}`, callback); },
    removeEventListener(type, callback) { assert.equal(listeners.get(`${name}:${type}`), callback); listeners.delete(`${name}:${type}`); },
  });
  const document = target("document"), window = target("window");
  for (const [name, callback] of f.bindings) window[name] = value => callback({ page: f.page, frame: f.main }, value);
  const context = vm.createContext({ window, document, innerWidth: 1000, innerHeight: 500, ...f.clock });
  return { context, window, listeners, run: script => vm.runInContext(script, context),
    event(type, fields = {}) { listeners.get(`${type === "resize" ? "window" : "document"}:${type}`)?.({ type, isTrusted: true, ...fields }); } };
}

test("injected listeners observe pointer/fill geometry without reading text or mutating DOM", async t => {
  const f = fixture(t); await f.start(); const world = browserWorld(f);
  world.run(f.scripts[0]); await settle();
  assert.equal(world.listeners.size, 7);
  const field = { getBoundingClientRect: () => ({ x: 100, y: 50, width: 200, height: 40 }),
    get value() { assert.fail("field value read"); }, get textContent() { assert.fail("text read"); }, focus() { assert.fail("page focus changed"); } };
  world.event("focusin", { target: field }); await settle();
  assert.deepEqual(f.pointers()[0], { type: "pointer", kind: "focus", x: 0.2, y: 0.14,
    bounds: { x: 0.1, y: 0.1, width: 0.19999999999999998, height: 0.07999999999999999 } });
  for (const type of ["scroll", "resize", "focusout"]) {
    world.event(type); await f.clock.advance(100);
    assert.equal(f.pointers().at(-1).kind, "clear");
    world.event("input", { target: field }); await f.clock.advance(100);
    assert.equal(f.pointers().at(-1).kind, "focus", "fill of an already focused field must refresh its marker");
  }
  world.event("pointermove", { clientX: 300, clientY: 200 });
  for (let i = 0; i < 200; i++) world.event("pointermove", { clientX: i, clientY: 100 });
  await f.clock.advance(100);
  assert.equal(f.pointers().at(-1).x, 0.199);
  world.event("pointerdown", { clientX: 400, clientY: 250 }); await f.clock.advance(100);
  assert.equal(f.pointers().at(-1).kind, "click");
  const trustedCount = f.pointers().length;
  for (const type of ["pointermove", "pointerdown", "focusin", "input", "scroll", "resize", "focusout"]) {
    world.event(type, { target: field, clientX: 900, clientY: 400, isTrusted: false });
    await f.clock.advance(100);
  }
  assert.equal(f.pointers().length, trustedCount, "page-authored events must not impersonate browser input");
  world.run(f.scripts[0]); await settle(); assert.equal(world.listeners.size, 7, "reinstallation must be idempotent");
  await f.interaction.dispose(); await settle();
  world.run(f.evaluations.at(-1)); assert.equal(world.listeners.size, 0);
  const future = browserWorld(f); future.run(f.scripts[0]); await settle();
  assert.equal(future.listeners.size, 0, "non-removable init scripts must self-retire in future documents");
  assert.equal(f.disposedScripts, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("injected binding calls have one unresolved send and one coalesced pending sample", async t => {
  const f = fixture(t); await f.start(); const world = browserWorld(f), pending = deferred();
  let calls = 0;
  const name = [...f.bindings.keys()][0], original = world.window[name];
  world.window[name] = value => { if (value.kind === "ready") return original(value); calls++; return pending.promise; };
  world.run(f.scripts[0]); await settle();
  for (let i = 0; i < 200; i++) world.event("pointermove", { clientX: i, clientY: 100 });
  await f.clock.advance(30000); assert.equal(calls, 1);
  pending.resolve({ alive: false }); await settle();
  assert.equal(calls, 1); assert.equal(world.listeners.size, 0); assert.equal(f.clock.timers.size, 0);
});

test("pause drops a trailing sample and resume does not resurrect it", async t => {
  const f = fixture(t); await f.start();
  await f.emit({ kind: "move", x: 0.1, y: 0.2 });
  await f.emit({ kind: "click", x: 0.3, y: 0.4 });
  f.setActive(false); await f.clock.advance(1000);
  f.setActive(true); await f.clock.advance(1000);
  assert.equal(f.pointers().length, 1);
  await f.emit({ kind: "move", x: 0.5, y: 0.6 });
  assert.equal(f.pointers().length, 2);
});

test("late init registration is disposed after hook retirement", async t => {
  const pending = deferred(); let disposed = 0;
  const f = fixture(t, { addInitScript: () => pending.promise }); await f.start();
  await f.interaction.dispose();
  pending.resolve({ dispose: async () => { disposed++; } }); await settle();
  assert.equal(disposed, 1);
  assert(f.evaluations.every(script => script.includes("?.stop()")));
});

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert(Date.now() < deadline, `timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("real Chromium: scaled bordered iframe focus/fill, atomic input and retired browser usability", { timeout: 20000 }, async t => {
  const { chromium } = require("playwright");
  if (!fs.existsSync(chromium.executablePath())) { t.skip("install the bundled Playwright Chromium to run the real-browser fixture"); return; }
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`<style>body{margin:0;height:2000px}iframe{position:absolute;left:100px;top:80px;width:300px;height:180px;border:10px solid black;transform:scale(1.5);transform-origin:top left}</style>
    <button style="position:absolute;left:700px;top:30px;width:100px;height:40px">Target</button>
    <iframe srcdoc='<style>body{margin:0}input{position:absolute;left:20px;top:30px;width:120px;height:40px;box-sizing:border-box}</style><input>'></iframe>
    <script>window.clicks=[];window.doubles=0;document.querySelector('button').onclick=e=>window.clicks.push(e.detail);document.querySelector('button').ondblclick=()=>window.doubles++;</script>`);
  const markup = await page.content(), messages = [];
  const session = await page.context().newCDPSession(page);
  const { BrowserViewerInteraction } = loadSource("src/browserViewerInteraction.ts");
  const interaction = new BrowserViewerInteraction(page, { active: () => true, session: async () => session, send: message => messages.push(plain(message)) });
  t.after(async () => { await interaction.dispose(); await session.detach().catch(() => {}); });
  interaction.start();
  for (const frame of page.frames()) {
    await frame.waitForFunction(() => Object.keys(window).some(key => key.startsWith("__codexViewer_") && key.endsWith("_state")));
  }
  const field = page.frameLocator("iframe").locator("input");
  await field.fill("agent private input");
  await until(() => messages.some(message => message.type === "pointer" && message.kind === "focus"), "iframe focus pointer");
  const pointer = messages.filter(message => message.type === "pointer" && message.kind === "focus").at(-1);
  const box = await field.boundingBox();
  for (const [name, size] of [["x", 1000], ["y", 700], ["width", 1000], ["height", 700]]) {
    assert(Math.abs(pointer.bounds[name] * size - box[name]) < 1.5, `iframe ${name} must match actual main-viewport geometry`);
  }
  assert(!JSON.stringify(messages).includes("agent private"));
  assert.equal(await page.content(), markup, "observer must not mutate the DOM");
  interaction.setControl("real-lease"); let inputId = 0;
  const input = async value => {
    const id = ++inputId;
    interaction.input({ controlId: "real-lease", inputId: id, input: value });
    await until(() => messages.some(message => message.type === "input.result" && message.inputId === id), "input result");
    assert.equal(messages.find(message => message.type === "input.result" && message.inputId === id).ok, true);
  };
  await input({ kind: "key", key: "a", modifiers: 2 });
  const unicode = "\u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80";
  await input({ kind: "text", text: unicode }); assert.equal(await field.inputValue(), unicode);
  await input({ kind: "key", key: "z", modifiers: 2 }); assert.notEqual(await field.inputValue(), unicode);
  await input({ kind: "key", key: "y", modifiers: 2 }); assert.equal(await field.inputValue(), unicode);
  for (const clickCount of [1, 2]) await input({ kind: "click", x: 0.75, y: 0.07, button: "left", clickCount, modifiers: 0 });
  assert.deepEqual(await page.evaluate(() => window.clicks), [1, 2]);
  assert.equal(await page.evaluate(() => window.doubles), 1);
  await field.fill("agent fill again");
  await until(() => messages.at(-1)?.kind === "focus", "refreshed fill bounds");
  await page.evaluate(() => window.scrollTo(0, 50));
  await until(() => messages.at(-1)?.kind === "clear", "scroll clears focus bounds");
  await interaction.dispose();
  const count = messages.length;
  await page.mouse.click(750, 15);
  await field.fill("browser still usable");
  await page.goto("data:text/html,<input>");
  await page.locator("input").fill("after navigation");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(messages.length, count, "retired listeners must not report across future navigation");
  assert.equal(await page.locator("input").inputValue(), "after navigation");
});

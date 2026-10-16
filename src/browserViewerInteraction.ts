import { randomUUID } from "crypto";
import type { Page, Frame, CDPSession } from "playwright";
import { BrowserViewerInput, isViewerInput } from "./browserViewerProtocol";

interface InteractionHost {
  active(): boolean;
  session(): Promise<CDPSession | undefined>;
  send(message: object): void;
}
interface Point { x: number; y: number }
interface Bounds extends Point { width: number; height: number }
interface FrameElementMetrics { clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number; offsetWidth: number; offsetHeight: number }
interface PointerSample extends Point {
  kind: "move" | "click" | "focus" | "clear";
  bounds?: Bounds;
  epoch: number;
}

const keyCodes: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};
const unit = (n: number): number => Math.max(0, Math.min(1, n));

async function viewport(page: Page, session: CDPSession): Promise<{ width: number; height: number }> {
  const size = page.viewportSize();
  if (size && size.width > 0 && size.height > 0) return size;
  const metrics = await session.send("Page.getLayoutMetrics");
  const css = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  if (!css || !Number.isFinite(css.clientWidth) || !Number.isFinite(css.clientHeight) || css.clientWidth <= 0 || css.clientHeight <= 0) {
    throw new Error("Viewer viewport unavailable");
  }
  return { width: css.clientWidth, height: css.clientHeight };
}

/** Does not bring pages forward, switch the MCP active page, or use Playwright input state. */
export class BrowserViewerInteraction {
  private controlId = "";
  private epoch = 0;
  private lastInputId = -1;
  private busy = false;
  private retired = false;
  private held?: { release(): Promise<unknown>; pending?: Promise<void> };
  private readonly observer: PointerObserver;

  constructor(private readonly page: Page, private readonly host: InteractionHost) {
    this.observer = new PointerObserver(page, host);
  }

  start(): void { this.observer.start(); }

  setControl(controlId: string): void {
    if (controlId === this.controlId) return;
    this.revoke();
    if (!this.retired && this.host.active() && controlId.length <= 128) this.controlId = controlId;
  }

  private release(): Promise<void> {
    const held = this.held;
    if (!held) return Promise.resolve();
    // Revoke can arrive while the down RPC is unresolved. Queue its matching up
    // on the same CDP session immediately, without waiting for that RPC's reply.
    return held.pending ??= (async () => {
      try { await held.release(); }
      catch { await held.release(); }
      finally { if (this.held === held) this.held = undefined; }
    })();
  }

  private revoke(): void {
    this.controlId = ""; this.lastInputId = -1; this.epoch++;
    void this.release().catch(() => {});
  }

  invalidate(clear = false): void {
    this.revoke();
    this.observer.invalidate(clear);
  }

  refreshObservation(): void { this.observer.invalidate(true); }

  dispose(): Promise<void> {
    this.retired = true;
    this.revoke();
    this.observer.dispose();
    return this.release().catch(() => {});
  }

  input(message: { controlId?: unknown; inputId?: unknown; input?: unknown }): void {
    const { controlId, inputId, input } = message;
    if (typeof controlId !== "string" || !controlId || controlId.length > 128 || !Number.isSafeInteger(inputId) || Number(inputId) < 0) return;
    const result = (ok: boolean): void => {
      if (!this.retired) this.host.send({ type: "input.result", controlId, inputId, ok });
    };
    if (this.retired || !this.host.active() || controlId !== this.controlId || !isViewerInput(input) || Number(inputId) <= this.lastInputId || this.busy) {
      result(false); return;
    }
    this.lastInputId = Number(inputId);
    this.busy = true;
    const epoch = this.epoch;
    const valid = (): boolean => !this.retired && !this.page.isClosed() && this.host.active() && epoch === this.epoch && controlId === this.controlId;
    void (async () => {
      let ok = false;
      try {
        const session = await this.host.session();
        if (session && valid()) {
          await this.execute(session, input, valid);
          ok = valid();
        }
      } catch { /* Input payloads and browser exceptions must never reach logs. */ }
      finally {
        try { await this.release(); } catch { ok = false; }
        this.busy = false;
        result(ok && valid());
      }
    })();
  }

  private async execute(session: CDPSession, input: BrowserViewerInput, valid: () => boolean): Promise<void> {
    const check = (): void => { if (!valid()) throw new Error("Viewer control retired"); };
    check();
    if (input.kind === "text") {
      await session.send("Input.insertText", { text: input.text });
      return;
    }
    if (input.kind === "key") {
      const letter = /^[a-z]$/.test(input.key);
      const key = letter && (input.modifiers & 8) ? input.key.toUpperCase() : input.key;
      const params = { key, code: letter ? `Key${input.key.toUpperCase()}` : input.key,
        windowsVirtualKeyCode: letter ? input.key.toUpperCase().charCodeAt(0) : keyCodes[input.key], modifiers: input.modifiers };
      const text = input.modifiers & 7 ? "" : input.key === "Enter" ? "\r" : letter ? key : "";
      // Explicit editing commands make normalized Ctrl shortcuts work on macOS too.
      const command = input.modifiers === 2 ? ({ a: "selectAll", z: "undo", y: "redo" } as Record<string, string>)[input.key]
        : input.modifiers === 10 && input.key === "z" ? "redo" : undefined;
      this.held = { release: () => session.send("Input.dispatchKeyEvent", { ...params, type: "keyUp", modifiers: 0 }) };
      try {
        check();
        await session.send("Input.dispatchKeyEvent", { ...params, type: text ? "keyDown" : "rawKeyDown",
          ...(text ? { text, unmodifiedText: text } : {}), ...(command ? { commands: [command] } : {}) });
      } finally { await this.release(); }
      return;
    }
    const size = await viewport(this.page, session);
    check();
    const point = { x: Math.min(input.x * size.width, size.width - 1), y: Math.min(input.y * size.height, size.height - 1) };
    if (input.kind === "move") {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", buttons: 0 });
    } else if (input.kind === "wheel") {
      await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: 0 });
    } else {
      const params = { ...point, button: input.button, clickCount: input.clickCount, modifiers: input.modifiers };
      this.held = { release: () => session.send("Input.dispatchMouseEvent", { ...params, type: "mouseReleased", buttons: 0 }) };
      try {
        await session.send("Input.dispatchMouseEvent", { ...params, type: "mousePressed", buttons: { left: 1, right: 2, middle: 4 }[input.button] });
      } finally { await this.release(); }
    }
  }
}

// Kept as browser JavaScript because this Node-only project intentionally omits
// DOM types. The only observed data is geometry; no values, labels or text.
function observerScript(binding: string, state: string): string {
  return `(() => {
    const binding = ${JSON.stringify(binding)}, state = ${JSON.stringify(state)};
    if (window[state]) return window[state].refresh();
    let alive = true, active = false, epoch = -1, pending, timer, busy = false, lastAt = 0, revision = 0;
    const clamp = n => Math.max(0, Math.min(1, n));
    const listeners = [];
    const stop = () => {
      alive = false; active = false; pending = undefined; clearTimeout(timer);
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
    };
    const flush = async () => {
      clearTimeout(timer); timer = undefined;
      if (!alive || !active || busy || !pending) return;
      const delay = 100 - (Date.now() - lastAt);
      if (delay > 0) { timer = setTimeout(flush, delay); return; }
      const sample = pending; pending = undefined; busy = true; lastAt = Date.now();
      try {
        const reply = await window[binding]({ ...sample, epoch });
        if (!reply || !reply.alive) stop();
      } catch { stop(); }
      finally { busy = false; if (alive) flush(); }
    };
    const observe = event => {
      if (!alive || !active || !event.isTrusted || innerWidth <= 0 || innerHeight <= 0) return;
      let sample;
      if (["scroll", "resize", "focusout"].includes(event.type)) {
        sample = { kind: "clear", x: 0, y: 0 };
      } else if (event.type === "focusin" || event.type === "input") {
        const target = event.composedPath ? event.composedPath()[0] : event.target;
        if (!target || typeof target.getBoundingClientRect !== "function") return;
        const box = target.getBoundingClientRect();
        const x = clamp(box.x / innerWidth), y = clamp(box.y / innerHeight);
        const width = Math.max(0, clamp((box.x + box.width) / innerWidth) - x);
        const height = Math.max(0, clamp((box.y + box.height) / innerHeight) - y);
        if (!width || !height) return;
        sample = { kind: "focus", x: x + width / 2, y: y + height / 2, bounds: { x, y, width, height } };
      } else {
        sample = { kind: event.type === "pointerdown" ? "click" : "move", x: clamp(event.clientX / innerWidth), y: clamp(event.clientY / innerHeight) };
      }
      pending = sample; flush();
    };
    const refresh = async () => {
      const current = ++revision;
      pending = undefined; active = false; clearTimeout(timer);
      try {
        const reply = await window[binding]({ kind: "ready" });
        if (!alive || current !== revision) return;
        if (!reply || !reply.alive) { stop(); return; }
        epoch = reply.epoch; active = reply.active;
      } catch { stop(); }
    };
    window[state] = { stop, refresh };
    for (const type of ["pointermove", "pointerdown", "focusin", "input", "scroll", "focusout", "resize"]) {
      const target = type === "resize" ? window : document;
      target.addEventListener(type, observe, { capture: true, passive: true });
      listeners.push([target, type, observe]);
    }
    return refresh();
  })()`;
}

class PointerObserver {
  private readonly binding = `__codexViewer_${randomUUID().replace(/-/g, "")}`;
  private readonly state = `${this.binding}_state`;
  private retired = false;
  private started = false;
  private ready = false;
  private epoch = 0;
  private lastAt = 0;
  private busy = false;
  private syncing = false;
  private syncAgain = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { frame: Frame; sample: PointerSample; epoch: number };
  private init?: { dispose(): Promise<void> };
  private bindingHandle?: { dispose(): Promise<void> };

  constructor(private readonly page: Page, private readonly host: InteractionHost) {}

  start(): void {
    if (this.started || this.retired) return;
    this.started = true;
    void (async () => {
      const exposed = await this.page.exposeBinding(this.binding, (source, value: unknown) => {
        const reply = { alive: !this.retired, active: this.host.active(), epoch: this.epoch };
        if (this.retired || !this.host.active() || source.page !== this.page || !value || typeof value !== "object") return reply;
        const sample = value as PointerSample;
        if (sample.epoch !== this.epoch || !["move", "click", "focus", "clear"].includes(sample.kind)
          || ![sample.x, sample.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return reply;
        if (sample.bounds && ![sample.bounds.x, sample.bounds.y, sample.bounds.width, sample.bounds.height].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return reply;
        this.pending = { frame: source.frame, sample: { kind: sample.kind, x: sample.x, y: sample.y, epoch: sample.epoch,
          ...(sample.bounds ? { bounds: { x: sample.bounds.x, y: sample.bounds.y, width: sample.bounds.width, height: sample.bounds.height } } : {}) }, epoch: this.epoch };
        this.flush();
        return reply;
      });
      if (exposed && typeof exposed.dispose === "function") this.bindingHandle = exposed;
      if (this.retired) { void this.bindingHandle?.dispose().catch(() => {}); this.bindingHandle = undefined; return; }
      const disposable = await this.page.addInitScript(observerScript(this.binding, this.state));
      // Older bundled Playwright versions return void and cannot remove init scripts.
      if (disposable && typeof disposable.dispose === "function") this.init = disposable;
      this.ready = true;
      if (this.retired) { void this.init?.dispose().catch(() => {}); this.init = undefined; }
      this.sync();
    })().catch(() => {});
  }

  invalidate(clear = false): void {
    this.epoch++; this.pending = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    if (clear && !this.retired && this.host.active()) {
      this.pending = { frame: this.page.mainFrame(), sample: { kind: "clear", x: 0, y: 0, epoch: this.epoch }, epoch: this.epoch };
      this.flush();
    }
    this.sync();
  }

  dispose(): void {
    this.retired = true;
    this.invalidate();
    void this.init?.dispose().catch(() => {}); this.init = undefined;
    void this.bindingHandle?.dispose().catch(() => {}); this.bindingHandle = undefined;
  }

  private sync(): void {
    if (!this.ready) return;
    this.syncAgain = true;
    if (this.syncing) return;
    this.syncing = true;
    void (async () => {
      do {
        this.syncAgain = false;
        for (const frame of this.page.frames()) {
          if (this.page.isClosed()) break;
          const script = this.retired ? `window[${JSON.stringify(this.state)}]?.stop()` : observerScript(this.binding, this.state);
          await frame.evaluate(script).catch(() => {});
        }
      } while (this.syncAgain);
    })().finally(() => { this.syncing = false; }).catch(() => {});
  }

  private flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.retired || !this.host.active() || this.busy || !this.pending) return;
    const delay = 100 - (Date.now() - this.lastAt);
    if (delay > 0) { this.timer = setTimeout(() => this.flush(), delay); this.timer.unref(); return; }
    const entry = this.pending; this.pending = undefined; this.busy = true;
    void (async () => {
      const current = (): boolean => !this.retired && this.host.active() && entry.epoch === this.epoch && this.page.frames().includes(entry.frame);
      const { sample, frame } = entry;
      let point: Point = sample.kind === "clear" ? { x: 0, y: 0 } : { x: sample.x, y: sample.y }, bounds = sample.kind === "clear" ? undefined : sample.bounds;
      if (sample.kind !== "clear" && frame !== this.page.mainFrame()) {
        const session = await this.host.session();
        if (!session || !current()) return;
        const size = await viewport(this.page, session);
        if (!current()) return;
        const element = await frame.frameElement();
        try {
          const box = await element.boundingBox();
          if (!box || !current()) return;
          const border = await element.evaluate((node: FrameElementMetrics) => ({ left: node.clientLeft, top: node.clientTop,
            width: node.clientWidth, height: node.clientHeight, outerWidth: node.offsetWidth, outerHeight: node.offsetHeight }));
          if (!current() || !border || ![border.left, border.top, border.width, border.height, border.outerWidth, border.outerHeight].every(Number.isFinite)
            || border.outerWidth <= 0 || border.outerHeight <= 0) return;
          // boundingBox is already in main-frame coordinates, including nested
          // offsets. Border ratios preserve axis-aligned CSS scaling as well.
          const scaleX = box.width / border.outerWidth, scaleY = box.height / border.outerHeight;
          const content = { x: box.x + border.left * scaleX, y: box.y + border.top * scaleY,
            width: border.width * scaleX, height: border.height * scaleY };
          point = { x: (content.x + sample.x * content.width) / size.width, y: (content.y + sample.y * content.height) / size.height };
          if (bounds) bounds = { x: (content.x + bounds.x * content.width) / size.width, y: (content.y + bounds.y * content.height) / size.height,
            width: bounds.width * content.width / size.width, height: bounds.height * content.height / size.height };
        } finally { await element.dispose().catch(() => {}); }
      }
      if (!current()) return;
      if (bounds) {
        const x = unit(bounds.x), y = unit(bounds.y);
        bounds = { x, y, width: Math.max(0, unit(bounds.x + bounds.width) - x), height: Math.max(0, unit(bounds.y + bounds.height) - y) };
      }
      this.lastAt = Date.now();
      this.host.send({ type: "pointer", kind: sample.kind, x: unit(point.x), y: unit(point.y), ...(bounds ? { bounds } : {}) });
    })().catch(() => {}).finally(() => { this.busy = false; this.flush(); });
  }
}

import type { BrowserViewerInput, BrowserViewerInputResult } from "../../src/browserViewerProtocol";

type Scope = { sessionId: string; pageId: string; controlId: string };
const MAX_PENDING = 32;
const transient = (input: BrowserViewerInput) => input.kind === "move" || input.kind === "wheel";
const clampWheel = (value: number) => Math.max(-2000, Math.min(2000, value));

export class ViewerInputQueue {
  private scope?: Scope;
  private pending: BrowserViewerInput[] = [];
  private flight?: { inputId: number; timeout: ReturnType<typeof setTimeout> };
  private nextId = 0;

  constructor(private send: (message: object) => void, private fail: (message: string) => void) {}

  activate(scope: Scope): void {
    this.clear();
    this.scope = scope;
  }

  clear(): void {
    if (this.flight) clearTimeout(this.flight.timeout);
    this.flight = undefined;
    this.pending = [];
    this.scope = undefined;
  }

  enqueue(...inputs: BrowserViewerInput[]): void {
    if (!this.scope || !inputs.length) return;
    const pending = [...this.pending];
    for (const input of inputs) {
      const last = pending.at(-1);
      // Never coalesce across a click, key, or text transaction.
      if (input.kind === "move" && last?.kind === "move") pending[pending.length - 1] = input;
      else if (input.kind === "wheel" && last?.kind === "wheel" && input.x === last.x && input.y === last.y) {
        pending[pending.length - 1] = { ...input, deltaX: clampWheel(last.deltaX + input.deltaX), deltaY: clampWheel(last.deltaY + input.deltaY) };
      } else if (input.kind === "text" && last?.kind === "text" && last.text.length + input.text.length <= 1024) {
        pending[pending.length - 1] = { kind: "text", text: last.text + input.text };
      } else pending.push(input);
    }
    while (pending.length > MAX_PENDING) {
      const disposable = pending.findIndex(transient);
      if (disposable === -1) {
        this.clear();
        this.fail("Очередь ввода переполнена. Управление отключено; проверьте страницу и включите его снова.");
        return;
      }
      pending.splice(disposable, 1);
    }
    this.pending = pending;
    this.pump();
  }

  result(result: BrowserViewerInputResult): void {
    const scope = this.scope;
    if (!scope || result.sessionId !== scope.sessionId || result.pageId !== scope.pageId || result.controlId !== scope.controlId || result.inputId !== this.flight?.inputId) return;
    clearTimeout(this.flight.timeout);
    this.flight = undefined;
    if (!result.ok) {
      this.clear();
      this.fail(result.message || "Ввод не выполнен. Управление отключено; проверьте страницу и включите его снова.");
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (!this.scope || this.flight || !this.pending.length) return;
    const input = this.pending.shift()!;
    const inputId = ++this.nextId;
    this.flight = { inputId, timeout: setTimeout(() => {
      this.clear();
      this.fail("Нет подтверждения ввода. Управление отключено; проверьте страницу и включите его снова.");
    }, 10_000) };
    try { this.send({ type: "viewer.input", ...this.scope, inputId, input }); }
    catch {
      this.clear();
      this.fail("Не удалось отправить ввод. Включите управление снова.");
    }
  }
}

export function textInputs(text: string): BrowserViewerInput[] | undefined {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return;
  const inputs: BrowserViewerInput[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1024, text.length);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    inputs.push({ kind: "text", text: text.slice(start, end) });
    if (inputs.length > MAX_PENDING) return;
    start = end;
  }
  return inputs;
}

export function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  // CDP bitmask. The remote browser runs on Windows/Linux, even for a Mac client.
  return (event.altKey ? 1 : 0) | (event.ctrlKey || event.metaKey ? 2 : 0) | (event.shiftKey ? 8 : 0);
}

export type ContentRect = { left: number; top: number; width: number; height: number };
export function contentRect(width: number, height: number, imageWidth: number, imageHeight: number): ContentRect {
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const drawnWidth = imageWidth * scale;
  return { left: (width - drawnWidth) / 2, top: 0, width: drawnWidth, height: imageHeight * scale };
}

export function pointInFrame(clientX: number, clientY: number, stage: DOMRect, frame: ContentRect): { x: number; y: number } | undefined {
  const x = (clientX - stage.left - frame.left) / frame.width;
  const y = (clientY - stage.top - frame.top) / frame.height;
  if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
}
